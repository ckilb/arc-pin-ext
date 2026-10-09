/**
 * URL helpers without the public suffix list, so the content script stays small.
 */

export function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Only web pages can be pinned; bookmarklets, chrome:// and file:// are skipped. */
export function isWebUrl(value: unknown): value is string {
  const url = parseUrl(value);
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:');
}

/** The serialised form Chrome reports for a URL, or null when it does not parse. */
export function normalizeUrl(value: unknown): string | null {
  return parseUrl(value)?.href ?? null;
}

/**
 * Exact page identity, including the hash: single-page apps route with `#`, so a tab
 * on `#inbox/123` is not on a bookmark for `#inbox`.
 */
export function sameUrl(a: unknown, b: unknown): boolean {
  const left = normalizeUrl(a);
  return left !== null && left === normalizeUrl(b);
}

/**
 * True only when two URLs are certainly on different sites, without knowing public
 * suffixes. A registrable domain has at least two labels, so two hosts on the same
 * site always share their last two labels (and their port). The reverse is not
 * true — `a.github.io` and `b.github.io` share them but are different sites — so a
 * `false` here means "maybe the same site", and the caller must fall back to the
 * precise check in `site.ts`.
 */
export function certainlyDifferentSite(a: unknown, b: unknown): boolean {
  const left = parseUrl(a);
  const right = parseUrl(b);
  if (!left || !right) return false;
  if (left.port !== right.port) return true;
  return lastTwoLabels(left.hostname) !== lastTwoLabels(right.hostname);
}

function lastTwoLabels(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return host;
  return host.split('.').slice(-2).join('.');
}
