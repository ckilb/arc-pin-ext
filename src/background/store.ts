/**
 * Persistence. `storage.session` holds the working state: it survives the service
 * worker being stopped, and is empty after a browser or extension restart, which is
 * how a restart is recognised. Every write is mirrored to `storage.local` so the
 * bindings' last URLs outlive the browser and restored tabs can be adopted.
 */

import type { Binding, Settings, State } from '../lib/types.ts';

const STATE_KEY = 'state';
const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  rootId: '1',
  tripleClick: false,
  pageTitleInTitle: false,
  newTabsAtStart: false,
};

export function emptyState(): State {
  return { windowId: null, bindings: {}, groups: {}, bootAt: 0 };
}

function normalizeSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    rootId:
      typeof input.rootId === 'string' && input.rootId !== ''
        ? input.rootId
        : DEFAULT_SETTINGS.rootId,
    tripleClick: input.tripleClick === true,
    pageTitleInTitle: input.pageTitleInTitle === true,
    newTabsAtStart: input.newTabsAtStart === true,
  };
}

function normalizeBindings(raw: unknown): Record<string, Binding> {
  if (!raw || typeof raw !== 'object') return {};
  const bindings: Record<string, Binding> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const it = value as Partial<Binding> | null;
    if (!it || typeof it.url !== 'string' || typeof it.lastUrl !== 'string') continue;
    bindings[id] = {
      tabId: typeof it.tabId === 'number' ? it.tabId : null,
      url: it.url,
      title: typeof it.title === 'string' ? it.title : '',
      folderId: typeof it.folderId === 'string' ? it.folderId : null,
      lastUrl: it.lastUrl,
      ...(typeof it.restoreUrl === 'string' ? { restoreUrl: it.restoreUrl } : {}),
    };
  }
  return bindings;
}

function normalizeState(raw: unknown): State {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const groups: Record<string, number> = {};
  if (input.groups && typeof input.groups === 'object') {
    for (const [folderId, groupId] of Object.entries(input.groups)) {
      if (typeof groupId === 'number') groups[folderId] = groupId;
    }
  }
  return {
    windowId: typeof input.windowId === 'number' ? input.windowId : null,
    bindings: normalizeBindings(input.bindings),
    groups,
    bootAt: typeof input.bootAt === 'number' ? input.bootAt : 0,
  };
}

/** The working state, or null after a browser or extension restart. */
export async function loadSessionState(): Promise<State | null> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] ? normalizeState(stored[STATE_KEY]) : null;
}

export async function loadState(): Promise<State> {
  return (await loadSessionState()) ?? emptyState();
}

/** The state as it was when the browser last ran. Tab, window and group ids are stale. */
export async function loadPersistedState(): Promise<State> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY]);
}

export async function saveState(state: State): Promise<void> {
  // Sequential on purpose: two concurrent writes can settle out of order.
  await chrome.storage.session.set({ [STATE_KEY]: state });
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function bindingForTab(state: State, tabId: number | undefined): [string, Binding] | null {
  if (tabId === undefined) return null;
  for (const entry of Object.entries(state.bindings)) {
    if (entry[1].tabId === tabId) return entry;
  }
  return null;
}
