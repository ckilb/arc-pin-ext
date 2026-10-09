/**
 * Navigation rules for managed tabs: return to the bookmark, and keep other sites out.
 *
 * Neither path takes the sync lock. Both only read the bindings, and a user who clicks
 * "return" must not wait behind a sync.
 */

import { sameSite } from '../lib/site.ts';
import { isWebUrl, sameUrl } from '../lib/url.ts';
import { bindingForTab, loadSettings, loadState } from './store.ts';
import { getTab, ordinaryTabIndex } from './tabs.ts';

/**
 * Put a managed tab back on its bookmark URL. On the bookmark already (hash included),
 * a toolbar click reloads it; a triple-click leaves it alone.
 * Returns false when the tab is not managed.
 */
export async function goHome(tabId: number, reloadIfHome: boolean): Promise<boolean> {
  const entry = bindingForTab(await loadState(), tabId);
  if (!entry) return false;
  const [, binding] = entry;
  const tab = await getTab(tabId);
  if (!tab) return false;
  if (sameUrl(tab.pendingUrl || tab.url, binding.url)) {
    if (reloadIfHome) await chrome.tabs.reload(tabId);
  } else {
    await chrome.tabs.update(tabId, { url: binding.url });
  }
  return true;
}

/** Open `url` as an ordinary tab, placed like any other new tab. */
export async function openOrdinaryTab(
  windowId: number,
  url: string,
  active: boolean,
): Promise<void> {
  const settings = await loadSettings();
  const tabs = await chrome.tabs.query({ windowId });
  await chrome.tabs.create({
    windowId,
    url,
    active,
    index: ordinaryTabIndex(tabs, settings.newTabsAtStart),
  });
}

/**
 * Whether a navigation from `fromUrl` to `toUrl` in a managed tab belongs in a new tab:
 * it leaves both the site of the page it came from and the bookmark's site. The first
 * condition keeps a tab that a redirect took to another site (gmail.com → mail.google.com)
 * working on that site.
 */
export function leavesSite(
  toUrl: string,
  fromUrl: string | undefined,
  bookmarkUrl: string,
): boolean {
  if (!isWebUrl(toUrl)) return false;
  if (sameSite(toUrl, bookmarkUrl)) return false;
  return fromUrl === undefined || !sameSite(toUrl, fromUrl);
}

// Transitions that never split: reloads, form posts (sign-in flows), the start page,
// and subframe navigations.
const KEEP_TRANSITIONS = new Set<string>([
  'reload',
  'form_submit',
  'start_page',
  'auto_subframe',
  'manual_subframe',
]);
const KEEP_QUALIFIERS = new Set<string>(['server_redirect', 'client_redirect', 'forward_back']);

/** The last main-frame URL committed in each tab, for "the page it came from". */
const committed = new Map<number, string>();
const splitting = new Set<number>();

export function forgetTab(tabId: number): void {
  committed.delete(tabId);
}

/**
 * Fallback for navigations the content script could not intercept before they
 * happened: typed URLs, scripted navigations, links whose click the page swallowed.
 * The other site's page has already loaded in the managed tab, so it opens again in a
 * new tab and the managed tab steps back to where it was.
 */
export async function onCommitted(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  if (details.frameId !== 0) return;
  const from = committed.get(details.tabId);
  committed.set(details.tabId, details.url);

  if (KEEP_TRANSITIONS.has(details.transitionType)) return;
  if (details.transitionQualifiers.some((qualifier) => KEEP_QUALIFIERS.has(qualifier))) return;
  if (splitting.has(details.tabId)) return;

  const entry = bindingForTab(await loadState(), details.tabId);
  if (!entry) return;
  const [, binding] = entry;
  // A woken worker has no memory of the previous page; the stored last URL stands in,
  // unless it already holds this navigation.
  const previous = from ?? (sameUrl(binding.lastUrl, details.url) ? undefined : binding.lastUrl);
  if (!leavesSite(details.url, previous, binding.url)) return;

  const tab = await getTab(details.tabId);
  if (!tab) return;
  splitting.add(details.tabId);
  try {
    await openOrdinaryTab(tab.windowId, details.url, tab.active);
    try {
      await chrome.tabs.goBack(details.tabId);
    } catch {
      await chrome.tabs.update(details.tabId, { url: binding.url });
    }
  } finally {
    setTimeout(() => splitting.delete(details.tabId), 1000);
  }
}
