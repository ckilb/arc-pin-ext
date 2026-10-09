import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SettingsInfo } from '../../src/lib/types.ts';
import { FakeBrowser, flush, send, sessionState, startWorker, tabOf } from '../fakes/harness.ts';

const MAIL = 'https://mail.example.com/';
const NEWS = 'https://news.example.com/';
const ISSUES = 'https://issues.example.com/';
const WIKI = 'https://wiki.example.com/';
const NAMES = { [MAIL]: 'Mail', [NEWS]: 'News', [ISSUES]: 'Issues', [WIKI]: 'Wiki' };
const LAYOUT = ['pin:Mail', 'pin:News', 'Work:Issues', 'Work:Wiki'];

let browser: FakeBrowser;
let ids: { mail: string; work: string; issues: string; wiki: string; news: string };

function bookmarks(): typeof ids {
  const mail = browser.bookmark('1', 'Mail', MAIL);
  const work = browser.bookmark('1', 'Work');
  const issues = browser.bookmark(work, 'Issues', ISSUES);
  const old = browser.bookmark(work, 'Old');
  const wiki = browser.bookmark(old, 'Wiki', WIKI);
  const news = browser.bookmark('1', 'News', NEWS);
  return { mail, work, issues, wiki, news };
}

const managed = (windowId: number) =>
  browser.strip(windowId, NAMES).filter((it) => it.includes(':') && !it.startsWith('about'));

