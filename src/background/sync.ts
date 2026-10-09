/**
 * The sync: make the pinned window match the bookmark folder.
 *
 * Everything that changes bindings runs through one lock, so two syncs (or a sync and
 * a binding update) never interleave. Sync requests made while one is waiting are
 * merged into it, so a burst of bookmark or tab events costs one sync, not twenty.
 */

import { buildLayout, findNode, groupTitle } from '../lib/layout.ts';
import { pickRestoredWindow, planBindings } from '../lib/plan.ts';
import type { Binding, Layout, Settings, State } from '../lib/types.ts';
import {
  emptyState,
  loadPersistedState,
  loadSessionState,
  loadSettings,
  loadState,
  saveSettings,
  saveState,
} from './store.ts';
import {
  NO_GROUP,
  delay,
  getTab,
  lastFocusedNormalWindow,
  liveTabs,
  managedGroupIds,
  nonEmpty,
  normalWindowIds,
  pushView,
  releaseTab,
  setActionPopup,
  viewFor,
} from './tabs.ts';

/** After a restart, pinned or managed-group tabs restored late are still recognised as duplicates. */
export const RESTORE_GRACE_MS = 60_000;
/** A closed pinned window hands over to another window only if the browser is not quitting. */
const WINDOW_HANDOVER_MS = 2_000;
/** Session restore is considered finished once no tab has been created for this long. */
const RESTORE_QUIET_MS = 1_000;
const RESTORE_MAX_WAIT_MS = 10_000;

export const runtime = {
  /** Windows whose tabs are being closed with the window. */
  closingWindows: new Set<number>(),
  windowLostAt: 0,
  lastTabCreatedAt: Date.now(),
  /** End of a restart boot; tabs created before it came from session restore. */
  restoreBootFinishedAt: 0,
  syncing: false,
};

// ---------------------------------------------------------------------------
// Lock and requests
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Run `task` after every task queued before it. Never await `withLock` inside a locked task. */
export function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.catch((error: unknown) => console.error('[Tab Pin]', error));
  return run;
}

interface SyncOptions {
  /** Restore bookmark order. Without it, only missing tabs and pin/group membership are fixed. */
  order: boolean;
}

let pending: { options: SyncOptions; run: Promise<void> } | null = null;

