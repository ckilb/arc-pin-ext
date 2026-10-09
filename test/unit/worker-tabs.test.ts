import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PopupInfo, Reply, SettingsInfo, TabView } from '../../src/lib/types.ts';
import {
  FakeBrowser,
  flush,
  send,
  senderTab,
  sessionState,
  startWorker,
  tabOf,
} from '../fakes/harness.ts';

const MAIL = 'https://mail.example.com/';
const ISSUES = 'https://issues.example.com/';
const WIKI = 'https://wiki.example.com/';
const OTHER = 'https://other.test/page';

let browser: FakeBrowser;
let win: number;
let ids: { mail: string; work: string; issues: string; wiki: string };

beforeEach(async () => {
  vi.useFakeTimers();
  browser = new FakeBrowser();
  win = browser.seedWindow([{ url: 'about:blank' }, { url: 'https://own.example.com/' }]);
  const mail = browser.bookmark('1', 'Mail', MAIL);
  const work = browser.bookmark('1', 'Work');
  const issues = browser.bookmark(work, 'Issues', ISSUES);
  const wiki = browser.bookmark(work, 'Wiki', WIKI);
  ids = { mail, work, issues, wiki };
  await startWorker(browser, 'install');
  // Past the restart grace, as in ordinary use.
  await vi.advanceTimersByTimeAsync(31_000);
});

afterEach(() => {
  vi.useRealTimers();
});

const tab = (tabId: number) => browser.tabs.get(tabId);
const indexOf = (tabId: number) => browser.indexOf(tab(tabId)!);

describe('new tabs in the pinned window', () => {
  test('a tab opened inside a managed group leaves it and goes to the end', async () => {
    const created = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://x.example.com/',
      index: indexOf(tabOf(browser, ids.issues)) + 1,
    });
    expect(tab(created.id!)?.groupId).not.toBe(-1);
    await flush();
    expect(tab(created.id!)?.groupId).toBe(-1);
    expect(indexOf(created.id!)).toBe(browser.windows.get(win)!.tabIds.length - 1);
  });

  test('with "new tabs at start" it goes right after the last group', async () => {
    await send(browser, { type: 'setSettings', patch: { newTabsAtStart: true } });
    const created = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://x.example.com/',
    });
    await flush();
    expect(indexOf(created.id!)).toBe(indexOf(tabOf(browser, ids.wiki)) + 1);
  });

  test('a tab in one of your own groups stays there', async () => {
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    const groupId = await browser.chrome.tabs.group({ tabIds: own });
    const created = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://x.example.com/',
    });
    await browser.chrome.tabs.group({ groupId, tabIds: created.id! });
    const before = indexOf(created.id!);
    await flush();
    expect(tab(created.id!)?.groupId).toBe(groupId);
    expect(indexOf(created.id!)).toBe(before);
  });

  test('a new pin of your own stays pinned; a pinned copy of a managed page becomes ordinary', async () => {
    const own = await browser.chrome.tabs.create({
      windowId: win,
      url: 'https://own-pin.example.com/',
      pinned: true,
    });
    const copy = await browser.chrome.tabs.create({ windowId: win, url: MAIL, pinned: true });
    await flush();
    expect(tab(own.id!)?.pinned).toBe(true);
    expect(tab(copy.id!)).toMatchObject({ pinned: false, groupId: -1 });
    expect(tabOf(browser, ids.mail)).not.toBe(copy.id);
  });

  test('tabs in other windows are not moved', async () => {
    const second = browser.seedWindow([{ url: 'about:blank' }, { url: 'https://b.example.com/' }]);
    const created = await browser.chrome.tabs.create({
      windowId: second,
      url: 'https://x.example.com/',
      index: 0,
    });
    await flush();
    expect(indexOf(created.id!)).toBe(0);
  });
});