beforeEach(() => {
  vi.useFakeTimers();
  browser = new FakeBrowser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('first install', () => {
  test('settings requested during boot describe the completed initial sync', async () => {
    browser.seedWindow([{ url: 'about:blank' }]);
    ids = bookmarks();
    vi.resetModules();
    (globalThis as { chrome?: typeof chrome }).chrome = browser.chrome;
    await import('../../src/background/index.ts');

    const info = await send<SettingsInfo>(browser, { type: 'getSettings' });
    expect(info.pinCount).toBe(4);
  });

  test('an invalid persisted pin folder falls back to the bookmarks bar', async () => {
    const win = browser.seedWindow([{ url: 'about:blank' }]);
    ids = bookmarks();
    browser.storage.local.data.settings = { rootId: ids.mail };
    await startWorker(browser, 'install');
    expect(managed(win)).toEqual(LAYOUT);
    expect(browser.storage.local.data.settings).toMatchObject({ rootId: '1' });
  });

  test('the bookmark folder becomes pins and groups in the focused window', async () => {
    const win = browser.seedWindow([{ url: 'about:blank' }, { url: 'https://own.example.com/' }]);
    ids = bookmarks();
    await startWorker(browser, 'install');

    expect(browser.strip(win, NAMES)).toEqual([
      ...LAYOUT,
      'about:blank',
      'https://own.example.com/',
    ]);
    expect([...browser.groups.values()].map((group) => group.title)).toEqual(['⁣Work']);
    expect(sessionState(browser).windowId).toBe(win);
  });

  test('managed tabs lose their popup and learn their bookmark; other tabs are untouched', async () => {
    const win = browser.seedWindow([{ url: 'https://own.example.com/' }]);
    ids = bookmarks();
    await startWorker(browser, 'install');

    const mailTab = tabOf(browser, ids.mail);
    expect(browser.popups.get(mailTab)).toBe('');
    expect(browser.messages).toContainEqual({
      tabId: mailTab,
      message: {
        type: 'view',
        view: {
          managed: true,
          bookmarkUrl: MAIL,
          bookmarkTitle: 'Mail',
          tripleClick: false,
          pageTitleInTitle: false,
        },
      },
    });
    const own = browser.urlsIn(win).indexOf('https://own.example.com/');
    expect(own).toBeGreaterThan(-1);
    expect(browser.menus.map((menu) => menu.id)).toEqual(['sync-now', 'make-pinned-window']);
    expect(browser.injected.length).toBeGreaterThan(0);
  });

  test('an existing pinned tab on a bookmark URL is adopted rather than duplicated', async () => {
    const win = browser.seedWindow([{ url: MAIL, pinned: true }, { url: 'about:blank' }]);
    const existing = browser.windows.get(win)?.tabIds[0];
    ids = bookmarks();
    await startWorker(browser, 'install');

    expect(tabOf(browser, ids.mail)).toBe(existing);
    expect(browser.urlsIn(win).filter((url) => url === MAIL)).toHaveLength(1);
  });

  test('without any window nothing happens until one opens', async () => {
    ids = bookmarks();
    await startWorker(browser, 'install');
    expect(browser.tabs.size).toBe(0);

    await browser.chrome.windows.create({ url: 'about:blank' });
    await flush();
    const win = sessionState(browser).windowId ?? -1;
    expect(managed(win)).toEqual(LAYOUT);
  });
});

describe('sync', () => {
  let win: number;

  beforeEach(async () => {
    win = browser.seedWindow([{ url: 'about:blank' }]);
    ids = bookmarks();
    await startWorker(browser, 'install');
  });

  test('repeated and concurrent syncs change nothing', async () => {
    const before = browser.strip(win, NAMES);
    const tabIds = [...browser.tabs.keys()];
    await Promise.all([
      send(browser, { type: 'syncNow' }),
      send(browser, { type: 'syncNow' }),
      (globalThis as unknown as { tabPinTest: { sync: () => Promise<void> } }).tabPinTest.sync(),
    ]);
    await flush();
    expect(browser.strip(win, NAMES)).toEqual(before);
    expect([...browser.tabs.keys()]).toEqual(tabIds);
  });

  test('a waking worker does not touch the strip', async () => {
    const tabIds = [...browser.tabs.keys()];
    await startWorker(browser);
    expect([...browser.tabs.keys()]).toEqual(tabIds);
    expect(managed(win)).toEqual(LAYOUT);
  });

  test('a closed pin reopens in its place, in the background', async () => {
    const news = tabOf(browser, ids.news);
    browser.closeTab(news);
    await flush();
    expect(managed(win)).toEqual(LAYOUT);
    const reopened = tabOf(browser, ids.news);
    expect(reopened).not.toBe(news);
    expect(browser.tabs.get(reopened)?.active).toBe(false);
  });

  test('a closed group tab that navigated away reopens on its bookmark URL', async () => {
    const issues = tabOf(browser, ids.issues);
    browser.navigate(issues, 'https://issues.example.com/42');
    await flush();
    browser.closeTab(issues);
    await flush();
    expect(browser.tabs.get(tabOf(browser, ids.issues))?.url).toBe(ISSUES);
    expect(managed(win)).toEqual(LAYOUT);
  });

  test('closing every managed tab at once reopens each exactly once', async () => {
    await browser.chrome.tabs.remove(
      Object.values(sessionState(browser).bindings).map((it) => it.tabId as number),
    );
    await flush();
    expect(managed(win)).toEqual(LAYOUT);
    expect(browser.urlsIn(win).filter((url) => url === MAIL)).toHaveLength(1);
  });

  test('an unpinned pin is pinned again, an ungrouped tab rejoins, without reordering', async () => {
    const news = tabOf(browser, ids.news);
    await browser.chrome.tabs.move(news, { index: 0 });
    await browser.chrome.tabs.update(tabOf(browser, ids.mail), { pinned: false });
    await browser.chrome.tabs.ungroup(tabOf(browser, ids.issues));
    await flush();
    expect(managed(win)).toEqual(['pin:News', 'pin:Mail', 'Work:Wiki', 'Work:Issues']);

    await send(browser, { type: 'syncNow' });
    expect(managed(win)).toEqual(LAYOUT);
  });

  test('a navigated pin keeps its page and records it', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, 'https://mail.example.com/thread/7');
    await flush();
    await send(browser, { type: 'syncNow' });
    expect(browser.tabs.get(mail)?.url).toBe('https://mail.example.com/thread/7');
    expect(sessionState(browser).bindings[ids.mail]?.lastUrl).toBe(
      'https://mail.example.com/thread/7',
    );
  });

  test('a replaced tab keeps the binding', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.events.tabs.onReplaced.emit(999, mail);
    await flush();
    expect(sessionState(browser).bindings[ids.mail]?.tabId).toBe(999);
  });

  test('a stray copy inside a managed group is closed', async () => {
    const workGroup = browser.tabs.get(tabOf(browser, ids.issues))?.groupId ?? -1;
    const stray = await browser.chrome.tabs.create({
      windowId: win,
      url: 'about:blank',
      active: false,
    });
    await browser.chrome.tabs.group({ groupId: workGroup, tabIds: stray.id as number });
    browser.navigate(stray.id as number, ISSUES);
    await send(browser, { type: 'syncNow' });
    expect(browser.urlsIn(win).filter((url) => url === ISSUES)).toHaveLength(1);
  });
});

