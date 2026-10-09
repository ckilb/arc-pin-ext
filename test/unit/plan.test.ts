import { describe, expect, test } from 'vitest';
import {
  pickRestoredWindow,
  planBindings,
  type LiveTab,
  type PlanInput,
} from '../../src/lib/plan.ts';
import type { Binding, Layout } from '../../src/lib/types.ts';

const W = 1;
const OTHER = 2;
const MANAGED_GROUP = 50;
const OWN_GROUP = 60;

const layout: Layout = {
  pins: [
    { bookmarkId: 'mail', url: 'https://mail.example.com/', title: 'Mail', folderId: null },
    { bookmarkId: 'news', url: 'https://news.example.com/', title: 'News', folderId: null },
    { bookmarkId: 'issues', url: 'https://issues.example.com/', title: 'Issues', folderId: 'work' },
  ],
  folders: [{ folderId: 'work', title: 'Work', color: 'blue' }],
};

function tab(id: number, url: string, extra: Partial<LiveTab> = {}): LiveTab {
  return { id, windowId: W, url, pinned: false, groupId: -1, ...extra };
}

function bound(bookmarkId: string, tabId: number | null, extra: Partial<Binding> = {}): Binding {
  const spec = layout.pins.find((pin) => pin.bookmarkId === bookmarkId);
  if (!spec) throw new Error(bookmarkId);
  return {
    tabId,
    url: spec.url,
    title: spec.title,
    folderId: spec.folderId,
    lastUrl: spec.url,
    ...extra,
  };
}

function plan(input: Partial<PlanInput>) {
  return planBindings({
    layout,
    bindings: {},
    windowId: W,
    tabs: [],
    managedGroupIds: new Set([MANAGED_GROUP]),
    withinRestoreGrace: false,
    ...input,
  });
}

