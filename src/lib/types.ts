export type GroupColor = chrome.tabGroups.TabGroup['color'];

export interface Settings {
  /** The bookmark folder the pins come from; `1` is the bookmarks bar. */
  rootId: string;
  /** Triple-clicking a page that has left its bookmark URL returns it there. */
  tripleClick: boolean;
  /** Append the page title to `/ Name` when a tab has left its bookmark URL. */
  pageTitleInTitle: boolean;
  /** New ordinary tabs open right after the last tab group instead of at the end. */
  newTabsAtStart: boolean;
}

/** One bookmark from the chosen folder, in strip order. */
export interface PinSpec {
  bookmarkId: string;
  url: string;
  title: string;
  /** The top-level subfolder it belongs to; null for a loose bookmark (native pin). */
  folderId: string | null;
}

export interface FolderSpec {
  folderId: string;
  title: string;
  color: GroupColor;
}

export interface Layout {
  /** Loose bookmarks first, then every folder's bookmarks in folder order. */
  pins: PinSpec[];
  /** Folders that hold at least one web bookmark, in bookmark order. */
  folders: FolderSpec[];
}

/** The tab a bookmark is bound to. */
export interface Binding {
  /** null while the bookmark has no tab: it was closed, or the browser restarted. */
  tabId: number | null;
  /** The bookmark URL: where "return" and reopen go. */
  url: string;
  title: string;
  folderId: string | null;
  /** The page the tab was last on; a restored tab comes back here after a restart. */
  lastUrl: string;
  /** `lastUrl` before the browser restarted, to recognise a late session restore. */
  restoreUrl?: string;
}

export interface State {
  /** The one window that holds the managed tabs. */
  windowId: number | null;
  /** Keyed by bookmark id, so one bookmark can never own two tabs. */
  bindings: Record<string, Binding>;
  /** Live tab group per folder id. Group ids do not survive a restart. */
  groups: Record<string, number>;
  /** When the browser (or the extension) started; restore-race duplicates are closed until a while after. */
  bootAt: number;
}

/** What the content script needs to title a page and handle clicks. */
export interface TabView {
  managed: boolean;
  bookmarkUrl: string | null;
  bookmarkTitle: string | null;
  tripleClick: boolean;
  pageTitleInTitle: boolean;
}

export interface FolderOption {
  id: string;
  title: string;
  depth: number;
}

export type Request =
  | { type: 'hello' }
  | { type: 'goHome' }
  | { type: 'openSplit'; url: string }
  | { type: 'popupOpened'; tabId: number }
  | { type: 'addPin'; tabId: number; title: string; parentId: string }
  | { type: 'getSettings' }
  | { type: 'setSettings'; patch: Partial<Settings> }
  | { type: 'syncNow' };

export type PopupInfo =
  | { managed: true }
  | {
      managed: false;
      title: string;
      url: string;
      pinnable: boolean;
      folders: FolderOption[];
    };

export interface SettingsInfo {
  settings: Settings;
  folderPath: string;
  pinCount: number;
}

export interface Reply {
  ok: boolean;
  message?: string;
}

/** Worker → content script. */
export type Push = { type: 'view'; view: TabView };