describe('bookmark changes', () => {
  let win: number;

  beforeEach(async () => {
    win = browser.seedWindow([{ url: 'about:blank' }]);
    ids = bookmarks();
    await startWorker(browser, 'install');
  });

  test('a new bookmark opens a tab in bookmark order', async () => {
    browser.bookmark(ids.work, 'Docs', 'https://docs.example.com/');
    await flush();
    expect(managed(win)).toEqual([...LAYOUT, 'Work:https://docs.example.com/']);
  });

  test('a deleted bookmark closes its tab for good', async () => {
    const news = tabOf(browser, ids.news);
    await browser.chrome.bookmarks.remove(ids.news);
    await flush();
    expect(browser.tabs.has(news)).toBe(false);
    expect(managed(win)).toEqual(['pin:Mail', 'Work:Issues', 'Work:Wiki']);
  });

  test('a changed URL is the new target without navigating; a new title is pushed', async () => {
    const mail = tabOf(browser, ids.mail);
    await browser.chrome.bookmarks.update(ids.mail, {
      url: 'https://mail.example.com/u/1',
      title: 'Post',
    });
    await flush();
    expect(browser.tabs.get(mail)?.url).toBe(MAIL);
    expect(sessionState(browser).bindings[ids.mail]).toMatchObject({
      url: 'https://mail.example.com/u/1',
      title: 'Post',
    });
    expect(browser.messages.at(-1)?.message.view.bookmarkTitle ?? '').toBeTruthy();
  });

  test('a renamed folder renames its group', async () => {
    await browser.chrome.bookmarks.update(ids.work, { title: 'Job' });
    await flush();
    expect([...browser.groups.values()].map((group) => group.title)).toEqual(['⁣Job']);
  });

  test('moving folders and bookmarks reorders the strip', async () => {
    const misc = browser.bookmark('1', 'Misc');
    await flush();
    await browser.chrome.bookmarks.move(ids.news, { parentId: misc });
    await browser.chrome.bookmarks.move(misc, { parentId: '1', index: 0 });
    await flush();
    expect(managed(win)).toEqual(['pin:Mail', 'Misc:News', 'Work:Issues', 'Work:Wiki']);
  });

  test('a deleted folder empties its group; a folder of only bookmarklets has none', async () => {
    const issues = tabOf(browser, ids.issues);
    await browser.chrome.bookmarks.removeTree(ids.work);
    const scripts = browser.bookmark('1', 'Scripts');
    browser.bookmark(scripts, 'Run', 'javascript:void 0');
    await flush();
    expect(browser.tabs.has(issues)).toBe(false);
    expect(browser.groups.size).toBe(0);
    expect(managed(win)).toEqual(['pin:Mail', 'pin:News']);
  });

  test('switching folders swaps the pins; a deleted folder falls back to the bar', async () => {
    const alt = browser.bookmark('2', 'Alt');
    browser.bookmark(alt, 'Alt page', 'https://alt.example.com/');
    await flush();
    await send(browser, { type: 'setSettings', patch: { rootId: alt } });
    expect(managed(win)).toEqual(['pin:https://alt.example.com/']);

    await browser.chrome.bookmarks.removeTree(alt);
    await flush();
    expect(managed(win)).toEqual(LAYOUT);
    const info = await send<{ settings: { rootId: string }; folderPath: string }>(browser, {
      type: 'getSettings',
    });
    expect(info.settings.rootId).toBe('1');
    expect(info.folderPath).toBe('Bookmarks bar');
  });

  test('a stale managed group left from earlier is dissolved', async () => {
    const [own] = (await browser.chrome.tabs.query({
      windowId: win,
      pinned: false,
      groupId: -1,
    })) as chrome.tabs.Tab[];
    const groupId = await browser.chrome.tabs.group({ tabIds: own?.id as number });
    await browser.chrome.tabGroups.update(groupId, { title: '⁣Gone' });
    await send(browser, { type: 'syncNow' });
    expect(browser.tabs.get(own?.id as number)?.groupId).toBe(-1);
  });
});