describe('planBindings', () => {
  test('a fresh folder opens every bookmark once', () => {
    const result = plan({});
    expect(result.create).toEqual(['mail', 'news', 'issues']);
    expect(result.close).toEqual([]);
  });

  test('a sync that changes nothing opens and closes nothing', () => {
    const tabs = [
      tab(1, 'https://mail.example.com/', { pinned: true }),
      tab(2, 'https://news.example.com/', { pinned: true }),
      tab(3, 'https://issues.example.com/', { groupId: MANAGED_GROUP }),
    ];
    const bindings = { mail: bound('mail', 1), news: bound('news', 2), issues: bound('issues', 3) };
    const result = plan({ bindings, tabs });
    expect(result).toMatchObject({ create: [], close: [], release: [] });
    expect(result.bindings.mail?.tabId).toBe(1);
  });

  test('a tab that navigated away keeps its binding and its page', () => {
    const tabs = [tab(1, 'https://mail.example.com/thread/7', { pinned: true })];
    const bindings = { mail: bound('mail', 1, { lastUrl: 'https://mail.example.com/thread/7' }) };
    const result = plan({ bindings, tabs });
    expect(result.bindings.mail).toMatchObject({
      tabId: 1,
      lastUrl: 'https://mail.example.com/thread/7',
    });
    expect(result.close).toEqual([]);
  });

  test('a closed tab reopens on its bookmark URL', () => {
    const bindings = { mail: bound('mail', 9, { lastUrl: 'https://mail.example.com/thread/7' }) };
    const result = plan({ bindings, tabs: [] });
    expect(result.create).toContain('mail');
    expect(result.bindings.mail).toMatchObject({
      tabId: null,
      lastUrl: 'https://mail.example.com/',
    });
  });

  test('an existing pinned tab on the bookmark URL is adopted, not duplicated', () => {
    const tabs = [tab(1, 'https://mail.example.com/', { pinned: true })];
    const result = plan({ tabs });
    expect(result.bindings.mail?.tabId).toBe(1);
    expect(result.create).not.toContain('mail');
  });

  test('ordinary tabs are never adopted or closed', () => {
    const tabs = [
      tab(1, 'https://mail.example.com/'),
      tab(2, 'https://issues.example.com/', { groupId: OWN_GROUP }),
    ];
    const result = plan({ tabs });
    expect(result.create).toEqual(['mail', 'news', 'issues']);
    expect(result.close).toEqual([]);
  });

  test('after a restart the restored tab on its last page wins over the bookmark URL', () => {
    const tabs = [
      tab(10, 'https://mail.example.com/', { pinned: true }),
      tab(11, 'https://mail.example.com/thread/7', { pinned: true }),
    ];
    const bindings = {
      mail: bound('mail', null, { lastUrl: 'https://mail.example.com/thread/7' }),
    };
    const result = plan({ bindings, tabs, withinRestoreGrace: true });
    expect(result.bindings.mail?.tabId).toBe(11);
    expect(result.close).toEqual([10]);
  });

  test('a late-restored copy on the pre-restart page is closed while the restore grace lasts', () => {
    const tabs = [
      tab(1, 'https://mail.example.com/', { pinned: true }),
      tab(2, 'https://mail.example.com/thread/7', { pinned: true }),
    ];
    const bindings = {
      mail: bound('mail', 1, { restoreUrl: 'https://mail.example.com/thread/7' }),
    };
    expect(plan({ bindings, tabs, withinRestoreGrace: true }).close).toEqual([2]);
    // Afterwards the same tab is just one of your own pins.
    expect(plan({ bindings, tabs, withinRestoreGrace: false }).close).toEqual([]);
  });

  test('a stray copy inside a managed group is closed', () => {
    const tabs = [
      tab(3, 'https://issues.example.com/', { groupId: MANAGED_GROUP }),
      tab(4, 'https://issues.example.com/', { groupId: MANAGED_GROUP }),
    ];
    const bindings = { issues: bound('issues', 3) };
    const result = plan({ bindings, tabs });
    expect(result.close).toEqual([4]);
  });

  test('a tab can never be bound to two bookmarks', () => {
    const tabs = [tab(1, 'https://mail.example.com/', { pinned: true })];
    const bindings = { mail: bound('mail', 1), news: bound('news', 1) };
    const result = plan({ bindings, tabs });
    expect(result.bindings.mail?.tabId).toBe(1);
    expect(result.bindings.news?.tabId).toBe(null);
    expect(result.create).toEqual(['news', 'issues']);
  });

  test('two bookmarks of one URL each get their own tab', () => {
    const twin: Layout = {
      pins: [
        { bookmarkId: 'a', url: 'https://x.example.com/', title: 'A', folderId: null },
        { bookmarkId: 'b', url: 'https://x.example.com/', title: 'B', folderId: null },
      ],
      folders: [],
    };
    const tabs = [tab(1, 'https://x.example.com/', { pinned: true })];
    const result = planBindings({
      layout: twin,
      bindings: {},
      windowId: W,
      tabs,
      managedGroupIds: new Set(),
      withinRestoreGrace: false,
    });
    expect(result.bindings.a?.tabId).toBe(1);
    expect(result.create).toEqual(['b']);
    expect(result.close).toEqual([]);
  });

  test('a tab dragged into another window is released and reopened in the pinned window', () => {
    const tabs = [tab(1, 'https://mail.example.com/x', { windowId: OTHER, pinned: true })];
    const bindings = { mail: bound('mail', 1, { lastUrl: 'https://mail.example.com/x' }) };
    const result = plan({ bindings, tabs });
    expect(result.release).toEqual([1]);
    expect(result.create).toContain('mail');
    expect(result.bindings.mail?.lastUrl).toBe('https://mail.example.com/');
  });

  test('tabs in the second window are never adopted', () => {
    const tabs = [tab(1, 'https://mail.example.com/', { windowId: OTHER, pinned: true })];
    const result = plan({ tabs });
    expect(result.create).toContain('mail');
    expect(result.close).toEqual([]);
    expect(result.release).toEqual([]);
  });

  test("a deleted bookmark's tab is closed", () => {
    const tabs = [tab(7, 'https://gone.example.com/', { pinned: true })];
    const bindings = {
      gone: {
        tabId: 7,
        url: 'https://gone.example.com/',
        title: 'Gone',
        folderId: null,
        lastUrl: 'https://gone.example.com/',
      },
    };
    const result = plan({ bindings, tabs });
    expect(result.close).toEqual([7]);
    expect(result.bindings.gone).toBeUndefined();
  });

  test("a deleted bookmark's tab is reused by a new bookmark for the same page", () => {
    const tabs = [tab(7, 'https://mail.example.com/', { pinned: true })];
    const bindings = {
      old: {
        tabId: 7,
        url: 'https://mail.example.com/',
        title: 'Old',
        folderId: null,
        lastUrl: 'https://mail.example.com/',
      },
    };
    const result = plan({ bindings, tabs });
    expect(result.bindings.mail?.tabId).toBe(7);
    expect(result.close).toEqual([]);
  });

  test('a changed bookmark URL updates the target without touching the tab', () => {
    const tabs = [tab(1, 'https://mail.example.com/old', { pinned: true })];
    const bindings = {
      mail: bound('mail', 1, {
        url: 'https://mail.example.com/old',
        lastUrl: 'https://mail.example.com/old',
      }),
    };
    const result = plan({ bindings, tabs });
    expect(result.bindings.mail).toMatchObject({
      tabId: 1,
      url: 'https://mail.example.com/',
      lastUrl: 'https://mail.example.com/old',
    });
    expect(result.close).toEqual([]);
  });
});

describe('pickRestoredWindow', () => {
  test('the window holding most of the pinned pages wins', () => {
    const tabs = [
      tab(1, 'https://mail.example.com/', { windowId: 1, pinned: true }),
      tab(2, 'https://mail.example.com/', { windowId: 2, pinned: true }),
      tab(3, 'https://issues.example.com/', { windowId: 2, groupId: MANAGED_GROUP }),
      tab(4, 'https://news.example.com/', { windowId: 3 }),
    ];
    expect(
      pickRestoredWindow({
        bindings: {},
        layout,
        tabs,
        isManagedGroup: (id) => id === MANAGED_GROUP,
        windowIds: [1, 2, 3],
      }),
    ).toBe(2);
  });

  test('no match picks nothing', () => {
    expect(
      pickRestoredWindow({
        bindings: {},
        layout,
        tabs: [],
        isManagedGroup: () => false,
        windowIds: [1],
      }),
    ).toBe(null);
  });
});
