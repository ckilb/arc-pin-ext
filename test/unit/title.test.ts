import { expect, test } from 'vitest';
import { managedTitle } from '../../src/lib/title.ts';

test('the bookmark name on the bookmark URL', () => {
  expect(
    managedTitle({
      bookmarkTitle: 'Mail',
      atHome: true,
      pageTitle: 'Inbox (3)',
      showPageTitle: true,
    }),
  ).toBe('Mail');
});

test('a slash once the tab has left the bookmark URL', () => {
  expect(
    managedTitle({
      bookmarkTitle: 'Mail',
      atHome: false,
      pageTitle: 'Re: hi',
      showPageTitle: false,
    }),
  ).toBe('/ Mail');
});

test('optionally the page title too', () => {
  expect(
    managedTitle({
      bookmarkTitle: 'Mail',
      atHome: false,
      pageTitle: 'Re: hi',
      showPageTitle: true,
    }),
  ).toBe('/ Mail / Re: hi');
  expect(
    managedTitle({ bookmarkTitle: 'Mail', atHome: false, pageTitle: '  ', showPageTitle: true }),
  ).toBe('/ Mail');
});
