/**
 * The tab title of a managed tab: the bookmark name on the bookmark URL, and
 * `/ Name` (optionally `/ Name / Page title`) once it has navigated elsewhere.
 */
export function managedTitle(input: {
  bookmarkTitle: string;
  atHome: boolean;
  pageTitle: string;
  showPageTitle: boolean;
}): string {
  const { bookmarkTitle, atHome, pageTitle, showPageTitle } = input;
  if (atHome) return bookmarkTitle;
  if (showPageTitle && pageTitle.trim() !== '') return `/ ${bookmarkTitle} / ${pageTitle}`;
  return `/ ${bookmarkTitle}`;
}
