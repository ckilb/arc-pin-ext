/**
 * Site identity with the public suffix list: `mail.google.com` and
 * `accounts.google.com` are one site, `a.github.io` and `b.github.io` are two.
 */

import { getDomain } from 'tldts';
import { parseUrl } from './url.ts';

/** Registrable domain plus port; IPs and single-label hosts are their own site. */
export function siteKey(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || url.hostname === '') return null;
  const host = url.hostname.toLowerCase();
  const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
  return `${domain}:${url.port}`;
}

export function sameSite(a: unknown, b: unknown): boolean {
  const left = siteKey(a);
  return left !== null && left === siteKey(b);
}
