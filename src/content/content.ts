/**
 * In-page part of a managed tab: the bookmark title, triple-click to return, and
 * opening links to other sites in a new tab before they load here.
 *
 * After an extension update this copy is orphaned (its runtime is gone) while a
 * freshly injected copy takes over; an orphan notices and removes itself.
 */

import { managedTitle } from '../lib/title.ts';
import { certainlyDifferentSite, isWebUrl, sameUrl } from '../lib/url.ts';
import type { Push, Request, TabView } from '../lib/types.ts';

declare global {
  interface Window {
    __tabPinContent?: boolean;
  }
}

(() => {
  if (window.top !== window || window.__tabPinContent) return;
  window.__tabPinContent = true;

  let view: TabView | null = null;
  let pageTitle = document.title;
  /** The title this script last wrote, to tell the page's own title changes from ours. */
  let applied: string | null = null;

  const alive = (): boolean => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  function send(message: Request): Promise<unknown> {
    if (!alive()) {
      teardown();
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  const atHome = () =>
    Boolean(view?.bookmarkUrl && sameUrl(window.location.href, view.bookmarkUrl));

  // --- title ---------------------------------------------------------------------

  const observer = new MutationObserver(refreshTitle);

  function observe(): void {
    observer.observe(document.documentElement, { childList: true });
    if (document.head) {
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
  }

  function refreshTitle(): void {
    if (!alive()) {
      teardown();
      return;
    }
    const current = document.title;
    if (applied === null || current !== applied) pageTitle = current;
    const next =
      view?.managed && view.bookmarkTitle
        ? managedTitle({
            bookmarkTitle: view.bookmarkTitle,
            atHome: atHome(),
            pageTitle,
            showPageTitle: view.pageTitleInTitle,
          })
        : pageTitle;
    observer.disconnect();
    if (current !== next) document.title = next;
    applied = view?.managed ? next : null;
    observe();
  }

  // --- clicks --------------------------------------------------------------------

  function onTripleClick(event: MouseEvent): void {
    if (event.detail !== 3 || !event.isTrusted) return;
    if (!view?.managed || !view.tripleClick || atHome()) return;
    void send({ type: 'goHome' });
  }

  /**
   * Runs last (bubble phase on window), so a page that handles the click itself has
   * already called preventDefault and is left alone. Only links that are certainly on
   * another site are taken over; the worker catches the rest after they commit.
   */
  function onLinkClick(event: MouseEvent): void {
    if (!view?.managed || !view.bookmarkUrl || event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const link = event
      .composedPath()
      .find(
        (node): node is HTMLAnchorElement | HTMLAreaElement =>
          node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement,
      );
    if (!link || link.hasAttribute('download')) return;
    const target = link.target.toLowerCase();
    if (target !== '' && target !== '_self' && target !== '_top' && target !== '_parent') return;
    const href = link.href;
    if (!isWebUrl(href)) return;
    if (!certainlyDifferentSite(href, window.location.href)) return;
    if (!certainlyDifferentSite(href, view.bookmarkUrl)) return;
    if (!alive()) return;
    event.preventDefault();
    void send({ type: 'openSplit', url: href });
  }

  // --- wiring --------------------------------------------------------------------

  function apply(next: TabView): void {
    view = next;
    refreshTitle();
  }

  function onMessage(message: Push): void {
    if (message?.type === 'view') apply(message.view);
  }

  const routeChanged = () => refreshTitle();

  function teardown(): void {
    observer.disconnect();
    window.removeEventListener('click', onTripleClick, true);
    window.removeEventListener('click', onLinkClick);
    window.removeEventListener('popstate', routeChanged);
    window.removeEventListener('hashchange', routeChanged);
    navigation?.removeEventListener('navigatesuccess', routeChanged);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* runtime already gone */
    }
    if (applied !== null && document.title === applied) document.title = pageTitle;
    applied = null;
    window.__tabPinContent = false;
  }

  const navigation = (window as Window & { navigation?: EventTarget }).navigation;

  window.addEventListener('click', onTripleClick, true);
  window.addEventListener('click', onLinkClick);
  window.addEventListener('popstate', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  navigation?.addEventListener('navigatesuccess', routeChanged);
  chrome.runtime.onMessage.addListener(onMessage);
  observe();

  void send({ type: 'hello' }).then((reply) => {
    if (reply && typeof reply === 'object' && 'managed' in reply) apply(reply as TabView);
  });
})();