describe('other sites', () => {
  test('a second cross-site navigation immediately after recovery still splits', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, OTHER);
    await vi.advanceTimersByTimeAsync(20);
    expect(tab(mail)?.url).toBe(MAIL);

    const next = 'https://another.test/page';
    browser.navigate(mail, next);
    await vi.advanceTimersByTimeAsync(20);
    expect(tab(mail)?.url).toBe(MAIL);
    expect([...browser.tabs.values()].filter((it) => it.url === next)).toHaveLength(1);
  });

  test('a link to another site opens a new tab and the pin steps back', async () => {
    const mail = tabOf(browser, ids.mail);
    await browser.chrome.tabs.update(mail, { active: true });
    browser.navigate(mail, 'https://mail.example.com/inbox');
    await flush();
    browser.navigate(mail, OTHER);
    await flush();
    expect(tab(mail)?.url).toBe('https://mail.example.com/inbox');
    const opened = [...browser.tabs.values()].filter((it) => it.url === OTHER);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ pinned: false, groupId: -1, active: true });
  });

  test('without history the pin returns to its bookmark', async () => {
    const issues = tabOf(browser, ids.issues);
    browser.navigate(issues, OTHER, { transitionType: 'typed' });
    await flush();
    expect(tab(issues)?.url).toBe(ISSUES);
    expect([...browser.tabs.values()].filter((it) => it.url === OTHER)).toHaveLength(1);
  });

  test('redirects, reloads, form posts, history and subdomains stay in the pin', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, 'https://accounts.example.com/login');
    await flush();
    expect(tab(mail)?.url).toBe('https://accounts.example.com/login');
    browser.navigate(mail, 'https://sso.test/auth', { transitionQualifiers: ['server_redirect'] });
    await flush();
    browser.navigate(mail, 'https://sso.test/next', { transitionType: 'form_submit' });
    await flush();
    browser.navigate(mail, 'https://sso.test/more');
    await flush();
    expect(tab(mail)?.url).toBe('https://sso.test/more');
    const count = browser.tabs.size;
    browser.navigate(mail, 'chrome://settings/');
    await flush();
    expect(tab(mail)?.url).toBe('chrome://settings/');
    expect(browser.tabs.size).toBe(count);
  });

  test('a woken worker still knows the previous page from the stored last URL', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, 'https://sso.test/landed', {
      transitionQualifiers: ['client_redirect'],
    });
    await flush();
    await startWorker(browser);
    browser.navigate(mail, 'https://sso.test/next');
    await flush();
    expect(tab(mail)?.url).toBe('https://sso.test/next');
    browser.navigate(mail, OTHER);
    await flush();
    expect(tab(mail)?.url).toBe('https://sso.test/next');
  });

  test('ordinary tabs navigate freely', async () => {
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    browser.navigate(own, OTHER);
    await flush();
    expect(tab(own)?.url).toBe(OTHER);
  });

  test('the content script hands over a clicked cross-site link', async () => {
    const mail = tabOf(browser, ids.mail);
    await send(browser, { type: 'openSplit', url: OTHER }, senderTab(browser, mail));
    await send(
      browser,
      { type: 'openSplit', url: 'javascript:alert(1)' },
      senderTab(browser, mail),
    );
    expect([...browser.tabs.values()].filter((it) => it.url === OTHER)).toHaveLength(1);
    expect(tab(mail)?.url).toBe(MAIL);
  });
});

describe('return to the bookmark', () => {
  test('the toolbar icon returns a drifted pin, and reloads one at home', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, `${MAIL}#inbox/1`);
    await flush();
    browser.events.action.onClicked.emit(browser.snapshot(tab(mail)!));
    await flush();
    expect(tab(mail)?.url).toBe(MAIL);
    expect(tab(mail)?.reloads).toBe(0);

    browser.events.action.onClicked.emit(browser.snapshot(tab(mail)!));
    await flush();
    expect(tab(mail)?.reloads).toBe(1);
  });

  test('the toolbar icon on an ordinary tab opens the add dialog', async () => {
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    browser.events.action.onClicked.emit(browser.snapshot(tab(own)!));
    await flush();
    expect(browser.popups.get(own)).toBe('popup/add.html');
    expect(browser.openedPopups).toEqual([{ windowId: win }]);
  });

  test('triple-click returns a drifted pin and leaves one at home alone', async () => {
    const mail = tabOf(browser, ids.mail);
    await send(browser, { type: 'goHome' }, senderTab(browser, mail));
    expect(tab(mail)?.reloads).toBe(0);
    browser.navigate(mail, 'https://mail.example.com/thread');
    await flush();
    await send(browser, { type: 'goHome' }, senderTab(browser, mail));
    expect(tab(mail)?.url).toBe(MAIL);
  });

  test('a stale popup on a pin returns it instead', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.navigate(mail, 'https://mail.example.com/thread');
    await flush();
    const info = await send<PopupInfo>(browser, { type: 'popupOpened', tabId: mail });
    expect(info).toEqual({ managed: true });
    expect(tab(mail)?.url).toBe(MAIL);
  });

  test('the toolbar icon keeps working after the page navigates', async () => {
    const mail = tabOf(browser, ids.mail);
    browser.popups.set(mail, 'popup/add.html');
    browser.navigate(mail, 'https://mail.example.com/x');
    await flush();
    expect(browser.popups.get(mail)).toBe('');
  });
});

