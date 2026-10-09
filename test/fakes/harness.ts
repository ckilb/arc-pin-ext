/**
 * Runs the real service worker against the fake browser.
 */

import { vi } from 'vitest';
import { FakeBrowser } from './chrome.ts';

export { FakeBrowser };

/** Run every pending timer and event until the fake browser is quiet. */
export async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await vi.runAllTimersAsync();
}

/** Load (or wake) the worker: a fresh module instance against `browser`. */
export async function startWorker(
  browser: FakeBrowser,
  installed?: chrome.runtime.InstalledDetails['reason'],
): Promise<void> {
  vi.resetModules();
  browser.resetListeners();
  (globalThis as { chrome?: typeof chrome }).chrome = browser.chrome;
  await import('../../src/background/index.ts');
  if (installed) browser.events.runtime.onInstalled.emit({ reason: installed });
  await flush();
}

/** A message from an extension page or content script, answered once the worker is done. */
export async function send<T = unknown>(
  browser: FakeBrowser,
  message: unknown,
  sender: chrome.runtime.MessageSender = {},
): Promise<T> {
  const reply = (browser.chrome.runtime.sendMessage as (m: unknown, s: unknown) => Promise<T>)(
    message,
    sender,
  );
  await flush();
  return reply;
}

export function senderTab(browser: FakeBrowser, tabId: number): chrome.runtime.MessageSender {
  const tab = browser.tabs.get(tabId);
  if (!tab) throw new Error(`no tab ${tabId}`);
  return { tab: browser.snapshot(tab) };
}

export interface StoredState {
  windowId: number | null;
  bindings: Record<
    string,
    {
      tabId: number | null;
      url: string;
      title: string;
      folderId: string | null;
      lastUrl: string;
      restoreUrl?: string;
    }
  >;
  groups: Record<string, number>;
  bootAt: number;
}

export function sessionState(browser: FakeBrowser): StoredState {
  return browser.storage.session.data.state as StoredState;
}

export function tabOf(browser: FakeBrowser, bookmarkId: string): number {
  const tabId = sessionState(browser).bindings[bookmarkId]?.tabId;
  if (typeof tabId !== 'number') throw new Error(`bookmark ${bookmarkId} has no tab`);
  return tabId;
}
