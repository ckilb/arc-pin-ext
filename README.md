# Tab Pin 2

A Manifest V3 extension for Brave and Chromium that keeps a bookmark folder open as
pinned tabs and tab groups in **one** browser window. Bookmarks are the source of truth,
so your browser's bookmark sync carries the layout between machines.

Version 2 is a TypeScript rewrite of Tab Pin 1.x. Disable Tab Pin 1.x while this one is
loaded: both would manage the same tabs.

## Install

```sh
npm ci
npm run build
```

Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked** and select `dist/`. Choose the pin folder in the extension's options
(the bookmarks bar by default). Requires Chromium 127 or newer.

## Behaviour

**Layout.** Each http(s) bookmark directly in the pin folder becomes a native pinned tab.
Each subfolder becomes a tab group in bookmark order; deeper folders join the group they
sit in. Managed group titles start with an invisible marker (U+2063), so your own groups
with the same name are left alone. Bookmarklets and other schemes are skipped.

**One window.** The pins live in one window; other windows never get synced tabs.

- Closing the pinned window while another stays open moves the pins to the last-focused
  remaining window (after ~2 s, so quitting the browser does not trigger it). Your own
  tabs there are never taken over.
- Right-click the toolbar icon → **Make this the pinned window** moves the live tabs
  there, without reloading them.
- Dragging a managed tab to another window turns it into an ordinary tab there; the
  pinned window reopens the pin on its bookmark URL.

**Sync.** Bookmark changes, **Sync now** (options page or toolbar right-click), startup
and reopening a closed pin all sync. A bookmark owns at most one tab; before opening a
tab the sync adopts a matching pinned or managed-group tab, and leftover copies are
closed. Syncs never overlap, and bursts of events are merged into one.

- Closing a managed tab reopens it on its bookmark URL, in place, in the background.
- Deleting a bookmark (or switching folders) closes its tab. Editing a bookmark's URL
  changes where "return" and reopen go, without navigating the open tab. Renaming a
  bookmark or folder renames the tab or group. If the pin folder disappears, the
  bookmarks bar is used.
- Manual reordering is kept until the next sync. Unpinning or ungrouping a managed tab
  by hand is undone immediately.

**Restart.** The extension waits until the browser has finished restoring tabs
(1 s without new tabs, at most 10 s), then adopts the restored tabs, on whichever page
they were left, and only opens what is missing. A pin the session restores late is
closed as a copy within the first 30 s.

**Other sites.** In a managed tab, a link to a different site (registrable domain plus
port: `mail.google.com` and `accounts.google.com` are one site) opens in a new ordinary
tab instead. Redirects, form posts, reloads and back/forward stay in the tab, so sign-in
flows work. Navigations that cannot be intercepted before they load (typed URLs,
scripted navigation) are moved to a new tab after they commit, and the pin steps back.

**Return to the bookmark.** Click the toolbar icon on a managed tab: it returns to its
bookmark URL, or reloads it if it is already there. Optionally, **triple-click** a page
that has left its bookmark URL (off by default).

**Add a pin.** Click the toolbar icon on any other tab to open the **Add pin** dialog
(name and folder). In the pinned window, that very tab becomes the pin.

**Titles.** A managed tab is titled with its bookmark name. Away from the bookmark URL it
reads `/ Name`, or `/ Name / Page title` with the option enabled.

**New tabs.** In the pinned window, a tab opened from a managed group leaves the group.
New tabs open at the end, or right after the last tab group with **Open new tabs at the
start** enabled.

## Development

```sh
npm run build        # bundle into dist/ (rolldown)
npm run check        # format check, typecheck, unit tests with coverage, build
npm test             # unit tests; fails below 80% coverage
npm run test:e2e     # builds, then runs real Chromium with the unpacked extension
npm run package      # build and zip dist/ into release/ (does not run e2e)
```

The unit tests run the real worker against an in-memory `chrome.*` fake
(`test/fakes/chrome.ts`) that follows Chrome's tab strip rules, and the content script
and pages under happy-dom. The e2e run (`test/e2e/run.ts`) uses `playwright-core` with
Chromium from `~/.cache/ms-playwright` (or `TAB_PIN_BROWSER`), a temporary profile and
local fixture sites; `--headed` shows the browser. It is not part of `check` or
`package`.

## Source layout

| Path              | Responsibility                                                |
| ----------------- | ------------------------------------------------------------- |
| `src/lib/`        | Pure logic: layout, URLs and sites, titles, the binding plan  |
| `src/background/` | Service worker: events, the serialised sync, navigation rules |
| `src/content/`    | Titles, triple-click, taking over links to other sites        |
| `src/popup/`      | The **Add pin** dialog                                        |
| `src/options/`    | Pin folder, Sync now, settings                                |
| `public/`         | Manifest, HTML, CSS and icons copied into `dist/`             |
| `test/unit/`      | Vitest suites (lib, worker, content, pages)                   |
| `test/e2e/`       | Real-browser run and fixture server                           |

## License

[MIT](LICENSE)
