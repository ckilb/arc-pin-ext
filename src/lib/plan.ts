/**
 * Which tab belongs to which bookmark: the decision half of a sync, as a pure function.
 *
 * The rules that keep the pinned window free of duplicates live here:
 *  - a bookmark owns at most one tab, and a tab belongs to at most one bookmark;
 *  - before a tab is opened, an unbound pinned or managed-group tab on the bookmark's
 *    last URL or its bookmark URL is adopted instead;
 *  - leftover pinned or managed-group tabs that repeat a bound bookmark's page are closed.
 */

import { sameUrl } from './url.ts';
import type { Binding, Layout } from './types.ts';

export interface LiveTab {
  id: number;
  windowId: number;
  /** `pendingUrl || url`: a restored tab may still be loading. */
  url: string;
  pinned: boolean;
  groupId: number;
}

export interface PlanInput {
  layout: Layout;
  bindings: Readonly<Record<string, Binding>>;
  windowId: number;
  /** Every tab in every window. */
  tabs: readonly LiveTab[];
  /** Groups in the pinned window that the extension manages. */
  managedGroupIds: ReadonlySet<number>;
  /** Shortly after a restart: a tab restored late on its pre-restart page is a duplicate too. */
  withinRestoreGrace: boolean;
}

export interface Plan {
  bindings: Record<string, Binding>;
  /** Bound tabs that left the pinned window; they become ordinary tabs. */
  release: number[];
  /** Tabs of deleted bookmarks, and duplicates. */
  close: number[];
  /** Bookmarks that need a new tab, in layout order. */
  create: string[];
}

export function planBindings(input: PlanInput): Plan {
  const { layout, bindings, windowId, tabs, managedGroupIds, withinRestoreGrace } = input;
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const claimed = new Set<number>();
  const release: number[] = [];
  const next: Record<string, Binding> = {};

  // Keep every binding whose tab is still in the pinned window. A closed tab reopens on
  // its bookmark URL; a tab dragged to another window is released there.
  for (const spec of layout.pins) {
    const previous = bindings[spec.bookmarkId];
    let tabId = previous?.tabId ?? null;
    let lastUrl = previous?.lastUrl ?? spec.url;
    let restoreUrl = withinRestoreGrace ? previous?.restoreUrl : undefined;
    if (tabId !== null) {
      const tab = byId.get(tabId);
      if (tab && tab.windowId === windowId && !claimed.has(tabId)) {
        claimed.add(tabId);
      } else {
        if (tab && tab.windowId !== windowId) release.push(tabId);
        tabId = null;
        lastUrl = spec.url;
        restoreUrl = undefined;
      }
    }
    next[spec.bookmarkId] = {
      tabId,
      url: spec.url,
      title: spec.title,
      folderId: spec.folderId,
      lastUrl,
      ...(restoreUrl ? { restoreUrl } : {}),
    };
  }

  // Tabs of bookmarks that no longer exist: adopted below if another bookmark wants that
  // page, closed otherwise.
  const orphans = new Set<number>();
  for (const [bookmarkId, binding] of Object.entries(bindings)) {
    if (next[bookmarkId] || binding.tabId === null || claimed.has(binding.tabId)) continue;
    const tab = byId.get(binding.tabId);
    if (!tab) continue;
    if (tab.windowId === windowId) orphans.add(tab.id);
    else release.push(tab.id);
  }

  const candidates = tabs.filter(
    (tab) =>
      tab.windowId === windowId &&
      !claimed.has(tab.id) &&
      (tab.pinned || managedGroupIds.has(tab.groupId) || orphans.has(tab.id)),
  );
  const adopt = (bookmarkId: string, matches: (tab: LiveTab, binding: Binding) => boolean) => {
    const binding = next[bookmarkId];
    if (!binding || binding.tabId !== null) return;
    const tab = candidates.find((it) => !claimed.has(it.id) && matches(it, binding));
    if (!tab) return;
    claimed.add(tab.id);
    next[bookmarkId] = { ...binding, tabId: tab.id, lastUrl: tab.url };
  };
  // The page a tab was last on beats the bookmark URL, so a restored tab that had
  // navigated away is kept rather than a second copy opened on the bookmark.
  for (const spec of layout.pins) {
    adopt(
      spec.bookmarkId,
      (tab, binding) => sameUrl(tab.url, binding.lastUrl) || sameUrl(tab.url, binding.restoreUrl),
    );
  }
  for (const spec of layout.pins) {
    adopt(spec.bookmarkId, (tab, binding) => sameUrl(tab.url, binding.url));
  }

  const bound = Object.values(next).filter((binding) => binding.tabId !== null);
  const close: number[] = [];
  for (const tab of candidates) {
    if (claimed.has(tab.id)) continue;
    const duplicate = bound.some(
      (binding) =>
        sameUrl(tab.url, binding.url) ||
        sameUrl(tab.url, binding.lastUrl) ||
        sameUrl(tab.url, binding.restoreUrl),
    );
    if (orphans.has(tab.id) || duplicate) close.push(tab.id);
  }

  const create = layout.pins
    .filter((spec) => next[spec.bookmarkId]?.tabId === null)
    .map((spec) => spec.bookmarkId);

  return { bindings: next, release, close, create };
}

/** Pick the window that already holds most of the bookmarks' pages after a restart. */
export function pickRestoredWindow(input: {
  bindings: Readonly<Record<string, Binding>>;
  layout: Layout;
  tabs: readonly LiveTab[];
  isManagedGroup: (groupId: number) => boolean;
  windowIds: readonly number[];
}): number | null {
  const urls = [
    ...input.layout.pins.map((spec) => spec.url),
    ...Object.values(input.bindings).flatMap((binding) => [binding.lastUrl, binding.restoreUrl]),
  ];
  let best: number | null = null;
  let bestScore = 0;
  for (const windowId of input.windowIds) {
    const score = input.tabs.filter(
      (tab) =>
        tab.windowId === windowId &&
        (tab.pinned || input.isManagedGroup(tab.groupId)) &&
        urls.some((url) => sameUrl(tab.url, url)),
    ).length;
    if (score > bestScore) {
      best = windowId;
      bestScore = score;
    }
  }
  return best;
}
