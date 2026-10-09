/**
 * An in-memory browser behind the `chrome.*` APIs the worker uses, close enough to
 * Chrome's tab strip rules for the sync to be tested without a browser:
 *
 *  - native pinned tabs always lead the strip;
 *  - a group's tabs stay contiguous: a tab moved out of its group's span leaves it,
 *    one dropped between two tabs of a group joins it, an empty group disappears;
 *  - events are delivered asynchronously (on a zero timeout), as in Chrome.
 *
 * Tests drive it with fake timers and `flush()`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (...args: any[]) => unknown;

export class FakeEvent {
  listeners: Listener[] = [];
  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }
  removeListener(listener: Listener): void {
    this.listeners = this.listeners.filter((it) => it !== listener);
  }
  hasListener(listener: Listener): boolean {
    return this.listeners.includes(listener);
  }
  emit(...args: unknown[]): unknown[] {
    return [...this.listeners].map((listener) => listener(...args));
  }
}

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  pinned: boolean;
  groupId: number;
  active: boolean;
  history: string[];
  historyIndex: number;
  reloads: number;
}

interface FakeWindow {
  id: number;
  type: 'normal' | 'popup';
  incognito: boolean;
  tabIds: number[];
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}

export interface BookmarkNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  children?: BookmarkNode[];
}

export interface Navigation {
  transitionType?: string;
  transitionQualifiers?: string[];
}

const fail = (message: string) => Promise.reject(new Error(message));

function createStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get data() {
      return data;
    },
    async get(keys?: string | string[] | null) {
      const copy = structuredClone(data);
      if (keys === undefined || keys === null) return copy;
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((key) => key in copy).map((key) => [key, copy[key]]));
    },
    async set(items: Record<string, unknown>) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async clear() {
      data = {};
    },
    async setAccessLevel() {},
  };
}

export class FakeBrowser {
  tabs = new Map<number, FakeTab>();
  windows = new Map<number, FakeWindow>();
  groups = new Map<number, FakeGroup>();
  focusedWindowId: number | null = null;
  bookmarkRoot: BookmarkNode = {
    id: '0',
    title: '',
    children: [
      { id: '1', parentId: '0', title: 'Bookmarks bar', children: [] },
      { id: '2', parentId: '0', title: 'Other bookmarks', children: [] },
    ],
  };
  popups = new Map<number, string>();
  openedPopups: unknown[] = [];
  menus: Array<{ id: string; title: string }> = [];
  injected: number[] = [];
  /** Messages sent to content scripts. */
  messages: Array<{ tabId: number; message: any }> = [];
  /** Tabs whose content script is missing (sendMessage fails there). */
  noContentScript = new Set<number>();

  private nextTabId = 100;
  private nextWindowId = 1;
  private nextGroupId = 500;
  private nextBookmarkId = 10;

  readonly events = {
    tabs: {
      onCreated: new FakeEvent(),
      onUpdated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      onAttached: new FakeEvent(),
      onDetached: new FakeEvent(),
      onMoved: new FakeEvent(),
      onReplaced: new FakeEvent(),
      onActivated: new FakeEvent(),
    },
    windows: {
      onCreated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      onFocusChanged: new FakeEvent(),
    },
    bookmarks: {
      onCreated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      onChanged: new FakeEvent(),
      onMoved: new FakeEvent(),
      onChildrenReordered: new FakeEvent(),
      onImportEnded: new FakeEvent(),
    },
    runtime: {
      onInstalled: new FakeEvent(),
      onMessage: new FakeEvent(),
      onStartup: new FakeEvent(),
    },
    action: { onClicked: new FakeEvent() },
    contextMenus: { onClicked: new FakeEvent() },
    webNavigation: { onCommitted: new FakeEvent() },
  };

  readonly storage = { session: createStorageArea(), local: createStorageArea() };

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  /** Deliver an event the way Chrome does: after the current task. */
  private fire(event: FakeEvent, ...args: unknown[]): void {
    setTimeout(() => event.emit(...args), 0);
  }

  private window(windowId: number): FakeWindow {
    const window = this.windows.get(windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    return window;
  }

  private tab(tabId: number): FakeTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }

  indexOf(tab: FakeTab): number {
    return this.window(tab.windowId).tabIds.indexOf(tab.id);
  }

  snapshot(tab: FakeTab): chrome.tabs.Tab {
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: this.indexOf(tab),
      url: tab.url,
      title: tab.title,
      pinned: tab.pinned,
      groupId: tab.groupId,
      active: tab.active,
      highlighted: tab.active,
      incognito: false,
      selected: tab.active,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
    } as chrome.tabs.Tab;
  }

  private pinnedCount(window: FakeWindow, except?: number): number {
    return window.tabIds.filter((id) => id !== except && this.tab(id).pinned).length;
  }

  /** Put a tab into its window's strip at `index`, keeping pinned tabs first. */
  private insert(tab: FakeTab, index: number): void {
    const window = this.window(tab.windowId);
    window.tabIds = window.tabIds.filter((id) => id !== tab.id);
    const pinned = this.pinnedCount(window);
    const at = index < 0 ? window.tabIds.length : index;
    const clamped = tab.pinned
      ? Math.max(0, Math.min(at, pinned))
      : Math.max(pinned, Math.min(at, window.tabIds.length));
    window.tabIds.splice(clamped, 0, tab.id);
  }

  /** Group contiguity after a tab moved. */
  private settleGroup(tab: FakeTab): void {
    const before = tab.groupId;
    const ids = this.window(tab.windowId).tabIds;
    const at = ids.indexOf(tab.id);
    const left = at > 0 ? this.tabs.get(ids[at - 1] ?? -1) : undefined;
    const right = this.tabs.get(ids[at + 1] ?? -1);
    if (tab.pinned) tab.groupId = -1;
    if (tab.groupId !== -1) {
      const others = ids.some((id) => id !== tab.id && this.tab(id).groupId === tab.groupId);
      const touching = left?.groupId === tab.groupId || right?.groupId === tab.groupId;
      if (others && !touching) tab.groupId = -1;
    }
    if (
      tab.groupId === -1 &&
      !tab.pinned &&
      left &&
      right &&
      left.groupId !== -1 &&
      left.groupId === right.groupId
    ) {
      tab.groupId = left.groupId;
    }
    if (tab.groupId !== before) {
      this.fire(this.events.tabs.onUpdated, tab.id, { groupId: tab.groupId }, this.snapshot(tab));
    }
    this.dropEmptyGroups();
  }

  private dropEmptyGroups(): void {
    for (const group of [...this.groups.values()]) {
      if (![...this.tabs.values()].some((tab) => tab.groupId === group.id))
        this.groups.delete(group.id);
    }
  }

  private lastIndexOfGroup(groupId: number, windowId: number): number {
    const ids = this.window(windowId).tabIds;
    let last = -1;
    ids.forEach((id, index) => {
      if (this.tab(id).groupId === groupId) last = index;
    });
    return last;
  }

  private setActive(tab: FakeTab): void {
    for (const id of this.window(tab.windowId).tabIds) this.tab(id).active = id === tab.id;
  }

  private removeTab(tab: FakeTab, windowClosing: boolean): void {
    const window = this.window(tab.windowId);
    window.tabIds = window.tabIds.filter((id) => id !== tab.id);
    this.tabs.delete(tab.id);
    this.dropEmptyGroups();
    const closing = windowClosing || window.tabIds.length === 0;
    this.fire(this.events.tabs.onRemoved, tab.id, {
      windowId: window.id,
      isWindowClosing: closing,
    });
    if (tab.active && window.tabIds.length > 0) {
      const next = this.tab(window.tabIds[Math.max(0, window.tabIds.length - 1)] ?? -1);
      this.setActive(next);
    }
    if (window.tabIds.length === 0 && !windowClosing) this.removeWindow(window.id);
  }

  private removeWindow(windowId: number): void {
    const window = this.window(windowId);
    for (const id of [...window.tabIds]) this.removeTab(this.tab(id), true);
    this.windows.delete(windowId);
    if (this.focusedWindowId === windowId)
      this.focusedWindowId = [...this.windows.keys()].at(-1) ?? null;
    this.fire(this.events.windows.onRemoved, windowId);
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** A stopped service worker leaves no listeners behind. */
  resetListeners(): void {
    for (const area of Object.values(this.events)) {
      for (const event of Object.values(area)) (event as FakeEvent).listeners = [];
    }
  }

  /** A window as the browser would open or restore it; no events (restored before the worker). */
  seedWindow(
    tabs: Array<{ url: string; pinned?: boolean; group?: string; title?: string }> = [],
    { focused = true, type = 'normal' as 'normal' | 'popup' } = {},
  ): number {
    const window: FakeWindow = { id: this.nextWindowId++, type, incognito: false, tabIds: [] };
    this.windows.set(window.id, window);
    if (focused || this.focusedWindowId === null) this.focusedWindowId = window.id;
    const groupIds = new Map<string, number>();
    for (const spec of tabs.length > 0 ? tabs : [{ url: 'about:blank' }]) {
      const tab = this.addTab(window.id, spec.url, spec.pinned ?? false, spec.title);
      if (spec.group !== undefined) {
        let groupId = groupIds.get(spec.group);
        if (groupId === undefined) {
          groupId = this.nextGroupId++;
          groupIds.set(spec.group, groupId);
          this.groups.set(groupId, {
            id: groupId,
            windowId: window.id,
            title: spec.group,
            color: 'blue',
            collapsed: false,
          });
        }
        tab.groupId = groupId;
      }
    }
    const first = this.tabs.get(window.tabIds[0] ?? -1);
    if (first) first.active = true;
    return window.id;
  }

  private addTab(windowId: number, url: string, pinned: boolean, title?: string): FakeTab {
    const tab: FakeTab = {
      id: this.nextTabId++,
      windowId,
      url,
      title: title ?? url,
      pinned,
      groupId: -1,
      active: false,
      history: [url],
      historyIndex: 0,
      reloads: 0,
    };
    this.tabs.set(tab.id, tab);
    this.insert(tab, -1);
    return tab;
  }

  /** A navigation committed in a tab: what a click, a typed URL or a redirect produces. */
  navigate(tabId: number, url: string, how: Navigation = {}): void {
    const tab = this.tab(tabId);
    const backForward = how.transitionQualifiers?.includes('forward_back') === true;
    if (!backForward) {
      tab.history = [...tab.history.slice(0, tab.historyIndex + 1), url];
      tab.historyIndex = tab.history.length - 1;
    }
    tab.url = url;
    tab.title = url;
    this.commit(tab, how);
  }

  /** The events of a main-frame commit for the tab's current URL. */
  commit(tab: FakeTab, how: Navigation): void {
    const { url, id: tabId } = tab;
    this.fire(this.events.webNavigation.onCommitted, {
      tabId,
      frameId: 0,
      url,
      transitionType: how.transitionType ?? 'link',
      transitionQualifiers: how.transitionQualifiers ?? [],
      timeStamp: Date.now(),
      processId: 1,
      parentFrameId: -1,
      documentId: 'doc',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    this.fire(this.events.tabs.onUpdated, tabId, { url, status: 'loading' }, this.snapshot(tab));
  }

  /** Bookmarks the user (or bookmark sync) adds: fires onCreated like the real API. */
  bookmark(parentId: string, title: string, url?: string): string {
    const parent = this.findBookmark(parentId);
    if (!parent?.children) throw new Error(`no folder ${parentId}`);
    const node: BookmarkNode = {
      id: String(this.nextBookmarkId++),
      parentId,
      title,
      ...(url ? { url } : { children: [] }),
    };
    parent.children.push(node);
    this.fire(this.events.bookmarks.onCreated, node.id, structuredClone(node));
    return node.id;
  }

  findBookmark(id: string, node: BookmarkNode = this.bookmarkRoot): BookmarkNode | null {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
      const found = this.findBookmark(id, child);
      if (found) return found;
    }
    return null;
  }

  private parentOf(id: string, node: BookmarkNode = this.bookmarkRoot): BookmarkNode | null {
    for (const child of node.children ?? []) {
      if (child.id === id) return node;
      const found = this.parentOf(id, child);
      if (found) return found;
    }
    return null;
  }

  private indexed(node: BookmarkNode): BookmarkNode {
    const clone = structuredClone(node);
    const walk = (it: BookmarkNode) =>
      it.children?.forEach((child, index) => {
        child.index = index;
        walk(child);
      });
    walk(clone);
    return clone;
  }

  /** `pin:Mail`, `Work:Issues`, `about:blank`… for a window, in strip order. */
  strip(windowId: number, names: Record<string, string> = {}): string[] {
    return this.window(windowId).tabIds.map((id) => {
      const tab = this.tab(id);
      const name = names[tab.url] ?? tab.url;
      if (tab.pinned) return `pin:${name}`;
      if (tab.groupId !== -1)
        return `${(this.groups.get(tab.groupId)?.title ?? '?').replace('⁣', '')}:${name}`;
      return name;
    });
  }

  urlsIn(windowId: number): string[] {
    return this.window(windowId).tabIds.map((id) => this.tab(id).url);
  }

  closeTab(tabId: number): void {
    this.removeTab(this.tab(tabId), false);
  }

  closeWindow(windowId: number): void {
    this.removeWindow(windowId);
  }

  // -------------------------------------------------------------------------
  // chrome.*
  // -------------------------------------------------------------------------

  readonly chrome = this.createChrome();

  private createChrome(): typeof chrome {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const browser = this;
    const query = (info: chrome.tabs.QueryInfo = {}) =>
      [...browser.tabs.values()]
        .filter((tab) => info.windowId === undefined || tab.windowId === info.windowId)
        .filter((tab) => info.pinned === undefined || tab.pinned === info.pinned)
        .filter((tab) => info.groupId === undefined || tab.groupId === info.groupId)
        .filter((tab) => info.active === undefined || tab.active === info.active)
        .filter(
          (tab) =>
            (info.currentWindow === undefined && info.lastFocusedWindow === undefined) ||
            tab.windowId === browser.focusedWindowId,
        )
        .filter((tab) => {
          if (info.url === undefined) return true;
          const patterns = Array.isArray(info.url) ? info.url : [info.url];
          return patterns.some((pattern) => tab.url.startsWith(pattern.replace(/\*.*$/, '')));
        })
        .sort((a, b) => a.windowId - b.windowId || browser.indexOf(a) - browser.indexOf(b))
        .map((tab) => browser.snapshot(tab));

    const windowSnapshot = (window: FakeWindow) => ({
      id: window.id,
      type: window.type,
      incognito: window.incognito,
      focused: window.id === browser.focusedWindowId,
      alwaysOnTop: false,
      state: 'normal',
    });

    const tabs = {
      ...browser.events.tabs,
      async get(tabId: number) {
        const tab = browser.tabs.get(tabId);
        return tab ? browser.snapshot(tab) : fail(`No tab with id: ${tabId}.`);
      },
      async query(info: chrome.tabs.QueryInfo) {
        return query(info);
      },
      async create(props: chrome.tabs.CreateProperties) {
        const windowId = props.windowId ?? browser.focusedWindowId;
        if (windowId === null || !browser.windows.has(windowId)) return fail('No current window.');
        const tab = browser.addTab(
          windowId,
          props.url ?? 'chrome://newtab/',
          props.pinned ?? false,
        );
        if (props.index !== undefined) browser.insert(tab, props.index);
        browser.settleGroup(tab);
        if (props.active !== false) browser.setActive(tab);
        browser.fire(browser.events.tabs.onCreated, browser.snapshot(tab));
        if (/^https?:/.test(tab.url)) browser.commit(tab, { transitionType: 'link' });
        return browser.snapshot(tab);
      },
      async update(tabId: number, props: chrome.tabs.UpdateProperties) {
        const tab = browser.tabs.get(tabId);
        if (!tab) return fail(`No tab with id: ${tabId}.`);
        if (props.pinned !== undefined && props.pinned !== tab.pinned) {
          const window = browser.window(tab.windowId);
          const changeInfo: Record<string, unknown> = { pinned: props.pinned };
          tab.pinned = props.pinned;
          if (tab.pinned && tab.groupId !== -1) {
            tab.groupId = -1;
            changeInfo.groupId = -1;
          }
          browser.insert(tab, browser.pinnedCount(window, tab.id));
          browser.dropEmptyGroups();
          browser.fire(browser.events.tabs.onUpdated, tabId, changeInfo, browser.snapshot(tab));
        }
        if (props.active) browser.setActive(tab);
        if (props.url !== undefined) browser.navigate(tabId, props.url, { transitionType: 'link' });
        return browser.snapshot(tab);
      },
      async remove(ids: number | number[]) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = browser.tabs.get(id);
          if (!tab) return fail(`No tab with id: ${id}.`);
          browser.removeTab(tab, false);
        }
      },
      async move(ids: number | number[], props: chrome.tabs.MoveProperties) {
        const list = Array.isArray(ids) ? ids : [ids];
        let index = props.index;
        for (const id of list) {
          const tab = browser.tabs.get(id);
          if (!tab) return fail(`No tab with id: ${id}.`);
          const targetWindow = props.windowId ?? tab.windowId;
          if (targetWindow !== tab.windowId) {
            const from = browser.window(tab.windowId);
            from.tabIds = from.tabIds.filter((it) => it !== id);
            tab.groupId = -1;
            tab.active = false;
            browser.dropEmptyGroups();
            browser.fire(browser.events.tabs.onDetached, id, {
              oldWindowId: from.id,
              oldPosition: 0,
            });
            tab.windowId = targetWindow;
            browser.insert(tab, index);
            browser.fire(browser.events.tabs.onAttached, id, {
              newWindowId: targetWindow,
              newPosition: browser.indexOf(tab),
            });
            if (from.tabIds.length === 0) browser.removeWindow(from.id);
          } else {
            browser.insert(tab, index);
            browser.settleGroup(tab);
          }
          if (index >= 0) index = browser.indexOf(tab) + 1;
        }
        return list.length === 1
          ? browser.snapshot(browser.tab(list[0] ?? -1))
          : list.map((id) => browser.snapshot(browser.tab(id)));
      },
      async group(options: chrome.tabs.GroupOptions) {
        const ids = (Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]) as number[];
        const members = ids.map((id) => browser.tabs.get(id));
        if (members.some((tab) => !tab)) return fail('No tab with that id.');
        if (members.some((tab) => tab?.pinned)) return fail('Cannot group pinned tabs.');
        let groupId = options.groupId;
        if (groupId === undefined) {
          const first = members[0] as FakeTab;
          const windowId = options.createProperties?.windowId ?? first.windowId;
          groupId = browser.nextGroupId++;
          browser.groups.set(groupId, {
            id: groupId,
            windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          });
          if (first.groupId !== -1)
            browser.insert(first, browser.lastIndexOfGroup(first.groupId, first.windowId) + 1);
          first.groupId = groupId;
          browser.fire(
            browser.events.tabs.onUpdated,
            first.id,
            { groupId },
            browser.snapshot(first),
          );
        } else if (!browser.groups.has(groupId)) {
          return fail(`No group with id: ${groupId}.`);
        }
        for (const tab of members as FakeTab[]) {
          if (tab.groupId === groupId) continue;
          const target = browser.groups.get(groupId) as FakeGroup;
          if (tab.windowId !== target.windowId) return fail('Tabs must be in the same window.');
          const window = browser.window(tab.windowId);
          window.tabIds = window.tabIds.filter((it) => it !== tab.id);
          const after = browser.lastIndexOfGroup(groupId, tab.windowId);
          window.tabIds.splice(after + 1, 0, tab.id);
          tab.groupId = groupId;
          browser.fire(browser.events.tabs.onUpdated, tab.id, { groupId }, browser.snapshot(tab));
        }
        browser.dropEmptyGroups();
        return groupId;
      },
      async ungroup(ids: number | number[]) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = browser.tabs.get(id);
          if (!tab) return fail(`No tab with id: ${id}.`);
          if (tab.groupId === -1) continue;
          const groupId = tab.groupId;
          const window = browser.window(tab.windowId);
          window.tabIds = window.tabIds.filter((it) => it !== id);
          const after = browser.lastIndexOfGroup(groupId, tab.windowId);
          window.tabIds.splice(after + 1, 0, id);
          tab.groupId = -1;
          browser.dropEmptyGroups();
          browser.fire(browser.events.tabs.onUpdated, id, { groupId: -1 }, browser.snapshot(tab));
        }
      },
      async reload(tabId: number) {
        const tab = browser.tabs.get(tabId);
        if (!tab) return fail(`No tab with id: ${tabId}.`);
        tab.reloads += 1;
        browser.fire(browser.events.webNavigation.onCommitted, {
          tabId,
          frameId: 0,
          url: tab.url,
          transitionType: 'reload',
          transitionQualifiers: [],
        });
      },
      async goBack(tabId: number) {
        const tab = browser.tabs.get(tabId);
        if (!tab) return fail(`No tab with id: ${tabId}.`);
        if (tab.historyIndex === 0) return fail('Cannot find a next page in history.');
        tab.historyIndex -= 1;
        browser.navigate(tabId, tab.history[tab.historyIndex] ?? '', {
          transitionType: 'link',
          transitionQualifiers: ['forward_back'],
        });
      },
      async sendMessage(tabId: number, message: unknown) {
        const tab = browser.tabs.get(tabId);
        if (!tab || browser.noContentScript.has(tabId) || !/^https?:/.test(tab.url)) {
          return fail('Could not establish connection. Receiving end does not exist.');
        }
        browser.messages.push({ tabId, message });
        return undefined;
      },
    };

    const tabGroups = {
      async query(info: { windowId?: number } = {}) {
        return [...browser.groups.values()]
          .filter((group) => info.windowId === undefined || group.windowId === info.windowId)
          .map((group) => ({ ...group }));
      },
      async get(groupId: number) {
        const group = browser.groups.get(groupId);
        return group ? { ...group } : fail(`No group with id: ${groupId}.`);
      },
      async update(groupId: number, props: Partial<FakeGroup>) {
        const group = browser.groups.get(groupId);
        if (!group) return fail(`No group with id: ${groupId}.`);
        Object.assign(group, props);
        return { ...group };
      },
      async move(groupId: number, props: { index: number; windowId?: number }) {
        const group = browser.groups.get(groupId);
        if (!group) return fail(`No group with id: ${groupId}.`);
        const from = browser.window(group.windowId);
        const members = from.tabIds.filter((id) => browser.tab(id).groupId === groupId);
        from.tabIds = from.tabIds.filter((id) => !members.includes(id));
        const to = browser.window(props.windowId ?? group.windowId);
        const pinned = browser.pinnedCount(to);
        const at =
          props.index < 0
            ? to.tabIds.length
            : Math.max(pinned, Math.min(props.index, to.tabIds.length));
        to.tabIds.splice(at, 0, ...members);
        if (to !== from) {
          group.windowId = to.id;
          for (const id of members) {
            browser.tab(id).windowId = to.id;
            browser.tab(id).active = false;
            browser.fire(browser.events.tabs.onAttached, id, {
              newWindowId: to.id,
              newPosition: browser.indexOf(browser.tab(id)),
            });
          }
          if (from.tabIds.length === 0) browser.removeWindow(from.id);
        }
        return { ...group };
      },
    };

    const windows = {
      ...browser.events.windows,
      async getAll(info: { windowTypes?: string[] } = {}) {
        return [...browser.windows.values()]
          .filter((window) => !info.windowTypes || info.windowTypes.includes(window.type))
          .map(windowSnapshot);
      },
      async get(windowId: number) {
        const window = browser.windows.get(windowId);
        return window ? windowSnapshot(window) : fail(`No window with id: ${windowId}.`);
      },
      async getLastFocused() {
        const window = browser.windows.get(browser.focusedWindowId ?? -1);
        return window ? windowSnapshot(window) : fail('No last-focused window');
      },
      async create(props: { url?: string; focused?: boolean } = {}) {
        const id = browser.seedWindow([{ url: props.url ?? 'chrome://newtab/' }], {
          focused: props.focused !== false,
        });
        const window = browser.window(id);
        browser.fire(browser.events.windows.onCreated, windowSnapshot(window));
        for (const tabId of window.tabIds)
          browser.fire(browser.events.tabs.onCreated, browser.snapshot(browser.tab(tabId)));
        return windowSnapshot(window);
      },
      async update(windowId: number, props: { focused?: boolean }) {
        const window = browser.windows.get(windowId);
        if (!window) return fail(`No window with id: ${windowId}.`);
        if (props.focused) browser.focusedWindowId = windowId;
        return windowSnapshot(window);
      },
      async remove(windowId: number) {
        if (!browser.windows.has(windowId)) return fail(`No window with id: ${windowId}.`);
        browser.removeWindow(windowId);
      },
    };

    const bookmarks = {
      ...browser.events.bookmarks,
      async getTree() {
        return [browser.indexed(browser.bookmarkRoot)];
      },
      async getSubTree(id: string) {
        const node = browser.findBookmark(id);
        return node ? [browser.indexed(node)] : fail("Can't find bookmark for id.");
      },
      async create(props: { parentId?: string; title?: string; url?: string }) {
        const id = browser.bookmark(props.parentId ?? '2', props.title ?? '', props.url);
        return structuredClone(browser.findBookmark(id));
      },
      async update(id: string, props: { title?: string; url?: string }) {
        const node = browser.findBookmark(id);
        if (!node) return fail("Can't find bookmark for id.");
        if (props.title !== undefined) node.title = props.title;
        if (props.url !== undefined) node.url = props.url;
        browser.fire(browser.events.bookmarks.onChanged, id, { title: node.title, url: node.url });
        return structuredClone(node);
      },
      async move(id: string, props: { parentId?: string; index?: number }) {
        const node = browser.findBookmark(id);
        const oldParent = browser.parentOf(id);
        const parent = browser.findBookmark(props.parentId ?? oldParent?.id ?? '1');
        if (!node || !oldParent || !parent?.children) return fail("Can't find bookmark for id.");
        oldParent.children = (oldParent.children ?? []).filter((child) => child.id !== id);
        node.parentId = parent.id;
        parent.children.splice(props.index ?? parent.children.length, 0, node);
        browser.fire(browser.events.bookmarks.onMoved, id, {
          parentId: parent.id,
          oldParentId: oldParent.id,
        });
        return structuredClone(node);
      },
      async remove(id: string) {
        const node = browser.findBookmark(id);
        if (node?.children?.length) return fail("Can't remove non-empty folder.");
        return bookmarks.removeTree(id);
      },
      async removeTree(id: string) {
        const parent = browser.parentOf(id);
        if (!parent) return fail("Can't find bookmark for id.");
        parent.children = (parent.children ?? []).filter((child) => child.id !== id);
        browser.fire(browser.events.bookmarks.onRemoved, id, { parentId: parent.id });
      },
      async search(query: { url?: string }) {
        const found: BookmarkNode[] = [];
        const walk = (node: BookmarkNode) => {
          if (node.url !== undefined && node.url === query.url) found.push(structuredClone(node));
          node.children?.forEach(walk);
        };
        walk(browser.bookmarkRoot);
        return found;
      },
    };

    const fake = {
      tabs,
      tabGroups,
      windows,
      bookmarks,
      storage: browser.storage,
      action: {
        ...browser.events.action,
        async setPopup({ tabId, popup }: { tabId: number; popup: string }) {
          if (!browser.tabs.has(tabId)) return fail(`No tab with id: ${tabId}.`);
          browser.popups.set(tabId, popup);
        },
        async openPopup(options: unknown) {
          browser.openedPopups.push(options);
        },
      },
      contextMenus: {
        ...browser.events.contextMenus,
        async removeAll() {
          browser.menus = [];
        },
        create(item: { id: string; title: string }) {
          browser.menus.push(item);
        },
      },
      scripting: {
        async executeScript({ target }: { target: { tabId: number } }) {
          if (browser.noContentScript.has(target.tabId))
            return fail('Cannot access contents of the page.');
          browser.injected.push(target.tabId);
          return [];
        },
      },
      webNavigation: browser.events.webNavigation,
      runtime: {
        ...browser.events.runtime,
        id: 'fake-extension-id',
        /** An extension page messaging the worker. */
        sendMessage(message: unknown, sender: chrome.runtime.MessageSender = {}) {
          return new Promise((resolve) => {
            let answered = false;
            const respond = (value: unknown) => {
              answered = true;
              resolve(value);
            };
            const results = browser.events.runtime.onMessage.emit(message, sender, respond);
            if (!answered && !results.includes(true)) resolve(undefined);
          });
        },
      },
    };
    return fake as unknown as typeof chrome;
  }
}
