/**
 * Fixture pages for the browser run. The browser maps every `*.test` host to this
 * server, so three hosts are available without DNS:
 *
 *   home.site.test   the bookmarks
 *   sub.site.test    another subdomain of the same site
 *   other.test       a different site
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  port: number;
  url: (host: string, path: string) => string;
  hits: (host: string, path: string) => number;
  close: () => Promise<void>;
}

export async function startServer(): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  let port = 0;
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;

  const server = http.createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? '';
    const path = request.url ?? '/';
    hits.set(`${host}${path}`, (hits.get(`${host}${path}`) ?? 0) + 1);

    if (path.startsWith('/favicon')) {
      response.writeHead(204).end();
      return;
    }
    if (path === '/redirect-away') {
      response.writeHead(302, { Location: url('other.test', '/page/landed') }).end();
      return;
    }

    const name = path.replace(/^\/page\//, '').replace(/[?#].*$/, '');
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Page ${name}</title></head>
<body style="font:16px system-ui;padding:24px;min-height:100vh">
  <h1 id="heading">${host} ${path}</h1>
  <p id="text">Some text to select with three clicks.</p>
  <p><a id="same" href="/page/deeper">same host</a></p>
  <p><a id="sub" href="${url('sub.site.test', '/page/sub')}">same site, other subdomain</a></p>
  <p><a id="cross" href="${url('other.test', '/page/crossed')}">other site</a></p>
  <p><a id="redirect" href="/redirect-away">redirects to another site</a></p>
  <p><a id="hash" href="#section">hash</a></p>
  <p><button id="jsnav" onclick="location.href='${url('other.test', '/page/scripted')}'">scripted navigation</button></p>
</body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    port,
    url,
    hits: (host, path) => hits.get(`${host}${path}`) ?? 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
