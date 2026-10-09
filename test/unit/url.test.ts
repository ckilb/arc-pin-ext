import { describe, expect, test } from 'vitest';
import { certainlyDifferentSite, isWebUrl, normalizeUrl, sameUrl } from '../../src/lib/url.ts';
import { sameSite, siteKey } from '../../src/lib/site.ts';

describe('url', () => {
  test('only http and https are web URLs', () => {
    expect(isWebUrl('https://example.com')).toBe(true);
    expect(isWebUrl('http://localhost:8080/x')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('chrome://settings')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });

  test('sameUrl normalises but keeps the hash', () => {
    expect(sameUrl('https://example.com', 'https://example.com/')).toBe(true);
    expect(sameUrl('https://EXAMPLE.com/a', 'https://example.com/a')).toBe(true);
    expect(sameUrl('https://mail.example.com/#inbox', 'https://mail.example.com/#inbox/123')).toBe(
      false,
    );
    expect(sameUrl('https://example.com/?a=1', 'https://example.com/?a=2')).toBe(false);
    expect(sameUrl('', '')).toBe(false);
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  test('certainlyDifferentSite never claims a difference for one site', () => {
    expect(certainlyDifferentSite('https://a.example.com', 'https://b.example.com')).toBe(false);
    expect(certainlyDifferentSite('https://example.com', 'https://www.example.com/x')).toBe(false);
    expect(certainlyDifferentSite('https://a.github.io', 'https://b.github.io')).toBe(false);
    expect(certainlyDifferentSite('https://example.com', 'https://example.org')).toBe(true);
    expect(certainlyDifferentSite('http://localhost:1', 'http://localhost:2')).toBe(true);
    expect(certainlyDifferentSite('http://localhost:1', 'http://127.0.0.1:1')).toBe(true);
    expect(certainlyDifferentSite('http://10.0.0.1', 'http://10.0.0.2')).toBe(true);
  });
});

describe('site', () => {
  test('subdomains of one registrable domain are one site', () => {
    expect(sameSite('https://mail.google.com/x', 'https://accounts.google.com/y')).toBe(true);
    expect(sameSite('https://github.com', 'https://gist.github.com')).toBe(true);
    expect(sameSite('http://example.com', 'https://example.com')).toBe(true);
    expect(sameSite('https://shop.example.co.uk', 'https://www.example.co.uk')).toBe(true);
  });

  test('different registrable domains, private suffixes and ports are different sites', () => {
    expect(sameSite('https://gmail.com', 'https://mail.google.com')).toBe(false);
    expect(sameSite('https://one.co.uk', 'https://two.co.uk')).toBe(false);
    expect(sameSite('https://a.github.io', 'https://b.github.io')).toBe(false);
    expect(sameSite('http://localhost:3000', 'http://localhost:4000')).toBe(false);
    expect(sameSite('http://localhost:3000', 'http://127.0.0.1:3000')).toBe(false);
  });

  test('siteKey falls back to the host for IPs and single labels', () => {
    expect(siteKey('http://127.0.0.1:8080/')).toBe('127.0.0.1:8080');
    expect(siteKey('http://localhost/')).toBe('localhost:');
    expect(siteKey('https://a.b.site.test/')).toBe('site.test:');
    expect(siteKey('nonsense')).toBe(null);
  });
});