describe('windows', () => {
  let win: number;
  let second: number;

  beforeEach(async () => {
    win = browser.seedWindow([{ url: 'about:blank' }]);
    second = browser.seedWindow([{ url: MAIL }], { focused: false });
    ids = bookmarks();
    await startWorker(browser, 'install');
  });

  test('only one window gets the pins', async () => {
    expect(managed(win)).toEqual(LAYOUT);
    expect(browser.strip(second, NAMES)).toEqual(['Mail']);
    await browser.chrome.windows.create({ url: 'about:blank' });
    await flush();
    expect(sessionState(browser).windowId).toBe(win);
  });

  test('a pin dragged to another window becomes ordinary there and reopens at home', async () => {
    const news = tabOf(browser, ids.news);
    await browser.chrome.tabs.move(news, { windowId: second, index: -1 });
    await flush();
    expect(browser.tabs.get(news)).toMatchObject({ windowId: second, pinned: false, groupId: -1 });
    expect(browser.popups.get(news)).toBe('popup/add.html');
    expect(managed(win)).toEqual(LAYOUT);
  });

  test('closing the pinned window hands the pins to the remaining window', async () => {
    browser.closeWindow(win);
    await vi.advanceTimersByTimeAsync(500);
    expect(sessionState(browser).windowId).toBe(win);
    await flush();
    expect(sessionState(browser).windowId).toBe(second);
    expect(managed(second)).toEqual(LAYOUT);
    // Your own tab on a bookmark URL stays an ordinary tab next to the pin.
    expect(browser.strip(second, NAMES).filter((it) => it.endsWith('Mail'))).toEqual([
      'pin:Mail',
      'Mail',
    ]);
  });

  test('quitting (every window closing) keeps the last pages for the next start', async () => {
    browser.navigate(tabOf(browser, ids.mail), 'https://mail.example.com/thread/7');
    await flush();
    browser.closeWindow(win);
    browser.closeWindow(second);
    await flush();
    expect(browser.tabs.size).toBe(0);
    const persisted = browser.storage.local.data.state as {
      bindings: Record<string, { lastUrl: string }>;
    };
    expect(persisted.bindings[ids.mail]?.lastUrl).toBe('https://mail.example.com/thread/7');
  });

  test('reopening a window after all windows close resumes syncing', async () => {
    browser.closeWindow(win);
    browser.closeWindow(second);
    await flush();

    const reopened = await browser.chrome.windows.create({ url: 'about:blank' });
    await flush();
    expect(sessionState(browser).windowId).toBe(reopened?.id);
    expect(managed(reopened!.id!)).toEqual(LAYOUT);
  });

  test('a renamed managed group moved to another window becomes ordinary there', async () => {
    const issues = tabOf(browser, ids.issues);
    const wiki = tabOf(browser, ids.wiki);
    const groupId = browser.tabs.get(issues)!.groupId;
    await browser.chrome.tabGroups.update(groupId, { title: 'My renamed group' });
    await browser.chrome.tabGroups.move(groupId, { windowId: second, index: -1 });
    await flush();

    expect(browser.tabs.get(issues)?.groupId).toBe(-1);
    expect(browser.tabs.get(wiki)?.groupId).toBe(-1);
    expect(managed(win)).toEqual(LAYOUT);
  });

  test('"Make this the pinned window" moves the same tabs there', async () => {
    const before = Object.values(sessionState(browser).bindings).map((it) => it.tabId);
    browser.events.contextMenus.onClicked.emit(
      { menuItemId: 'make-pinned-window' },
      browser.snapshot(browser.tabs.get(browser.windows.get(second)?.tabIds[0] ?? -1)!),
    );
    await flush();
    expect(sessionState(browser).windowId).toBe(second);
    expect(Object.values(sessionState(browser).bindings).map((it) => it.tabId)).toEqual(before);
    expect(managed(second)).toEqual(LAYOUT);
  });

  test('"Sync now" from the toolbar menu syncs', async () => {
    browser.closeTab(tabOf(browser, ids.mail));
    browser.events.contextMenus.onClicked.emit({ menuItemId: 'sync-now' }, undefined);
    await flush();
    expect(managed(win)).toEqual(LAYOUT);
  });
});

