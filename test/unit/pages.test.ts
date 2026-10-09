// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PopupInfo, SettingsInfo } from '../../src/lib/types.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let sent: Array<{ type: string; [key: string]: unknown }> = [];
let answer: (message: { type: string }) => unknown = () => undefined;

/** Load a page's markup (without its script tag), then its script. */
async function open(page: 'popup/add' | 'options/options', search = ''): Promise<void> {
  const html = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'public', `${page}.html`),
    'utf8',
  );
  document.body.innerHTML =
    /<body>([\s\S]*)<\/body>/.exec(html)?.[1]?.replace(/<script[\s\S]*?<\/script>/, '') ?? '';
  window.history.replaceState(null, '', `/${page}.html${search}`);
  vi.resetModules();
  await import(page === 'popup/add' ? '../../src/popup/add.ts' : '../../src/options/options.ts');
  await tick();
  await tick();
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

beforeEach(() => {
  sent = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: { type: string }) => {
        sent.push(message);
        return answer(message);
      },
    },
    tabs: { query: async () => [{ id: 42 }] },
    bookmarks: {
      getTree: async () => [
        {
          id: '0',
          title: '',
          children: [
            {
              id: '1',
              title: 'Bookmarks bar',
              children: [
                { id: 'w', title: 'Work', children: [] },
                { id: 'b', title: 'Bm', url: 'https://x.test/' },
              ],
            },
            { id: '2', title: 'Other bookmarks', children: [] },
          ],
        },
      ],
    },
  };
  window.close = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Add pin popup', () => {
  const info: PopupInfo = {
    managed: false,
    title: 'Some page',
    url: 'https://x.test/',
    pinnable: true,
    folders: [
      { id: '1', title: 'Bookmarks bar', depth: 0 },
      { id: 'w', title: 'Work', depth: 1 },
      { id: 'o', title: 'Old', depth: 2 },
      { id: 'u', title: '', depth: 1 },
    ],
  };

  test('closes itself on a pinned tab (the worker returned it home)', async () => {
    answer = () => ({ managed: true });
    await open('popup/add');
    expect(sent[0]).toEqual({ type: 'popupOpened', tabId: 42 });
    expect(window.close).toHaveBeenCalled();
    expect($('form').hidden).toBe(true);
  });

  test('explains when a page cannot be pinned', async () => {
    answer = () => ({ ...info, pinnable: false });
    await open('popup/add');
    expect($('unpinnable').hidden).toBe(false);
    expect($('form').hidden).toBe(true);
  });

  test('a worker error while opening is shown instead of an unpinnable-page message', async () => {
    answer = () => ({ ok: false, message: 'Bookmarks unavailable.' });
    await open('popup/add');
    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('Bookmarks unavailable.');
    expect($('unpinnable').hidden).toBe(true);
  });

  test('offers the name and the folders, and saves into the chosen one', async () => {
    answer = (message) => (message.type === 'popupOpened' ? info : { ok: true });
    await open('popup/add', '?tabId=7');
    expect(sent[0]).toEqual({ type: 'popupOpened', tabId: 7 });
    expect($<HTMLInputElement>('name').value).toBe('Some page');
    const select = $<HTMLSelectElement>('folder');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Pinned tab (no group)',
      'Work',
      '   Old',
      '(unnamed)',
    ]);
    select.value = 'w';
    $<HTMLInputElement>('name').value = 'Mine';
    $<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(sent[1]).toEqual({ type: 'addPin', tabId: 7, title: 'Mine', parentId: 'w' });
    expect(window.close).toHaveBeenCalled();
  });

  test('shows why saving failed and lets you try again', async () => {
    answer = (message) => (message.type === 'popupOpened' ? info : { ok: false, message: 'Nope.' });
    await open('popup/add');
    $<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('Nope.');
    expect($<HTMLButtonElement>('save').disabled).toBe(false);
    answer = (message) => (message.type === 'popupOpened' ? info : { ok: false });
    $<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect($('error').textContent).toBe('Could not add the pin.');
  });

  test('a rejected save shows the error and allows a retry', async () => {
    answer = (message) =>
      message.type === 'popupOpened' ? info : Promise.reject(new Error('Worker unavailable.'));
    await open('popup/add');
    $<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('Worker unavailable.');
    expect($<HTMLButtonElement>('save').disabled).toBe(false);
  });

  test('cancel closes; a window without a tab closes at once', async () => {
    answer = () => ({ ...info, title: '' });
    await open('popup/add');
    expect($<HTMLInputElement>('name').value).toBe('https://x.test/');
    $('cancel').click();
    expect(window.close).toHaveBeenCalled();

    (globalThis as { chrome: { tabs: unknown } }).chrome.tabs = { query: async () => [] };
    sent = [];
    await open('popup/add');
    expect(sent).toEqual([]);
  });
});

