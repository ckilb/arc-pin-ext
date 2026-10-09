/**
 * End-to-end run: real Chromium with the built extension (dist/), a temporary profile
 * and local fixture pages. Not part of `npm run check` or packaging.
 *
 *   npm run test:e2e              (builds first)
 *   node test/e2e/run.ts --headed
 *
 * Set TAB_PIN_BROWSER to a Chromium or Chrome for Testing binary to choose the browser.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { startServer } from './server.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const headed = process.argv.includes('--headed');

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function findBrowser(): string | null {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const cached = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .map((name) => path.join(cache, name, 'chrome-linux64', 'chrome'))
    : [];
  const candidates = [process.env.TAB_PIN_BROWSER, ...cached, chromium.executablePath()];
  return (
    candidates.find((candidate): candidate is string => {
      if (!candidate) return false;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

function launch(browser: string, profile: string, restore = false): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    executablePath: browser,
    headless: !headed,
    viewport: { width: 1000, height: 700 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1',
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
      '--no-first-run',
      '--no-default-browser-check',
      ...(restore ? ['--restore-last-session'] : []),
    ],
  });
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((it) => it.url().endsWith('/background.js'));
  return existing ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
}

// ---------------------------------------------------------------------------
// Reading the extension's world
// ---------------------------------------------------------------------------

interface Snapshot {
  state: {
    windowId: number | null;
    bindings: Record<
      string,
      { tabId: number | null; url: string; lastUrl: string; title: string; folderId: string | null }
    >;
  } | null;
  tabs: Array<{
    id: number;
    windowId: number;
    index: number;
    url: string;
    title: string;
    pinned: boolean;
    groupId: number;
    active: boolean;
  }>;
  groups: Array<{ id: number; windowId: number; title: string }>;
  windows: number[];
}

let worker: Worker;

function inWorker<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
  // Playwright's overloads cannot express an optional argument generically.
  const evaluate = worker.evaluate.bind(worker) as (f: unknown, a: unknown) => Promise<R>;
  return evaluate(fn, arg);
}

function snapshot(): Promise<Snapshot> {
  return inWorker(async () => {
    const stored = await chrome.storage.session.get('state');
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return {
      state: stored.state ?? null,
      tabs: tabs.map((tab) => ({
        id: tab.id ?? -1,
        windowId: tab.windowId,
        index: tab.index,
        url: tab.pendingUrl || tab.url || '',
        title: tab.title ?? '',
        pinned: tab.pinned,
        groupId: tab.groupId,
        active: tab.active,
      })),
      groups: groups.map((group) => ({
        id: group.id,
        windowId: group.windowId,
        title: group.title ?? '',
      })),
      windows: windows.flatMap((window) => (window.id === undefined ? [] : [window.id])),
    } as Snapshot;
  });
}

/** Managed tabs of the pinned window in strip order: `pin:Mail`, `Work:Issues`. */
function managedStrip(snap: Snapshot): string[] {
  const windowId = snap.state?.windowId;
  const names = new Map<number, string>();
  for (const binding of Object.values(snap.state?.bindings ?? {})) {
    if (binding.tabId !== null) names.set(binding.tabId, binding.title);
  }
  const groups = new Map(snap.groups.map((group) => [group.id, group.title.replace('⁣', '')]));
  return snap.tabs
    .filter(
      (tab) => tab.windowId === windowId && (names.has(tab.id) || tab.pinned || tab.groupId !== -1),
    )
    .sort((a, b) => a.index - b.index)
    .map((tab) => {
      const name = names.get(tab.id) ?? `?${new URL(tab.url).pathname}`;
      if (tab.pinned) return `pin:${name}`;
      if (tab.groupId !== -1) return `${groups.get(tab.groupId) ?? '?'}:${name}`;
      return `loose:${name}`;
    });
}

function tabsAt(snap: Snapshot, url: string, windowId?: number) {
  return snap.tabs.filter(
    (tab) => tab.url === url && (windowId === undefined || tab.windowId === windowId),
  );
}

function boundTab(snap: Snapshot, title: string) {
  const binding = Object.values(snap.state?.bindings ?? {}).find((it) => it.title === title);
  return snap.tabs.find((tab) => tab.id === binding?.tabId) ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: (snap: Snapshot) => boolean,
  timeout = 8_000,
): Promise<{ ok: boolean; snap: Snapshot }> {
  const deadline = Date.now() + timeout;
  let snap = await snapshot();
  while (!predicate(snap) && Date.now() < deadline) {
    await sleep(100);
    snap = await snapshot();
  }
  return { ok: predicate(snap), snap };
}

