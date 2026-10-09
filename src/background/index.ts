/**
 * Tab Pin service worker. Listeners are registered synchronously at the top level, so
 * a worker woken by an event never misses it.
 */

import { findNode, folderOptions, isFolder, isManagedGroupTitle, pathOf } from '../lib/layout.ts';
import { isWebUrl, normalizeUrl, sameUrl } from '../lib/url.ts';
import type { PopupInfo, Reply, Request, SettingsInfo, TabView } from '../lib/types.ts';
import { forgetTab, goHome, onCommitted, openOrdinaryTab } from './navigation.ts';
import { bindingForTab, loadSettings, loadState, saveSettings, saveState } from './store.ts';
import {
  RESTORE_GRACE_MS,
  adoptWindowLocked,
  bootLocked,
  publish,
  requestSync,
  runtime,
  withLock,
} from './sync.ts';
import { NO_GROUP, getTab, ordinaryTabIndex, setActionPopup, viewFor } from './tabs.ts';

const MENU_SYNC = 'sync-now';
const MENU_ADOPT_WINDOW = 'make-pinned-window';
const BOOKMARK_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Install, boot
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({ id: MENU_SYNC, title: 'Sync now', contexts: ['action'] });
    chrome.contextMenus.create({
      id: MENU_ADOPT_WINDOW,
      title: 'Make this the pinned window',
      contexts: ['action'],
    });
  });
  if (details.reason === 'install' || details.reason === 'update') void injectContentScripts();
});

/**
 * Tabs that were open before an install or update have no (or an orphaned) content
 * script; give them a fresh one so titles and triple-click work without a reload.
 */
async function injectContentScripts(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
            .catch(() => {}),
    ),
  );
}

const boot = withLock(bootLocked);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void (async () => {
    await boot;
    if (await goHome(tabId, true)) return;
    // Not managed after all (the popup was cleared for a tab that has since been released).
    await setActionPopup(tabId, false);
    await chrome.action.openPopup({ windowId: tab.windowId }).catch(() => {});
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SYNC) void requestSync({ order: true });
  if (info.menuItemId === MENU_ADOPT_WINDOW && tab?.windowId !== undefined) {
    void makePinnedWindow(tab.windowId);
  }
});

function makePinnedWindow(windowId: number): Promise<void> {
  return withLock(() => adoptWindowLocked(windowId)).then(() => requestSync({ order: true }));
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => {
  runtime.lastTabCreatedAt = Date.now();
  const beforeBoot = !runtime.booted;
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void withLock(async () => {
    // Created while a restarted browser was still restoring its session.
    if (beforeBoot && runtime.restarted) return;
    await placeNewTab(tabId);
  });
});

/**
 * A new tab in the pinned window leaves any managed group it inherited from its opener
 * and goes after the managed area. Tabs the sync opens are bound before this runs, and
 * tabs restored by the session at startup are left where the browser put them.
 */