export function requestSync(options: Partial<SyncOptions> = {}): Promise<void> {
  if (pending) {
    pending.options.order ||= options.order === true;
    return pending.run;
  }
  const request: SyncOptions = { order: options.order === true };
  const run = withLock(async () => {
    pending = null;
    runtime.syncing = true;
    try {
      await syncLocked(request);
    } finally {
      runtime.syncing = false;
    }
  });
  pending = { options: request, run };
  return run;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * First task of every worker start. A worker wake finds its state in session storage
 * and does nothing. After a browser or extension restart the session is empty: wait for
 * the browser to finish restoring tabs, pick the window that holds most of them, and
 * sync, which adopts restored tabs instead of opening second copies.
 */
export async function bootLocked(): Promise<void> {
  if (await loadSessionState()) return;

  const started = Date.now();
  while (Date.now() - started < RESTORE_MAX_WAIT_MS) {
    const quiet = Date.now() - runtime.lastTabCreatedAt;
    if (quiet >= RESTORE_QUIET_MS) break;
    await delay(RESTORE_QUIET_MS - quiet);
  }

  const persisted = await loadPersistedState();
  const state: State = { ...emptyState(), bootAt: Date.now() };
  for (const [bookmarkId, { restoreUrl: _, ...binding }] of Object.entries(persisted.bindings)) {
    state.bindings[bookmarkId] = {
      ...binding,
      tabId: null,
      ...(binding.lastUrl !== binding.url ? { restoreUrl: binding.lastUrl } : {}),
    };
  }

  const tabs = await liveTabs();
  const marked = await managedGroupIds(undefined);
  const windowIds = await normalWindowIds();
  const layout = await currentLayout();
  state.windowId =
    (layout &&
      pickRestoredWindow({
        bindings: state.bindings,
        layout: layout.layout,
        tabs,
        isManagedGroup: (groupId) => marked.has(groupId),
        windowIds,
      })) ??
    (await lastFocusedNormalWindow()) ??
    windowIds[0] ??
    null;
  await saveState(state);

  // Managed groups restored into other windows become ordinary tabs there.
  for (const tab of tabs) {
    if (tab.windowId !== state.windowId && marked.has(tab.groupId)) await releaseTab(tab.id);
  }

  runtime.restoreBootFinishedAt = Date.now();
  await syncLocked({ order: true });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function currentLayout(): Promise<{ layout: Layout; settings: Settings } | null> {
  let settings = await loadSettings();
  const tree = await chrome.bookmarks.getTree();
  let root = findNode(tree, settings.rootId);
  if (!root && settings.rootId !== '1') {
    // The folder was deleted (or has not arrived from bookmark sync yet).
    settings = await saveSettings({ rootId: '1' });
    root = findNode(tree, '1');
  }
  return root ? { layout: buildLayout(root), settings } : null;
}

/** The pinned window, choosing a new one if it was closed. Null: none (yet). */
async function resolvePinnedWindow(state: State): Promise<number | null> {
  const windowIds = (await normalWindowIds()).filter((id) => !runtime.closingWindows.has(id));
  if (state.windowId !== null && windowIds.includes(state.windowId)) return state.windowId;

  const waited = Date.now() - runtime.windowLostAt;
  if (waited < WINDOW_HANDOVER_MS) {
    // Quitting closes every window within moments; only hand over if others stay open.
    setTimeout(() => void requestSync({ order: true }), WINDOW_HANDOVER_MS - waited + 100);
    return null;
  }
  const focused = await lastFocusedNormalWindow();
  const next = windowIds.find((id) => id === focused) ?? windowIds[0] ?? null;
  if (next !== null) state.groups = {};
  return next;
}

async function syncLocked(options: SyncOptions): Promise<void> {
  const current = await currentLayout();
  if (!current) return;
  const { layout, settings } = current;
  const state = await loadState();
  const previousTabIds = boundTabIds(state.bindings);

  const windowId = await resolvePinnedWindow(state);
  if (windowId === null) return;
  state.windowId = windowId;

  const plan = planBindings({
    layout,
    bindings: state.bindings,
    windowId,
    tabs: await liveTabs(),
    managedGroupIds: await managedGroupIds(windowId, Object.values(state.groups)),
    withinRestoreGrace: Date.now() - state.bootAt < RESTORE_GRACE_MS,
  });
  state.bindings = plan.bindings;
  // Saved before anything is closed: a tab closed here must not look like a pin to reopen.
  await saveState(state);

  for (const tabId of plan.release) await releaseTab(tabId);
  for (const tabId of plan.close) await chrome.tabs.remove(tabId).catch(() => {});

  for (const bookmarkId of plan.create) {
    const binding = state.bindings[bookmarkId];
    if (!binding) continue;
    const tab = await chrome.tabs
      .create({ windowId, url: binding.url, pinned: binding.folderId === null, active: false })
      .catch(() => null);
    if (tab?.id === undefined) continue;
    state.bindings[bookmarkId] = { ...binding, tabId: tab.id, lastUrl: binding.url };
    // Bound at once, so nothing that runs next can mistake it for a stray copy.
    await saveState(state);
  }

  await applyMembership(state, layout, windowId);
  if (options.order || plan.create.length > 0) await applyOrder(state, layout, windowId);
  await saveState(state);
  await publish(state, settings, previousTabIds);
}

function boundTabIds(bindings: Record<string, Binding>): Set<number> {
  return new Set(
    Object.values(bindings).flatMap((binding) => (binding.tabId === null ? [] : [binding.tabId])),
  );
}

function tabIdsOf(state: State, layout: Layout, folderId: string | null): number[] {
  return layout.pins
    .filter((spec) => spec.folderId === folderId)
    .flatMap((spec) => {
      const tabId = state.bindings[spec.bookmarkId]?.tabId;
      return typeof tabId === 'number' ? [tabId] : [];
    });
}

/** Loose bookmarks are native pins; folder bookmarks sit in their folder's group. */
async function applyMembership(state: State, layout: Layout, windowId: number): Promise<void> {
  const tabs = new Map(
    (await chrome.tabs.query({ windowId })).flatMap((tab) =>
      tab.id === undefined ? [] : [[tab.id, tab] as const],
    ),
  );

  for (const tabId of tabIdsOf(state, layout, null)) {
    const tab = tabs.get(tabId);
    if (!tab) continue;
    if (tab.groupId !== NO_GROUP) await chrome.tabs.ungroup(tabId).catch(() => {});
    if (!tab.pinned) await chrome.tabs.update(tabId, { pinned: true }).catch(() => {});
  }

  const groups = await chrome.tabGroups.query({ windowId });
  const used = new Set<number>();
  const nextGroups: Record<string, number> = {};
  for (const folder of layout.folders) {
    const tabIds = tabIdsOf(state, layout, folder.folderId).filter((id) => tabs.has(id));
    if (tabIds.length === 0) continue;
    for (const tabId of tabIds) {
      if (tabs.get(tabId)?.pinned)
        await chrome.tabs.update(tabId, { pinned: false }).catch(() => {});
    }
    const title = groupTitle(folder.title);
    const known = state.groups[folder.folderId];
    const group =
      groups.find((it) => it.id === known && !used.has(it.id)) ??
      groups.find((it) => it.title === title && !used.has(it.id));
    let groupId: number;
    try {
      if (group) {
        groupId = group.id;
        const outside = nonEmpty(tabIds.filter((id) => tabs.get(id)?.groupId !== groupId));
        if (outside) await chrome.tabs.group({ groupId, tabIds: outside });
        if (group.title !== title || group.color !== folder.color) {
          await chrome.tabGroups.update(groupId, { title, color: folder.color });
        }
      } else {
        const all = nonEmpty(tabIds);
        if (!all) continue;
        groupId = await chrome.tabs.group({ tabIds: all, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title, color: folder.color });
      }
    } catch (error) {
      console.warn('[Tab Pin] could not group', folder.title, error);
      continue;
    }
    used.add(groupId);
    nextGroups[folder.folderId] = groupId;
  }

  // Managed groups whose folder is gone: whatever is left in them becomes ordinary.
  const stale = new Set(
    [...(await managedGroupIds(windowId, Object.values(state.groups)))].filter(
      (id) => !used.has(id),
    ),
  );
  state.groups = nextGroups;
  if (stale.size > 0) {
    const leftovers = (await chrome.tabs.query({ windowId })).flatMap((tab) =>
      tab.id !== undefined && stale.has(tab.groupId) ? [tab.id] : [],
    );
    const ids = nonEmpty(leftovers);
    if (ids) await chrome.tabs.ungroup(ids).catch(() => {});
  }
}

/**
 * Bookmark order: your own native pins, then the managed pins, then the managed groups
 * in folder order, each holding its bookmarks first. Groups are moved as whole blocks to
 * group boundaries, and tabs only move within their own group's span, because Chrome
 * drops a tab out of its group when it is moved outside it.
 */
async function applyOrder(state: State, layout: Layout, windowId: number): Promise<void> {
  const pinIds = tabIdsOf(state, layout, null);
  const pinned = await chrome.tabs.query({ windowId, pinned: true });
  let target = pinned.filter((tab) => tab.id === undefined || !pinIds.includes(tab.id)).length;
  for (const tabId of pinIds) {
    const tab = await getTab(tabId);
    if (!tab?.pinned || tab.windowId !== windowId) continue;
    if (tab.index !== target) await chrome.tabs.move(tabId, { index: target }).catch(() => {});
    target += 1;
  }

  let cursor = (await chrome.tabs.query({ windowId, pinned: true })).length;
  for (const folder of layout.folders) {
    const groupId = state.groups[folder.folderId];
    if (groupId === undefined) continue;
    const members = await chrome.tabs.query({ windowId, groupId });
    if (members.length === 0) continue;
    const head = Math.min(...members.map((tab) => tab.index));
    if (head !== cursor) await chrome.tabGroups.move(groupId, { index: cursor }).catch(() => {});
    let slot = cursor;
    for (const tabId of tabIdsOf(state, layout, folder.folderId)) {
      const tab = await getTab(tabId);
      if (tab?.groupId !== groupId) continue;
      if (tab.index !== slot) await chrome.tabs.move(tabId, { index: slot }).catch(() => {});
      slot += 1;
    }
    cursor += members.length;
  }
}

/** Tell tabs whether they are managed: their toolbar popup and their page's title. */
export async function publish(
  state: State,
  settings: Settings,
  previousTabIds: ReadonlySet<number> = new Set(),
): Promise<void> {
  const bound = new Map<number, Binding>();
  for (const binding of Object.values(state.bindings)) {
    if (binding.tabId !== null) bound.set(binding.tabId, binding);
  }
  const work: Promise<void>[] = [];
  for (const [tabId, binding] of bound) {
    work.push(setActionPopup(tabId, true), pushView(tabId, viewFor(binding, settings)));
  }
  for (const tabId of previousTabIds) {
    if (bound.has(tabId)) continue;
    work.push(setActionPopup(tabId, false), pushView(tabId, viewFor(null, settings)));
  }
  await Promise.all(work);
}

/** Make `windowId` the pinned window, moving the live managed tabs there without reloading. */
export async function adoptWindowLocked(windowId: number): Promise<void> {
  const window = await chrome.windows.get(windowId).catch(() => null);
  if (!window || window.type !== 'normal' || window.incognito) return;
  const state = await loadState();
  const previous = state.windowId;
  if (previous === windowId) return;
  state.windowId = windowId;
  await saveState(state);
  if (previous === null) return;

  for (const groupId of Object.values(state.groups)) {
    await chrome.tabGroups.move(groupId, { windowId, index: -1 }).catch(() => {});
  }
  const pins: number[] = [];
  for (const binding of Object.values(state.bindings)) {
    if (binding.tabId === null || binding.folderId !== null) continue;
    const tab = await getTab(binding.tabId);
    if (tab?.windowId === previous) pins.push(binding.tabId);
  }
  const ids = nonEmpty(pins);
  if (ids) await chrome.tabs.move(ids, { windowId, index: 0 }).catch(() => {});
}
