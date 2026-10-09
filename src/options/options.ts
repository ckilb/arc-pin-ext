/**
 * Options: the pin folder, Sync now, and the behaviour toggles.
 */

import { isFolder, type BookmarkNode } from '../lib/layout.ts';
import type { Request, Settings, SettingsInfo } from '../lib/types.ts';

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing element #${id}`);
  return found;
}

const path = element('folder-path', HTMLElement);
const count = element('pin-count', HTMLElement);
const change = element('change', HTMLButtonElement);
const sync = element('sync', HTMLButtonElement);
const picker = element('picker', HTMLElement);
const tree = element('tree', HTMLUListElement);
const toggles = {
  tripleClick: element('tripleClick', HTMLInputElement),
  pageTitleInTitle: element('pageTitleInTitle', HTMLInputElement),
  newTabsAtStart: element('newTabsAtStart', HTMLInputElement),
} satisfies Partial<Record<keyof Settings, HTMLInputElement>>;

let info: SettingsInfo | null = null;

function send(message: Request): Promise<SettingsInfo> {
  return chrome.runtime.sendMessage(message) as Promise<SettingsInfo>;
}

function render(next: SettingsInfo): void {
  info = next;
  path.textContent = next.folderPath || '(unnamed folder)';
  count.textContent = `${next.pinCount} open pin${next.pinCount === 1 ? '' : 's'}`;
  for (const [key, input] of Object.entries(toggles)) {
    input.checked = next.settings[key as keyof typeof toggles];
  }
  if (!picker.hidden) void renderTree();
}

function folderItem(node: BookmarkNode): HTMLLIElement {
  const item = document.createElement('li');
  item.setAttribute('role', 'treeitem');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = node.title || '(unnamed)';
  button.setAttribute('aria-current', String(node.id === info?.settings.rootId));
  button.addEventListener('click', () => {
    void send({ type: 'setSettings', patch: { rootId: node.id } }).then(render);
  });
  item.append(button);
  const children = (node.children ?? []).filter(isFolder);
  if (children.length > 0) {
    const list = document.createElement('ul');
    list.setAttribute('role', 'group');
    list.append(...children.map(folderItem));
    item.append(list);
  }
  return item;
}

async function renderTree(): Promise<void> {
  const [root] = await chrome.bookmarks.getTree();
  const tops = (root?.children ?? []).filter(isFolder);
  tree.replaceChildren(...tops.map(folderItem));
}

change.addEventListener('click', () => {
  picker.hidden = !picker.hidden;
  change.textContent = picker.hidden ? 'Change…' : 'Done';
  if (!picker.hidden) void renderTree();
});

sync.addEventListener('click', () => {
  sync.disabled = true;
  void send({ type: 'syncNow' })
    .then(render)
    .finally(() => {
      sync.disabled = false;
    });
});

for (const [key, input] of Object.entries(toggles)) {
  input.addEventListener('change', () => {
    void send({ type: 'setSettings', patch: { [key]: input.checked } }).then(render);
  });
}

void send({ type: 'getSettings' }).then(render);