describe('Options page', () => {
  const settingsInfo = (
    patch: Partial<SettingsInfo['settings']> = {},
    pinCount = 3,
  ): SettingsInfo => ({
    settings: {
      rootId: '1',
      tripleClick: false,
      pageTitleInTitle: false,
      newTabsAtStart: false,
      ...patch,
    },
    folderPath: 'Bookmarks bar',
    pinCount,
  });

  beforeEach(() => {
    let current = settingsInfo();
    answer = (message) => {
      if (message.type === 'setSettings') {
        const patch = (message as unknown as { patch: Partial<SettingsInfo['settings']> }).patch;
        current = {
          ...settingsInfo({ ...current.settings, ...patch }),
          folderPath: patch.rootId === 'w' ? 'Bookmarks bar / Work' : current.folderPath,
        };
      }
      return current;
    };
  });

  test('shows the folder, the pin count and the settings', async () => {
    await open('options/options');
    expect($('folder-path').textContent).toBe('Bookmarks bar');
    expect($('pin-count').textContent).toBe('3 open pins');
    expect($<HTMLInputElement>('tripleClick').checked).toBe(false);
  });

  test('a toggle saves its setting', async () => {
    await open('options/options');
    const toggle = $<HTMLInputElement>('tripleClick');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(sent.at(-1)).toEqual({ type: 'setSettings', patch: { tripleClick: true } });
    expect(toggle.checked).toBe(true);
  });

  test('the folder picker lists folders only and switches the pin folder', async () => {
    await open('options/options');
    $('change').click();
    await tick();
    expect($('picker').hidden).toBe(false);
    const buttons = [...$('tree').querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Bookmarks bar',
      'Work',
      'Other bookmarks',
    ]);
    expect(buttons[0]?.getAttribute('aria-current')).toBe('true');
    buttons[1]?.click();
    await tick();
    await tick();
    expect(sent.at(-1)).toEqual({ type: 'setSettings', patch: { rootId: 'w' } });
    expect($('folder-path').textContent).toBe('Bookmarks bar / Work');
    $('change').click();
    expect($('picker').hidden).toBe(true);
    expect($('change').textContent).toBe('Change…');
  });

  test('Sync now syncs and is disabled while it runs', async () => {
    await open('options/options');
    answer = () => settingsInfo({}, 1);
    const sync = $<HTMLButtonElement>('sync');
    sync.click();
    expect(sync.disabled).toBe(true);
    await tick();
    await tick();
    expect(sent.at(-1)).toEqual({ type: 'syncNow' });
    expect(sync.disabled).toBe(false);
    expect($('pin-count').textContent).toBe('1 open pin');
  });

  test('a worker error is displayed and Sync now can be retried', async () => {
    await open('options/options');
    answer = () => ({ ok: false, message: 'Bookmarks unavailable.' });
    const sync = $<HTMLButtonElement>('sync');
    sync.click();
    await tick();
    await tick();
    expect($('error').textContent).toBe('Bookmarks unavailable.');
    expect($('error').hidden).toBe(false);
    expect(sync.disabled).toBe(false);

    answer = () => settingsInfo();
    sync.click();
    await tick();
    await tick();
    expect($('error').hidden).toBe(true);
  });
});