describe('restart', () => {
  function persist(
    bindings: Record<
      string,
      { url: string; title: string; folderId: string | null; lastUrl: string }
    >,
  ) {
    const state = {
      windowId: 77,
      groups: { stale: 999 },
      bootAt: 0,
      bindings: Object.fromEntries(
        Object.entries(bindings).map(([id, binding]) => [id, { ...binding, tabId: 4242 }]),
      ),
    };
    browser.storage.local.data.state = state;
  }

  test('restored tabs are adopted on the page they were left on, without copies', async () => {
    ids = bookmarks();
    persist({
      [ids.mail]: {
        url: MAIL,
        title: 'Mail',
        folderId: null,
        lastUrl: 'https://mail.example.com/thread/7',
      },
      [ids.issues]: { url: ISSUES, title: 'Issues', folderId: ids.work, lastUrl: ISSUES },
    });
    const other = browser.seedWindow([{ url: 'about:blank' }, { url: WIKI, group: '⁣Work' }]);
    const win = browser.seedWindow([
      { url: 'https://mail.example.com/thread/7', pinned: true },
      { url: ISSUES, group: '⁣Work' },
      { url: 'about:blank' },
    ]);
    browser.focusedWindowId = other;
    const restored = browser.windows.get(win)?.tabIds.slice(0, 2);

    await startWorker(browser);

    expect(sessionState(browser).windowId).toBe(win);
    expect([tabOf(browser, ids.mail), tabOf(browser, ids.issues)]).toEqual(restored);
    expect(browser.urlsIn(win).filter((url) => url === MAIL)).toHaveLength(0);
    expect(managed(win)).toEqual([
      'pin:https://mail.example.com/thread/7',
      'pin:News',
      'Work:Issues',
      'Work:Wiki',
    ]);
    // The managed group restored into the other window became ordinary tabs.
    expect(browser.tabs.get(browser.windows.get(other)?.tabIds[1] ?? -1)?.groupId).toBe(-1);
  });

  test('a pin restored late, after the extension opened its own, is closed as a copy', async () => {
    ids = bookmarks();
    persist({
      [ids.mail]: {
        url: MAIL,
        title: 'Mail',
        folderId: null,
        lastUrl: 'https://mail.example.com/thread/7',
      },
    });
    const win = browser.seedWindow([{ url: 'about:blank' }]);
    await startWorker(browser);
    expect(browser.tabs.get(tabOf(browser, ids.mail))?.url).toBe(MAIL);

    // Session restore delivers the old pin after the boot wait.
    const late = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://mail.example.com/thread/7',
      pinned: true,
    });
    await flush();
    expect(browser.tabs.has(late.id as number)).toBe(false);
    expect(browser.urlsIn(win).filter((url) => url.startsWith(MAIL))).toHaveLength(1);
  });

  test('tabs restored while the worker waits are left where the session put them', async () => {
    ids = bookmarks();
    const win = browser.seedWindow([{ url: 'about:blank' }]);
    vi.resetModules();
    browser.resetListeners();
    (globalThis as { chrome?: typeof chrome }).chrome = browser.chrome;
    await import('../../src/background/index.ts');
    // Restored during the boot wait: an ordinary tab somewhere in the middle.
    const restored = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://restored.example.com/',
      index: 0,
    });
    await flush();
    const order = browser.urlsIn(win);
    expect(order.indexOf('https://restored.example.com/')).toBe(order.indexOf('about:blank') - 1);
    expect(restored.id).toBeDefined();
  });
});