/** Wait until nothing changes for a while: catches late duplicates and stray moves. */
async function settle(quietMs = 1_200, timeout = 10_000): Promise<Snapshot> {
  const deadline = Date.now() + timeout;
  let last = JSON.stringify(await snapshot());
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(150);
    const now = JSON.stringify(await snapshot());
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) break;
  }
  return JSON.parse(last) as Snapshot;
}

/** Identify the exact tab, even when another window has a page on the same URL. */
async function pageAt(context: BrowserContext, url: string, tabId: number): Promise<Page> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await inWorker(
      (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: (id: number) => {
            document.documentElement.dataset.tabPinE2e = String(id);
          },
          args: [id],
        }),
      tabId,
    ).catch(() => {});
    for (const page of context.pages().filter((it) => it.url() === url)) {
      const id = await page
        .evaluate(() => document.documentElement.dataset.tabPinE2e)
        .catch(() => undefined);
      if (id === String(tabId)) return page;
    }
    await sleep(100);
  }
  throw new Error(`no page for tab ${tabId} at ${url}`);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const results: Array<{ name: string; ok: boolean }> = [];

function check(name: string, ok: boolean, detail: unknown = ''): void {
  results.push({ name, ok });
  const suffix =
    ok || detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${suffix}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const browser = findBrowser();
  if (!browser) {
    console.error(
      'No Chromium found. Run `npx playwright-core install chromium` or set TAB_PIN_BROWSER.',
    );
    process.exit(2);
  }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error('dist/ is missing; run `npm run build` first.');
    process.exit(2);
  }
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-pin-e2e-'));
  console.log(`browser ${browser}\nprofile ${profile}\nfixtures on port ${server.port}`);

  const home = (name: string) => server.url('home.site.test', `/page/${name}`);
  const other = (name: string) => server.url('other.test', `/page/${name}`);
  // The pinned pages once the edits below have run (the Wiki bookmark moves to /wiki2).
  const finalUrls = ['mail', 'added', 'issues', 'wiki2', 'e'].map(home);

  let context = await launch(browser, profile);
  try {
    worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;
    const extensionUrl = (file: string) => `chrome-extension://${extensionId}/${file}`;

    // The options page is the panel a person would use, and the way to send it messages.
    const optionsPage = await context.newPage();
    await optionsPage.goto(extensionUrl('options/options.html'));
    const message = (body: object) =>
      optionsPage.evaluate((it) => chrome.runtime.sendMessage(it), body) as Promise<unknown>;

    // ------------------------------------------------------------------ initial sync
    section('Initial sync');
    const ids = await inWorker(
      async ({ mail, news, issues, wiki, e }) => {
        const make = (parentId: string, title: string, url?: string) =>
          chrome.bookmarks.create({ parentId, title, ...(url ? { url } : {}) });
        const created = {
          mail: (await make('1', 'Mail', mail)).id,
          work: (await make('1', 'Work')).id,
          news: '',
          misc: '',
          issues: '',
          wiki: '',
          e: '',
          old: '',
        };
        created.issues = (await make(created.work, 'Issues', issues)).id;
        created.old = (await make(created.work, 'Old')).id;
        created.wiki = (await make(created.old, 'Wiki', wiki)).id;
        await make(created.work, 'Bookmarklet', 'javascript:void 0');
        created.news = (await make('1', 'News', news)).id;
        created.misc = (await make('1', 'Misc')).id;
        created.e = (await make(created.misc, 'E', e)).id;
        return created;
      },
      {
        mail: home('mail'),
        news: home('news'),
        issues: home('issues'),
        wiki: home('wiki'),
        e: home('e'),
      },
    );
    const expected = ['pin:Mail', 'pin:News', 'Work:Issues', 'Work:Wiki', 'Misc:E'];
    let { ok, snap } = await waitFor((it) => managedStrip(it).join() === expected.join());
    check(
      'loose bookmarks become pins, folders become groups, in bookmark order',
      ok,
      managedStrip(snap),
    );
    snap = await settle();
    const pinnedWindow = snap.state?.windowId ?? -1;
    const allUrls = ['mail', 'news', 'issues', 'wiki', 'e'].map(home);
    const exactlyOnce = (it: Snapshot) =>
      allUrls.every((url) => tabsAt(it, url, pinnedWindow).length === 1);
    check(
      'every bookmark is open exactly once',
      exactlyOnce(snap),
      snap.tabs.map((tab) => tab.url),
    );
    check(
      'groups carry the invisible marker',
      snap.groups.some((group) => group.title === '⁣Work') &&
        snap.groups.some((group) => group.title === '⁣Misc'),
      snap.groups,
    );
    const mailTitle = await waitFor((it) => boundTab(it, 'Mail')?.title === 'Mail');
    check(
      'a pinned tab shows its bookmark name',
      mailTitle.ok,
      boundTab(mailTitle.snap, 'Mail')?.title,
    );

    // ------------------------------------------------------------------ duplicates
    section('No duplicates');
    await Promise.all([
      message({ type: 'syncNow' }),
      message({ type: 'syncNow' }),
      inWorker(() => (globalThis as any).tabPinTest.sync()),
      inWorker(async () => {
        // A burst of bookmark events, as bookmark sync or a drag produces.
        for (let i = 0; i < 5; i += 1) {
          const it = await chrome.bookmarks.create({
            parentId: '2',
            title: `tmp${i}`,
            url: 'https://tmp.test/',
          });
          await chrome.bookmarks.remove(it.id);
        }
      }),
      message({ type: 'syncNow' }),
    ]);
    snap = await settle();
    check(
      'concurrent syncs and bookmark bursts open nothing twice',
      exactlyOnce(snap),
      snap.tabs.map((tab) => tab.url),
    );
    check(
      'the strip is unchanged',
      managedStrip(snap).join() === expected.join(),
      managedStrip(snap),
    );

    // ------------------------------------------------------------------ reopen
    section('Reopen');
    const blank = snap.tabs.find(
      (tab) => tab.windowId === pinnedWindow && !tab.pinned && tab.groupId === -1,
    );
    if (blank) await inWorker((id) => chrome.tabs.update(id, { active: true }), blank.id);
    const newsBefore = boundTab(snap, 'News');
    await inWorker((id) => chrome.tabs.remove(id), newsBefore?.id ?? -1);
    ({ ok, snap } = await waitFor(
      (it) =>
        managedStrip(it).join() === expected.join() && boundTab(it, 'News')?.id !== newsBefore?.id,
    ));
    check('a closed pin reopens in its place', ok, managedStrip(snap));
    check('the reopened pin does not take focus', boundTab(snap, 'News')?.active === false);
    check('the reopened pin is on its bookmark URL', boundTab(snap, 'News')?.url === home('news'));

    const wikiBefore = boundTab(snap, 'Wiki');
    await inWorker((id) => chrome.tabs.remove(id), wikiBefore?.id ?? -1);
    ({ ok, snap } = await waitFor(
      (it) =>
        managedStrip(it).join() === expected.join() && boundTab(it, 'Wiki')?.id !== wikiBefore?.id,
    ));
    check('a closed group tab reopens in its group and place', ok, managedStrip(snap));

    const everything = expected.map((name) => boundTab(snap, name.split(':')[1] ?? '')?.id ?? -1);
    await inWorker((tabIds) => chrome.tabs.remove(tabIds), everything);
    await waitFor((it) => managedStrip(it).join() === expected.join());
    snap = await settle();
    check(
      'closing every managed tab at once reopens each exactly once',
      exactlyOnce(snap) && managedStrip(snap).join() === expected.join(),
      {
        strip: managedStrip(snap),
        urls: snap.tabs.map((tab) => tab.url),
      },
    );

    // ------------------------------------------------------------------ second window
    section('Single window');
    const second = await inWorker(async (url) => {
      const window = await chrome.windows.create({ url, focused: true });
      return window?.id ?? -1;
    }, home('mail'));
    await message({ type: 'syncNow' });
    snap = await settle();
    check(
      'a second window gets no synced tabs',
      snap.tabs.filter((tab) => tab.windowId === second).length === 1,
      snap.tabs.filter((tab) => tab.windowId === second),
    );
    check(
      'an ordinary tab on a bookmark URL elsewhere is left alone',
      tabsAt(snap, home('mail'), second).length === 1 &&
        tabsAt(snap, home('mail'), pinnedWindow).length === 1,
    );
    check('the pinned window stays the pinned window', snap.state?.windowId === pinnedWindow);
    await inWorker((id) => chrome.windows.update(id, { focused: true }), pinnedWindow);

    // ------------------------------------------------------------------ other sites
    section('Other sites open in new tabs');
    const mailId = boundTab(snap, 'Mail')?.id ?? -1;
    let mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#cross');
    ({ ok, snap } = await waitFor((it) => tabsAt(it, other('crossed')).length === 1));
    await sleep(500);
    snap = await snapshot();
    check('a link to another site opens in a new tab', ok);
    check(
      'the pin stays on its page',
      snap.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    );
    check(
      'the other site loads once (the pin never loaded it)',
      server.hits('other.test', '/page/crossed') === 1,
      server.hits('other.test', '/page/crossed'),
    );
    const crossed = tabsAt(snap, other('crossed'))[0];
    check(
      'the new tab is ordinary',
      crossed !== undefined && !crossed.pinned && crossed.groupId === -1,
    );
    if (crossed) await inWorker((id) => chrome.tabs.remove(id), crossed.id);

    await mail.click('#sub');
    ({ ok } = await waitFor(
      (it) =>
        it.tabs.find((tab) => tab.id === mailId)?.url === server.url('sub.site.test', '/page/sub'),
    ));
    snap = await snapshot();
    check(
      'another subdomain of the same site stays in the pin',
      ok && tabsAt(snap, server.url('sub.site.test', '/page/sub')).length === 1,
    );
    await inWorker((id) => (globalThis as any).tabPinTest.clickAction(id), mailId);
    await waitFor((it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'));

    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#redirect');
    ({ ok } = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === other('landed'),
    ));
    await sleep(500);
    snap = await snapshot();
    check(
      'a redirect to another site stays in the pin',
      ok && tabsAt(snap, other('landed')).length === 1,
      snap.tabs.map((tab) => tab.url),
    );
    await inWorker((id) => (globalThis as any).tabPinTest.clickAction(id), mailId);
    await waitFor((it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'));

    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#jsnav');
    ({ ok, snap } = await waitFor(
      (it) =>
        tabsAt(it, other('scripted')).length === 1 &&
        it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    ));
    check(
      'a scripted navigation to another site moves to a new tab and the pin steps back',
      ok,
      snap.tabs.map((tab) => tab.url),
    );
    for (const tab of tabsAt(snap, other('scripted')))
      await inWorker((id) => chrome.tabs.remove(id), tab.id);

    // ------------------------------------------------------------------ return
    section('Return to the bookmark');
    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#same');
    await waitFor(
      (it) =>
        it.tabs.find((tab) => tab.id === mailId)?.url ===
        server.url('home.site.test', '/page/deeper'),
    );
    const drifted = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.title === '/ Mail',
    );
    check(
      'a pin away from its bookmark is titled "/ Name"',
      drifted.ok,
      drifted.snap.tabs.find((tab) => tab.id === mailId)?.title,
    );
    await inWorker((id) => (globalThis as any).tabPinTest.clickAction(id), mailId);
    ({ ok } = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    ));
    check('the toolbar icon returns a pin to its bookmark', ok);

    const loadsBefore = server.hits('home.site.test', '/page/mail');
    await inWorker((id) => (globalThis as any).tabPinTest.clickAction(id), mailId);
    await sleep(800);
    check(
      'the toolbar icon on the bookmark reloads it',
      server.hits('home.site.test', '/page/mail') === loadsBefore + 1,
    );

    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#hash');
    await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === `${home('mail')}#section`,
    );
    await inWorker((id) => (globalThis as any).tabPinTest.clickAction(id), mailId);
    ({ ok, snap } = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    ));
    check(
      'a pin that only changed its #hash also returns',
      ok,
      snap.tabs.find((tab) => tab.id === mailId)?.url,
    );

    const popupPage = await context.newPage();
    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#same');
    await waitFor(
      (it) =>
        it.tabs.find((tab) => tab.id === mailId)?.url ===
        server.url('home.site.test', '/page/deeper'),
    );
    await popupPage.goto(extensionUrl(`popup/add.html?tabId=${mailId}`));
    ({ ok } = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    ));
    check('a stale toolbar popup on a pin returns it instead of offering to add it', ok);
    await popupPage.close();

    // ------------------------------------------------------------------ triple-click
    section('Triple-click');
    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#same');
    const deeper = server.url('home.site.test', '/page/deeper');
    await waitFor((it) => it.tabs.find((tab) => tab.id === mailId)?.url === deeper);
    mail = await pageAt(context, deeper, mailId);
    await mail.click('#text', { clickCount: 3 });
    await sleep(800);
    snap = await snapshot();
    check(
      'triple-click does nothing while it is off (the default)',
      snap.tabs.find((tab) => tab.id === mailId)?.url === deeper,
    );
    await message({ type: 'setSettings', patch: { tripleClick: true, pageTitleInTitle: true } });
    const withPageTitle = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.title === '/ Mail / Page deeper',
    );
    check(
      'the page title option shows "/ Name / Page title"',
      withPageTitle.ok,
      withPageTitle.snap.tabs.find((tab) => tab.id === mailId)?.title,
    );
    await mail.click('#text', { clickCount: 3 });
    ({ ok } = await waitFor(
      (it) => it.tabs.find((tab) => tab.id === mailId)?.url === home('mail'),
    ));
    check('triple-click returns the pin when enabled', ok);
    const homeLoads = server.hits('home.site.test', '/page/mail');
    mail = await pageAt(context, home('mail'), mailId);
    await mail.click('#text', { clickCount: 3 });
    await sleep(800);
    check(
      'triple-click on the bookmark page itself does nothing',
      server.hits('home.site.test', '/page/mail') === homeLoads,
    );
    await message({ type: 'setSettings', patch: { pageTitleInTitle: false } });

    // ------------------------------------------------------------------ manual changes
    section('Manual changes');
    snap = await snapshot();
    await inWorker((id) => chrome.tabs.update(id, { pinned: false }), mailId);
    ({ ok } = await waitFor((it) => it.tabs.find((tab) => tab.id === mailId)?.pinned === true));
    check('an unpinned managed pin is pinned again', ok);
    const issuesId = boundTab(snap, 'Issues')?.id ?? -1;
    await inWorker((id) => chrome.tabs.ungroup(id), issuesId);
    ({ ok, snap } = await waitFor((it) => managedStrip(it).includes('Work:Issues')));
    check('an ungrouped managed tab rejoins its group', ok, managedStrip(snap));
    snap = await settle();
    check(
      'nothing was duplicated',
      exactlyOnce(snap),
      snap.tabs.map((tab) => tab.url),
    );

    const newsId = boundTab(snap, 'News')?.id ?? -1;
    await inWorker((id) => chrome.tabs.move(id, { index: 0 }), newsId);
    snap = await settle(800);
    check(
      'a manual reorder is kept until the next sync',
      managedStrip(snap).join() === ['pin:News', 'pin:Mail', ...expected.slice(2)].join(),
      managedStrip(snap),
    );
    await message({ type: 'syncNow' });
    snap = await settle(800);
    check(
      'the next sync restores bookmark order',
      managedStrip(snap).join() === expected.join(),
      managedStrip(snap),
    );

    // ------------------------------------------------------------------ new tabs
    section('New tabs');
    const issuesPage = await pageAt(context, home('issues'), issuesId);
    await issuesPage.click('#same', { modifiers: ['Control'] });
    ({ ok, snap } = await waitFor(
      (it) => tabsAt(it, server.url('home.site.test', '/page/deeper'), pinnedWindow).length === 1,
    ));
    let opened = tabsAt(snap, server.url('home.site.test', '/page/deeper'), pinnedWindow)[0];
    await sleep(600);
    snap = await snapshot();
    opened = snap.tabs.find((tab) => tab.id === opened?.id);
    const windowTabs = snap.tabs.filter((tab) => tab.windowId === pinnedWindow);
    check('a tab opened from a group leaves the group', ok && opened?.groupId === -1, opened);
    check('…and opens at the end', opened?.index === windowTabs.length - 1, {
      opened,
      count: windowTabs.length,
    });
    if (opened) await inWorker((id) => chrome.tabs.remove(id), opened.id);

    await message({ type: 'setSettings', patch: { newTabsAtStart: true } });
    await issuesPage.click('#same', { modifiers: ['Control'] });
    ({ snap } = await waitFor(
      (it) => tabsAt(it, server.url('home.site.test', '/page/deeper'), pinnedWindow).length === 1,
    ));
    await sleep(600);
    snap = await snapshot();
    opened = tabsAt(snap, server.url('home.site.test', '/page/deeper'), pinnedWindow)[0];
    const lastGrouped = Math.max(
      ...snap.tabs
        .filter((tab) => tab.windowId === pinnedWindow && (tab.pinned || tab.groupId !== -1))
        .map((tab) => tab.index),
    );
    check(
      'with "new tabs at start", it opens right after the last group',
      opened?.groupId === -1 && opened?.index === lastGrouped + 1,
      { opened, lastGrouped },
    );
    if (opened) await inWorker((id) => chrome.tabs.remove(id), opened.id);
    await message({ type: 'setSettings', patch: { newTabsAtStart: false } });

    // ------------------------------------------------------------------ add pin
    section('Add pin');
    const addedUrl = home('added');
    const addedId = await inWorker(
      async ({ url, windowId }) =>
        (await chrome.tabs.create({ url, windowId, active: true })).id ?? -1,
      { url: addedUrl, windowId: pinnedWindow },
    );
    await waitFor((it) => it.tabs.find((tab) => tab.id === addedId)?.url === addedUrl);
    const dialog = await context.newPage();
    await dialog.goto(extensionUrl(`popup/add.html?tabId=${addedId}`));
    await dialog.waitForSelector('#form:not([hidden])');
    check(
      'the dialog suggests the page title',
      (await dialog.inputValue('#name')) === 'Page added',
    );
    await dialog.fill('#name', 'Added');
    await dialog.selectOption('#folder', ids.misc);
    await dialog.click('#save');
    ({ ok, snap } = await waitFor((it) => managedStrip(it).includes('Misc:Added')));
    await dialog.close();
    snap = await settle();
    check(
      'the tab itself becomes the pin, inside the chosen group',
      ok && boundTab(snap, 'Added')?.id === addedId,
      managedStrip(snap),
    );
    check('no second copy is opened', tabsAt(snap, addedUrl).length === 1);
    const bookmark = await inWorker(
      async (url) => (await chrome.bookmarks.search({ url }))[0],
      addedUrl,
    );
    check(
      'the bookmark is created in that folder',
      bookmark?.parentId === ids.misc && bookmark?.title === 'Added',
      bookmark,
    );

    // ------------------------------------------------------------------ drag out
    section('Dragging a pin to another window');
    const eId = boundTab(snap, 'E')?.id ?? -1;
    await inWorker(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), {
      tabId: eId,
      windowId: second,
    });
    ({ ok, snap } = await waitFor((it) => {
      const dragged = it.tabs.find((tab) => tab.id === eId);
      return (
        dragged?.windowId === second &&
        !dragged.pinned &&
        dragged.groupId === -1 &&
        managedStrip(it).includes('Misc:E') &&
        boundTab(it, 'E')?.id !== eId
      );
    }));
    check('the dragged tab becomes ordinary and the pin reopens at home', ok, {
      strip: managedStrip(snap),
    });
    snap = await settle();
    check(
      '…with one copy in the pinned window',
      tabsAt(snap, home('e'), pinnedWindow).length === 1,
    );

    // ------------------------------------------------------------------ bookmark edits
    section('Bookmark edits');
    const wikiId = boundTab(snap, 'Wiki')?.id ?? -1;
    await inWorker(({ id, url }) => chrome.bookmarks.update(id, { url }), {
      id: ids.wiki,
      url: home('wiki2'),
    });
    snap = await settle();
    const wikiBinding = Object.values(snap.state?.bindings ?? {}).find((it) => it.title === 'Wiki');
    check(
      'a changed bookmark URL is the new target, without navigating the tab',
      wikiBinding?.url === home('wiki2') &&
        snap.tabs.find((tab) => tab.id === wikiId)?.url === home('wiki'),
      wikiBinding,
    );
    await inWorker((id) => chrome.bookmarks.update(id, { title: 'Docs' }), ids.wiki);
    ({ ok } = await waitFor((it) => it.tabs.find((tab) => tab.id === wikiId)?.title === '/ Docs'));
    check('a renamed bookmark renames its tab', ok);

    await inWorker((id) => chrome.bookmarks.remove(id), ids.news);
    snap = await settle();
    check(
      'a deleted bookmark closes its tab for good',
      tabsAt(snap, home('news')).length === 0 && !managedStrip(snap).includes('pin:News'),
      managedStrip(snap),
    );

    await inWorker(({ misc }) => chrome.bookmarks.move(misc, { parentId: '1', index: 0 }), {
      misc: ids.misc,
    });
    snap = await settle();
    const reordered = ['pin:Mail', 'Misc:E', 'Misc:Added', 'Work:Issues', 'Work:Docs'];
    check(
      'moving a folder reorders the groups',
      managedStrip(snap).join() === reordered.join(),
      managedStrip(snap),
    );

    await inWorker(({ e, work }) => chrome.bookmarks.move(e, { parentId: work }), {
      e: ids.e,
      work: ids.work,
    });
    snap = await settle();
    check(
      'moving a bookmark to another folder moves its tab between groups',
      managedStrip(snap).join() ===
        ['pin:Mail', 'Misc:Added', 'Work:Issues', 'Work:Docs', 'Work:E'].join(),
      managedStrip(snap),
    );

    // ------------------------------------------------------------------ folder choice
    section('Pin folder');
    const altFolder = await inWorker(async (url) => {
      const folder = await chrome.bookmarks.create({ parentId: '2', title: 'Alt' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'Alt page', url });
      return folder.id;
    }, home('alt'));
    await message({ type: 'setSettings', patch: { rootId: altFolder } });
    ({ ok, snap } = await waitFor((it) => managedStrip(it).join() === 'pin:Alt page'));
    snap = await settle();
    check(
      'switching folders closes the old pins and opens the new ones',
      ok &&
        managedStrip(snap).join() === 'pin:Alt page' &&
        tabsAt(snap, home('mail'), pinnedWindow).length === 0,
      managedStrip(snap),
    );
    await inWorker((id) => chrome.bookmarks.removeTree(id), altFolder);
    ({ ok, snap } = await waitFor((it) => managedStrip(it).includes('pin:Mail')));
    snap = await settle();
    const settings = (await message({ type: 'getSettings' })) as { settings: { rootId: string } };
    check(
      'a deleted pin folder falls back to the bookmarks bar',
      ok && settings.settings.rootId === '1' && tabsAt(snap, home('alt')).length === 0,
      managedStrip(snap),
    );
    check(
      '…without duplicates',
      allUrls
        .filter((url) => url !== home('news') && url !== home('wiki'))
        .every((url) => tabsAt(snap, url, pinnedWindow).length === 1),
      snap.tabs.map((tab) => tab.url),
    );

    // ------------------------------------------------------------------ windows
    section('Pinned window');
    const third = await inWorker(
      async () => (await chrome.windows.create({ url: 'about:blank' }))?.id ?? -1,
    );
    snap = await settle();
    const before = new Map(
      managedStrip(snap).map((name) => [name, boundTab(snap, name.split(':')[1] ?? '')?.id]),
    );
    await inWorker((id) => (globalThis as any).tabPinTest.makePinnedWindow(id), third);
    ({ ok, snap } = await waitFor(
      (it) => it.state?.windowId === third && managedStrip(it).length === before.size,
    ));
    snap = await settle();
    check(
      '"Make this the pinned window" moves the pins there',
      ok && managedStrip(snap).join() === [...before.keys()].join(),
      managedStrip(snap),
    );
    check(
      '…as the same tabs, without reloading or copying',
      [...before].every(([name, id]) => boundTab(snap, name.split(':')[1] ?? '')?.id === id),
    );
    check(
      '…and leaves nothing managed behind',
      !snap.tabs.some((tab) => tab.windowId === pinnedWindow && (tab.pinned || tab.groupId !== -1)),
    );

    await inWorker((id) => chrome.windows.update(id, { focused: true }), second);
    await inWorker((id) => chrome.windows.remove(id), third);
    ({ ok, snap } = await waitFor(
      (it) =>
        it.state?.windowId !== third &&
        it.state?.windowId !== null &&
        managedStrip(it).length === before.size,
      8_000,
    ));
    snap = await settle();
    check(
      'closing the pinned window moves the pins to a remaining window',
      ok && managedStrip(snap).join() === [...before.keys()].join(),
      { windowId: snap.state?.windowId, strip: managedStrip(snap) },
    );
    const nowPinned = snap.state?.windowId ?? -1;
    check(
      '…exactly once, next to your own ordinary tabs there',
      managedOnceIn(snap, nowPinned, finalUrls) &&
        snap.tabs.filter(
          (tab) =>
            tab.windowId === nowPinned &&
            !tab.pinned &&
            tab.groupId === -1 &&
            [home('mail'), home('e')].includes(tab.url),
        ).length === 2,
      snap.tabs
        .filter((tab) => tab.windowId === nowPinned)
        .map((tab) => `${tab.pinned ? 'pin:' : tab.groupId !== -1 ? 'group:' : ''}${tab.url}`),
    );

    // ------------------------------------------------------------------ extension reload
    section('Extension update');
    const beforeReload = await settle();
    const reloadedIds = new Set(
      Object.values(beforeReload.state?.bindings ?? {}).map((it) => it.tabId),
    );
    // The extensions page's reload button: chrome.runtime.reload() would unload an extension
    // loaded from the command line instead. Reloading needs developer mode, as in real life.
    const workerPromise = context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionsPage = await context.newPage();
    await extensionsPage.goto('chrome://extensions');
    await extensionsPage.evaluate(async (id) => {
      const developer = (chrome as unknown as { developerPrivate: any }).developerPrivate;
      await developer.updateProfileConfiguration({ inDeveloperMode: true });
      await developer.reload(id, { failQuietly: true });
    }, extensionId);
    worker = await workerPromise;
    await extensionsPage.close();
    ({ ok, snap } = await waitFor(
      (it) =>
        it.state !== null &&
        Object.values(it.state.bindings).every((binding) => binding.tabId !== null),
      15_000,
    ));
    snap = await settle();
    check(
      'after an update the open tabs are adopted again',
      ok &&
        Object.values(snap.state?.bindings ?? {}).every((binding) =>
          reloadedIds.has(binding.tabId),
        ),
      snap.state?.bindings,
    );
    check(
      '…with no duplicates',
      managedOnceIn(snap, snap.state?.windowId ?? -1, finalUrls),
      snap.tabs.map((tab) => tab.url),
    );
    const mailAfter = boundTab(snap, 'Mail');
    if (mailAfter) {
      await inWorker((id) => chrome.tabs.update(id, { active: true }), mailAfter.id);
      await sleep(300);
      mail = await pageAt(context, home('mail'), mailAfter.id);
      await mail.click('#same');
      await waitFor((it) => it.tabs.find((tab) => tab.id === mailAfter.id)?.url === deeper);
      mail = await pageAt(context, deeper, mailAfter.id);
      await mail.click('#text', { clickCount: 3 });
      ({ ok } = await waitFor(
        (it) => it.tabs.find((tab) => tab.id === mailAfter.id)?.url === home('mail'),
      ));
      check('triple-click works right after an update, without reloading pages', ok);

      // Leave the pin on another page for the restart below.
      mail = await pageAt(context, home('mail'), mailAfter.id);
      await mail.click('#same');
      await waitFor((it) => it.tabs.find((tab) => tab.id === mailAfter.id)?.url === deeper);
      await settle();
    }
  } finally {
    await context.close().catch(() => {});
  }

  // -------------------------------------------------------------------- restart
  section('Browser restart');
  context = await launch(browser, profile, true);
  try {
    worker = await serviceWorker(context);
    let { ok, snap } = await waitFor(
      (it) =>
        it.state !== null &&
        Object.values(it.state.bindings).every((binding) => binding.tabId !== null),
      20_000,
    );
    snap = await settle(2_000, 15_000);
    const pinned = snap.state?.windowId ?? -1;
    check('the pins come back after a restart', ok, snap.state);
    check(
      'session restore and the extension never both open a pin',
      managedOnceIn(
        snap,
        pinned,
        finalUrls.filter((url) => url !== home('mail')),
      ) && !snap.tabs.some((tab) => tab.windowId !== pinned && (tab.pinned || tab.groupId !== -1)),
      snap.tabs.map((tab) => `${tab.windowId}:${tab.pinned ? 'pin:' : ''}${tab.url}`),
    );
    const restoredMail = boundTab(snap, 'Mail');
    check(
      'the restored tab is adopted on the page it was left on, with no managed copy on the bookmark URL',
      restoredMail?.url === server.url('home.site.test', '/page/deeper') &&
        tabsAt(snap, home('mail'), pinned).filter((tab) => tab.pinned || tab.groupId !== -1)
          .length === 0,
      snap.tabs.map((tab) => `${tab.windowId}:${tab.pinned ? 'pin:' : ''}${tab.url}`),
    );
    check(
      'restored pins keep their groups',
      managedStrip(snap).join() ===
        ['pin:Mail', 'Misc:Added', 'Work:Issues', 'Work:Docs', 'Work:E'].join(),
      managedStrip(snap),
    );
  } finally {
    await context.close().catch(() => {});
    await server.close();
  }

  const failed = results.filter((it) => !it.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const it of failed) console.log(`  FAIL ${it.name}`);
    process.exit(1);
  }
}

/** Each URL is held by exactly one pinned or grouped tab in the window. */
function managedOnceIn(snap: Snapshot, windowId: number, urls: string[]): boolean {
  return urls.every(
    (url) =>
      tabsAt(snap, url, windowId).filter((tab) => tab.pinned || tab.groupId !== -1).length === 1,
  );
}

await main();
