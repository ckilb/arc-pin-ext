/**
 * "Add pin": the toolbar popup on a tab that is not managed. On a managed tab the
 * worker returns it to its bookmark instead, and the popup closes itself.
 */

import type { PopupInfo, Reply, Request } from '../lib/types.ts';

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing element #${id}`);
  return found;
}

const form = element('form', HTMLFormElement);
const name = element('name', HTMLInputElement);
const folder = element('folder', HTMLSelectElement);
const error = element('error', HTMLParagraphElement);
const save = element('save', HTMLButtonElement);
const cancel = element('cancel', HTMLButtonElement);
const unpinnable = element('unpinnable', HTMLParagraphElement);

function send<T>(message: Request): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function main(): Promise<void> {
  // `?tabId=` lets the end-to-end tests open the popup in a tab.
  const fromQuery = Number(new URLSearchParams(window.location.search).get('tabId'));
  const tabId =
    fromQuery > 0
      ? fromQuery
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) {
    window.close();
    return;
  }

  const info = await send<PopupInfo>({ type: 'popupOpened', tabId });
  if (info.managed) {
    window.close();
    return;
  }
  if (!info.pinnable) {
    unpinnable.hidden = false;
    return;
  }

  name.value = info.title || info.url;
  for (const option of info.folders) {
    const label = option.depth === 0 ? 'Pinned tab (no group)' : option.title || '(unnamed)';
    folder.add(new Option(`${'   '.repeat(Math.max(0, option.depth - 1))}${label}`, option.id));
  }
  form.hidden = false;
  name.select();

  cancel.addEventListener('click', () => window.close());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.disabled = true;
    error.hidden = true;
    void send<Reply>({ type: 'addPin', tabId, title: name.value, parentId: folder.value }).then(
      (reply) => {
        if (reply.ok) {
          window.close();
          return;
        }
        error.textContent = reply.message ?? 'Could not add the pin.';
        error.hidden = false;
        save.disabled = false;
      },
    );
  });
}

void main();
