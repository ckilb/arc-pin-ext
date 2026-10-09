/**
 * Small wrappers over chrome.tabs / chrome.tabGroups shared by the worker modules.
 */

import { isManagedGroupTitle } from '../lib/layout.ts';
import type { LiveTab } from '../lib/plan.ts';
import type { Binding, Settings, TabView } from '../lib/types.ts';

export const NO_GROUP = -1;
export const ADD_POPUP = 'popup/add.html';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export function toLiveTab(tab: chrome.tabs.Tab): LiveTab | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.pendingUrl || tab.url || '',
    pinned: tab.pinned,
    groupId: tab.groupId,
  };
}

export async function liveTabs(query: chrome.tabs.QueryInfo = {}): Promise<LiveTab[]> {
  const tabs = await chrome.tabs.query(query);
  return tabs.flatMap((tab) => toLiveTab(tab) ?? []);
}

export async function normalWindowIds(): Promise<number[]> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return windows.flatMap((window) =>
    window.id !== undefined && !window.incognito ? [window.id] : [],
  );
}

export async function lastFocusedNormalWindow(): Promise<number | null> {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return window.id !== undefined && !window.incognito ? window.id : null;
  } catch {
    return null;
  }
}

/** Groups the extension manages: marked titles, plus the ids it recorded this session. */
export async function managedGroupIds(
  windowId: number | undefined,
  known: Iterable<number> = [],
): Promise<Set<number>> {
  const groups = await chrome.tabGroups.query(windowId === undefined ? {} : { windowId });
  const ids = new Set(known);
  const live = new Set(groups.map((group) => group.id));
  for (const id of ids) if (!live.has(id)) ids.delete(id);
  for (const group of groups) if (isManagedGroupTitle(group.title)) ids.add(group.id);
  return ids;
}

/** Turn a tab back into an ordinary one: no native pin, no managed group. */
export async function releaseTab(
  tabId: number,
  knownGroupIds: readonly number[] = [],
): Promise<void> {
  const tab = await getTab(tabId);
  if (!tab) return;
  if (tab.groupId !== NO_GROUP) {
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (knownGroupIds.includes(tab.groupId) || isManagedGroupTitle(group?.title)) {
      await chrome.tabs.ungroup(tabId).catch(() => {});
    }
  }
  if (tab.pinned) await chrome.tabs.update(tabId, { pinned: false }).catch(() => {});
}

export function viewFor(binding: Binding | null, settings: Settings): TabView {
  return {
    managed: binding !== null,
    bookmarkUrl: binding?.url ?? null,
    bookmarkTitle: binding?.title ?? null,
    tripleClick: settings.tripleClick,
    pageTitleInTitle: settings.pageTitleInTitle,
  };
}

/** Best effort: tabs without the content script (PDFs, error pages) simply miss it. */
export async function pushView(tabId: number, view: TabView): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'view', view });
  } catch {
    /* no content script in this tab */
  }
}

/**
 * Managed tabs have no popup, so a toolbar click reaches `action.onClicked` and returns
 * the tab to its bookmark. Every other tab opens the "Add pin" dialog.
 */
export async function setActionPopup(tabId: number, managed: boolean): Promise<void> {
  await chrome.action.setPopup({ tabId, popup: managed ? '' : ADD_POPUP }).catch(() => {});
}

/**
 * Where an ordinary tab belongs: right after the last pinned or grouped tab when
 * `atStart` is set, otherwise at the end. `tab` is the tab being placed, when it
 * already exists in `tabs`; the result is a `tabs.move`/`tabs.create` index.
 */
export function ordinaryTabIndex(
  tabs: readonly chrome.tabs.Tab[],
  atStart: boolean,
  tab?: { id: number; index: number },
): number {
  const others = tabs.filter((it) => it.id !== tab?.id);
  if (!atStart) return others.length;
  const boundary =
    Math.max(
      -1,
      ...others.filter((it) => it.pinned || it.groupId !== NO_GROUP).map((it) => it.index),
    ) + 1;
  // Indexes after the tab shift left once it is lifted out of the strip.
  return tab && tab.index < boundary ? boundary - 1 : boundary;
}

export function nonEmpty(ids: number[]): [number, ...number[]] | null {
  const [first, ...rest] = ids;
  return first === undefined ? null : [first, ...rest];
}