async function placeNewTab(tabId: number): Promise<void> {
  const state = await loadState();
  if (state.windowId === null || bindingForTab(state, tabId)) return;
  const tab = await getTab(tabId);
  if (!tab || tab.windowId !== state.windowId) return;

  const group =
    tab.groupId === NO_GROUP ? null : await chrome.tabGroups.get(tab.groupId).catch(() => null);
  const inManagedGroup =
    group !== null &&
    (isManagedGroupTitle(group.title) || Object.values(state.groups).includes(group.id));

  if (tab.pinned || inManagedGroup) {
    const url = tab.pendingUrl || tab.url;
    const copiesManaged = Object.values(state.bindings).some(
      (binding) =>
        sameUrl(url, binding.url) ||
        sameUrl(url, binding.lastUrl) ||
        sameUrl(url, binding.restoreUrl),
    );
    if (copiesManaged && Date.now() - state.bootAt < RESTORE_GRACE_MS) {
      // Probably restored late by the session: the sync adopts it or closes the copy.
      void requestSync();
      return;
    }
    // Your own new pins stay pinned; a duplicated managed tab becomes an ordinary copy.
    if (tab.pinned && !copiesManaged) return;
    if (tab.pinned) await chrome.tabs.update(tabId, { pinned: false });
    if (inManagedGroup) await chrome.tabs.ungroup(tabId).catch(() => {});
  }

  const fresh = await getTab(tabId);
  // A tab in one of your own groups stays with it.
  if (!fresh || fresh.groupId !== NO_GROUP || fresh.pinned) return;
  const settings = await loadSettings();
  const tabs = await chrome.tabs.query({ windowId: fresh.windowId });
  const index = ordinaryTabIndex(tabs, settings.newTabsAtStart, { id: tabId, index: fresh.index });
  if (fresh.index !== index) await chrome.tabs.move(tabId, { index }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url === undefined && info.pinned === undefined && info.groupId === undefined) return;
  void withLock(async () => {
    const state = await loadState();
    const entry = bindingForTab(state, tabId);
    if (!entry) return;
    const [, binding] = entry;
    if (info.url !== undefined) {
      if (!sameUrl(binding.lastUrl, info.url)) {
        binding.lastUrl = info.url;
        await saveState(state);
      }
      await setActionPopup(tabId, true);
    }
    // Unpinned or ungrouped by hand: put it back, without reordering anything.
    if (info.pinned !== undefined || info.groupId !== undefined) void requestSync();
  });
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  forgetTab(tabId);
  if (info.isWindowClosing) {
    runtime.closingWindows.add(info.windowId);
    return;
  }
  const syncing = runtime.syncing;
  void (async () => {
    // During a sync the bindings on disk may not show a tab it just opened yet.
    if (syncing || bindingForTab(await loadState(), tabId)) void requestSync({ order: true });
  })();
});

chrome.tabs.onAttached.addListener((tabId) => {
  void (async () => {
    // Dragged out of the pinned window (released, and reopened there), or moved in by
    // "Make this the pinned window".
    if (bindingForTab(await loadState(), tabId)) void requestSync({ order: true });
  })();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  forgetTab(removedTabId);
  void withLock(async () => {
    const state = await loadState();
    const entry = bindingForTab(state, removedTabId);
    if (!entry) return;
    entry[1].tabId = addedTabId;
    await saveState(state);
    await publish(state, await loadSettings());
  });
});