describe('messages', () => {
  test('concurrent settings patches both survive', async () => {
    await Promise.all([
      send(browser, { type: 'setSettings', patch: { tripleClick: true } }),
      send(browser, { type: 'setSettings', patch: { newTabsAtStart: true } }),
    ]);
    const info = await send<SettingsInfo>(browser, { type: 'getSettings' });
    expect(info.settings).toMatchObject({ tripleClick: true, newTabsAtStart: true });
  });

  test('selecting a bookmark as the pin folder is refused without closing pins', async () => {
    const before = [...browser.tabs.keys()];
    expect(
      await send<Reply>(browser, { type: 'setSettings', patch: { rootId: ids.mail } }),
    ).toMatchObject({ ok: false });
    expect([...browser.tabs.keys()]).toEqual(before);
    expect((await send<SettingsInfo>(browser, { type: 'getSettings' })).settings.rootId).toBe('1');
  });

  test('hello tells a page whether it is managed', async () => {
    const managed = await send<TabView>(
      browser,
      { type: 'hello' },
      senderTab(browser, tabOf(browser, ids.wiki)),
    );
    expect(managed).toMatchObject({ managed: true, bookmarkTitle: 'Wiki', bookmarkUrl: WIKI });
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    expect(await send<TabView>(browser, { type: 'hello' }, senderTab(browser, own))).toMatchObject({
      managed: false,
    });
  });

  test('changed settings reach every managed page', async () => {
    browser.messages = [];
    const info = await send<SettingsInfo>(browser, {
      type: 'setSettings',
      patch: { tripleClick: true, pageTitleInTitle: true },
    });
    expect(info.settings).toMatchObject({ tripleClick: true, pageTitleInTitle: true, rootId: '1' });
    expect(info.pinCount).toBe(3);
    expect(browser.messages).toHaveLength(3);
    expect(browser.messages.every((it) => it.message.view.tripleClick === true)).toBe(true);
  });

  test('the add dialog lists the pin folder and its subfolders', async () => {
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    const info = await send<PopupInfo>(browser, { type: 'popupOpened', tabId: own });
    expect(info).toMatchObject({ managed: false, url: 'https://own.example.com/', pinnable: true });
    expect(
      info.managed === false && info.folders.map((folder) => [folder.title, folder.depth]),
    ).toEqual([
      ['Bookmarks bar', 0],
      ['Work', 1],
    ]);
  });

  test('adding a tab in the pinned window makes that tab the pin', async () => {
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    const reply = await send<Reply>(browser, {
      type: 'addPin',
      tabId: own,
      title: ' Own ',
      parentId: ids.work,
    });
    expect(reply).toEqual({ ok: true });
    const [bookmark] = await browser.chrome.bookmarks.search({ url: 'https://own.example.com/' });
    expect(bookmark).toMatchObject({ title: 'Own', parentId: ids.work });
    expect(tabOf(browser, bookmark!.id)).toBe(own);
    expect(tab(own)?.groupId).toBe(tab(tabOf(browser, ids.issues))?.groupId);
    expect(browser.urlsIn(win).filter((url) => url === 'https://own.example.com/')).toHaveLength(1);
  });

  test('adding a tab from another window opens the pin in the pinned window', async () => {
    const second = browser.seedWindow([{ url: 'https://elsewhere.example.com/' }]);
    const tabId = browser.windows.get(second)!.tabIds[0]!;
    await send<Reply>(browser, { type: 'addPin', tabId, title: '', parentId: '1' });
    expect(tab(tabId)).toMatchObject({ windowId: second, pinned: false });
    expect(browser.urlsIn(win)).toContain('https://elsewhere.example.com/');
  });

  test('pages that cannot be pinned, and folders outside the pin folder, are refused', async () => {
    const blank = browser.windows.get(win)!.tabIds.find((id) => tab(id)?.url === 'about:blank')!;
    expect(
      await send<Reply>(browser, { type: 'addPin', tabId: blank, title: 'x', parentId: '1' }),
    ).toMatchObject({ ok: false });
    expect(await send<PopupInfo>(browser, { type: 'popupOpened', tabId: blank })).toMatchObject({
      pinnable: false,
    });
    const own = browser.windows.get(win)!.tabIds.at(-1)!;
    expect(
      await send<Reply>(browser, { type: 'addPin', tabId: own, title: 'x', parentId: '2' }),
    ).toMatchObject({ ok: false });
  });

  test('a failing request is answered with the error', async () => {
    const bookmarks = browser.chrome.bookmarks as unknown as { getTree: () => Promise<unknown> };
    bookmarks.getTree = () => Promise.reject(new Error('bookmarks unavailable'));
    expect(await send<Reply>(browser, { type: 'getSettings' })).toEqual({
      ok: false,
      message: 'bookmarks unavailable',
    });
  });

  test('unknown messages are ignored', async () => {
    expect(await send(browser, null)).toBeUndefined();
    expect(sessionState(browser).windowId).toBe(win);
  });
});
