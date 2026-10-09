// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://mail.example.com/"}

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TabView } from '../../src/lib/types.ts';

const HOME = 'https://mail.example.com/';

interface Stub {
  id: string | undefined;
  sent: unknown[];
  reply: TabView | null;
  listener: ((message: unknown) => void) | null;
}

const stub: Stub = { id: 'ext', sent: [], reply: null, listener: null };

function managedView(extra: Partial<TabView> = {}): TabView {
  return {
    managed: true,
    bookmarkUrl: HOME,
    bookmarkTitle: 'Mail',
    tripleClick: false,
    pageTitleInTitle: false,
    ...extra,
  };
}

/** Let the page's microtasks (mutation observers, message replies) run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function load(view: TabView | null): Promise<void> {
  stub.reply = view;
  vi.resetModules();
  await import('../../src/content/content.ts');
  await tick();
}

function push(view: TabView): Promise<void> {
  stub.listener?.({ type: 'view', view });
  return tick();
}

/**
 * Click like a person and report whether the content script took the click over.
 * The test's own listener runs last and stops happy-dom from following the link.
 */
function click(
  target: EventTarget,
  init: MouseEventInit = {},
  trusted = true,
): { defaultPrevented: boolean } {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  Object.defineProperty(event, 'isTrusted', { value: trusted });
  let prevented = false;
  const last = (it: Event) => {
    prevented = it.defaultPrevented;
    it.preventDefault();
  };
  window.addEventListener('click', last);
  target.dispatchEvent(event);
  window.removeEventListener('click', last);
  return { defaultPrevented: prevented };
}

function link(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  anchor.textContent = 'link';
  document.body.append(anchor);
  return anchor;
}

beforeEach(() => {
  stub.id = 'ext';
  stub.sent = [];
  stub.listener = null;
  window.history.replaceState(null, '', HOME);
  document.head.innerHTML = '<title>Inbox (3)</title>';
  document.body.innerHTML = '<p id="text">text</p>';
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      get id() {
        return stub.id;
      },
      sendMessage: async (message: { type: string }) => {
        if (stub.id === undefined) throw new Error('Extension context invalidated.');
        stub.sent.push(message);
        return message.type === 'hello' ? stub.reply : { ok: true };
      },
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          stub.listener = listener;
        },
        removeListener: () => {
          stub.listener = null;
        },
      },
    },
  };
});

afterEach(async () => {
  // Orphan this instance, as an extension update would, so the next test starts clean.
  stub.id = undefined;
  document.title = `${document.title} `;
  await tick();
});

describe('titles', () => {
  test('a managed tab on its bookmark shows the bookmark name', async () => {
    await load(managedView());
    expect(document.title).toBe('Mail');
  });

  test('away from the bookmark it shows "/ Name", optionally with the page title', async () => {
    window.history.replaceState(null, '', `${HOME}thread/7`);
    await load(managedView());
    expect(document.title).toBe('/ Mail');
    await push(managedView({ pageTitleInTitle: true }));
    expect(document.title).toBe('/ Mail / Inbox (3)');
  });

  test("the page's own title changes are kept underneath", async () => {
    window.history.replaceState(null, '', `${HOME}thread/7`);
    await load(managedView({ pageTitleInTitle: true }));
    document.title = 'Inbox (4)';
    await tick();
    expect(document.title).toBe('/ Mail / Inbox (4)');
  });

  test('a route change is noticed', async () => {
    await load(managedView());
    window.history.replaceState(null, '', `${HOME}#settings`);
    window.dispatchEvent(new Event('hashchange'));
    await tick();
    expect(document.title).toBe('/ Mail');
  });

  test('an ordinary tab keeps its title, and a released tab gets it back', async () => {
    await load({ ...managedView(), managed: false, bookmarkTitle: null, bookmarkUrl: null });
    expect(document.title).toBe('Inbox (3)');
    await push(managedView());
    expect(document.title).toBe('Mail');
    await push({ ...managedView(), managed: false });
    expect(document.title).toBe('Inbox (3)');
  });
});

describe('triple-click', () => {
  test('returns a drifted pin when enabled', async () => {
    window.history.replaceState(null, '', `${HOME}thread/7`);
    await load(managedView({ tripleClick: true }));
    click(document.getElementById('text')!, { detail: 3 });
    expect(stub.sent).toContainEqual({ type: 'goHome' });
  });

  test('does nothing when off, at home, for fewer clicks, or for synthetic clicks', async () => {
    window.history.replaceState(null, '', `${HOME}thread/7`);
    await load(managedView());
    const text = document.getElementById('text')!;
    click(text, { detail: 3 });
    await push(managedView({ tripleClick: true }));
    click(text, { detail: 2 });
    click(text, { detail: 3 }, false);
    window.history.replaceState(null, '', HOME);
    click(text, { detail: 3 });
    expect(stub.sent).not.toContainEqual({ type: 'goHome' });
  });
});

describe('links to other sites', () => {
  test('are opened in a new tab instead of loading in the pin', async () => {
    await load(managedView());
    const event = click(link('https://other.test/page'));
    expect(event.defaultPrevented).toBe(true);
    expect(stub.sent).toContainEqual({ type: 'openSplit', url: 'https://other.test/page' });
  });

  test('stay in the pin when same-site, modified, targeted, downloads, or handled by the page', async () => {
    await load(managedView());
    const handled = link('https://other.test/handled');
    handled.addEventListener('click', (event) => event.preventDefault());
    const events = [
      click(link('https://accounts.example.com/login')),
      click(link('https://other.test/a'), { ctrlKey: true }),
      click(link('https://other.test/b'), { button: 1 }),
      click(link('https://other.test/c', { target: '_blank' })),
      click(link('https://other.test/d', { download: '' })),
      click(link('mailto:someone@example.com')),
      click(handled),
      click(document.getElementById('text')!),
    ];
    expect(events.slice(0, 6).map((event) => event.defaultPrevented)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      stub.sent.filter((message) => (message as { type: string }).type === 'openSplit'),
    ).toEqual([]);
  });

  test('are left alone in ordinary tabs', async () => {
    await load(null);
    expect(click(link('https://other.test/page')).defaultPrevented).toBe(false);
  });
});

describe('after an extension update', () => {
  test('an orphaned copy restores the title and stops listening', async () => {
    await load(managedView());
    expect(document.title).toBe('Mail');
    stub.id = undefined;
    document.title = 'Inbox (5)';
    await tick();
    expect(document.title).toBe('Inbox (5)');
    expect(click(link('https://other.test/page')).defaultPrevented).toBe(false);
  });

  test('a second copy in the same page does not start', async () => {
    await load(managedView());
    const sent = stub.sent.length;
    vi.resetModules();
    await import('../../src/content/content.ts');
    await tick();
    expect(stub.sent.length).toBe(sent);
  });

  test('an orphan sending a message tears itself down', async () => {
    window.history.replaceState(null, '', `${HOME}thread/7`);
    await load(managedView({ tripleClick: true }));
    Object.defineProperty(stub, 'id', { value: undefined, writable: true });
    click(document.getElementById('text')!, { detail: 3 });
    expect(stub.sent).not.toContainEqual({ type: 'goHome' });
  });
});