chrome.webNavigation.onCommitted.addListener((details) => {
  void onCommitted(details).catch((error: unknown) => console.warn('[Tab Pin]', error));
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

chrome.windows.onRemoved.addListener((windowId) => {
  runtime.closingWindows.delete(windowId);
  void (async () => {
    const state = await loadState();
    if (state.windowId !== windowId) return;
    runtime.windowLostAt = Date.now();
    void requestSync({ order: true });
  })();
});

chrome.windows.onCreated.addListener((window) => {
  // The stored window id can still refer to a closed window. Let the sync resolve it.
  if (window.type === 'normal' && !window.incognito) void requestSync();
});

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

let bookmarkTimer: ReturnType<typeof setTimeout> | null = null;

function bookmarksChanged(): void {
  if (bookmarkTimer !== null) clearTimeout(bookmarkTimer);
  bookmarkTimer = setTimeout(() => {
    bookmarkTimer = null;
    void requestSync({ order: true });
  }, BOOKMARK_DEBOUNCE_MS);
}

chrome.bookmarks.onCreated.addListener(bookmarksChanged);
chrome.bookmarks.onRemoved.addListener(bookmarksChanged);
chrome.bookmarks.onChanged.addListener(bookmarksChanged);
chrome.bookmarks.onMoved.addListener(bookmarksChanged);
chrome.bookmarks.onChildrenReordered.addListener(bookmarksChanged);
chrome.bookmarks.onImportEnded.addListener(bookmarksChanged);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function handle(message: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Pages opened during session restore need the finished bindings and folder selection.
  await boot;
  const senderTabId = sender.tab?.id;
  switch (message.type) {
    case 'hello': {
      const entry = bindingForTab(await loadState(), senderTabId);
      return viewFor(entry?.[1] ?? null, await loadSettings()) satisfies TabView;
    }
    case 'goHome':
      if (senderTabId !== undefined) await goHome(senderTabId, false);
      return { ok: true } satisfies Reply;
    case 'openSplit':
      if (sender.tab && isWebUrl(message.url)) {
        await openOrdinaryTab(sender.tab.windowId, message.url, true);
      }
      return { ok: true } satisfies Reply;
    case 'popupOpened':
      return popupInfo(message.tabId);
    case 'addPin':
      return addPin(message.tabId, message.title, message.parentId);
    case 'getSettings':
      return settingsInfo();
    case 'setSettings': {
      const rootChanged = await withLock(async () => {
        if (message.patch.rootId !== undefined) {
          const root = findNode(await chrome.bookmarks.getTree(), message.patch.rootId);
          if (!root || !isFolder(root)) throw new Error('Choose an existing bookmark folder.');
        }
        const before = await loadSettings();
        const settings = await saveSettings(message.patch);
        if (settings.rootId !== before.rootId) return true;
        await publish(await loadState(), settings);
        return false;
      });
      if (rootChanged) await requestSync({ order: true });
      return settingsInfo();
    }
    case 'syncNow':
      await requestSync({ order: true });
      return settingsInfo();
  }
}

chrome.runtime.onMessage.addListener((message: Request, sender, respond) => {
  if (!message || typeof message.type !== 'string') return undefined;
  handle(message, sender)
    .then(respond)
    .catch((error: unknown) =>
      respond({ ok: false, message: error instanceof Error ? error.message : String(error) }),
    );
  return true;
});

async function popupInfo(tabId: number): Promise<PopupInfo> {
  if (await goHome(tabId, true)) return { managed: true };
  const tab = await getTab(tabId);
  const settings = await loadSettings();
  const root = findNode(await chrome.bookmarks.getTree(), settings.rootId);
  const url = tab?.url || tab?.pendingUrl || '';
  return {
    managed: false,
    title: tab?.title ?? '',
    url,
    pinnable: isWebUrl(url),
    folders: root ? folderOptions(root) : [],
  };
}

async function settingsInfo(): Promise<SettingsInfo> {
  const settings = await loadSettings();
  const tree = await chrome.bookmarks.getTree();
  const state = await loadState();
  return {
    settings,
    folderPath: pathOf(tree, settings.rootId) ?? '',
    pinCount: Object.values(state.bindings).filter((binding) => binding.tabId !== null).length,
  };
}

/**
 * Bookmark the tab into the chosen folder. In the pinned window that very tab becomes
 * the managed one, so no second copy opens; elsewhere the pinned window opens its own.
 */
async function addPin(tabId: number, title: string, parentId: string): Promise<Reply> {
  const reply = await withLock(async (): Promise<Reply> => {
    const tab = await getTab(tabId);
    const url = normalizeUrl(tab?.url || tab?.pendingUrl);
    if (!tab || !url || !isWebUrl(url))
      return { ok: false, message: 'This page cannot be pinned.' };
    const settings = await loadSettings();
    const root = findNode(await chrome.bookmarks.getTree(), settings.rootId);
    const parent = root && findNode([root], parentId);
    if (!parent || !isFolder(parent)) {
      return { ok: false, message: 'Choose a folder inside the pin folder.' };
    }
    const bookmark = await chrome.bookmarks.create({ parentId, title: title.trim() || url, url });
    const state = await loadState();
    if (tab.windowId === state.windowId && !bindingForTab(state, tabId)) {
      state.bindings[bookmark.id] = {
        tabId,
        url,
        title: bookmark.title,
        folderId: null,
        lastUrl: url,
      };
      await saveState(state);
    }
    return { ok: true };
  });
  if (reply.ok) await requestSync({ order: true });
  return reply;
}

// Test hooks: Playwright can reach the worker, but not the toolbar button or its menu.
Object.assign(globalThis, {
  tabPinTest: {
    clickAction: (tabId: number) => goHome(tabId, true),
    makePinnedWindow,
    sync: () => requestSync({ order: true }),
  },
});
