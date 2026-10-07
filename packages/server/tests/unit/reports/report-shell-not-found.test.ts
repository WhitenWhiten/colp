import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { test } from 'vitest';
import type { AppConfig } from '../../../src/bootstrap/config.js';
import type { SearchRateLimiter, SearchRateLimitSubject } from '../../../src/infrastructure/rate-limit/search-rate-limit-store.js';
import type { ReportUnitOfWork } from '../../../src/modules/reports/index.js';
import { registerPublicReportShellRoutes } from '../../../src/transport/product/report-public-shell-routes.js';

const SHELL = '<!doctype html><html><head><title>Know-N</title></head><body><div id="root"></div></body></html>';
const config = { reports: { publicEnabled: false } } as unknown as AppConfig;

test('R15-24: a missing digest renders the styled app shell with 404, not a bare page', async () => {
  const app = Fastify();
  registerPublicReportShellRoutes(app, {
    config,
    publicShell: { cache: { load: async () => ({ kind: 'ok', body: SHELL }) } },
  });
  try {
    for (const url of ['/reports/unknown', '/reports/unknown/issues/edition-1']) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      assert.equal(response.statusCode, 404, url);
      assert.match(String(response.headers['content-type']), /^text\/html/u);
      assert.equal(response.body, SHELL, url);
    }
  } finally { await app.close(); }
});

test('R15-24: without a readable shell the digest 404 falls back to the minimal page', async () => {
  const app = Fastify();
  registerPublicReportShellRoutes(app, {
    config,
    publicShell: { cache: { load: async () => ({ kind: 'unavailable' }) } },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/reports/unknown' });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /<h1>Digest not found<\/h1>/u);
  } finally { await app.close(); }
});

const HTML_URLS = ['/reports', '/reports/unknown', '/reports/unknown/issues/edition-1'] as const;
const MARKDOWN = { accept: 'text/markdown' };

function exploreLimiter(exhausted: boolean): { limiter: SearchRateLimiter; calls: SearchRateLimitSubject[] } {
  const calls: SearchRateLimitSubject[] = [];
  return {
    calls,
    limiter: {
      async consume(subject) {
        calls.push(subject);
        return exhausted
          ? { kind: 'denied', decision: { allowed: false, retryAfterSeconds: 30 } }
          : { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
      },
      readiness: () => ({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 }),
      policy: { anonymous: 'explore:anonymous:test', account: 'explore:account:test' },
      async close() {},
    },
  };
}

function shellCache(loads: { count: number }) {
  return {
    async load() {
      loads.count += 1;
      return { kind: 'ok' as const, body: SHELL };
    },
  };
}

test('U-12: a closed report surface does not charge Explore, including an exhausted budget', async () => {
  const explore = exploreLimiter(true);
  const loads = { count: 0 };
  const app = Fastify();
  registerPublicReportShellRoutes(app, {
    config,
    rateLimiter: explore.limiter,
    publicShell: { cache: shellCache(loads) },
  });
  const ip = '203.0.113.10';
  try {
    for (const url of HTML_URLS) {
      const get = await app.inject({ method: 'GET', url, remoteAddress: ip, headers: { accept: 'text/html' } });
      const head = await app.inject({ method: 'HEAD', url, remoteAddress: ip });
      assert.equal(get.statusCode, 404, url);
      assert.equal(head.statusCode, 404, url);
      assert.match(String(get.headers['content-type']), /^text\/html/u, url);
      assert.equal(get.body, SHELL, url);
      assert.equal(head.body, '', url);
      assert.equal(head.headers['content-length'], get.headers['content-length'], url);
      const markdownGet = await app.inject({ method: 'GET', url, remoteAddress: ip, headers: MARKDOWN });
      const markdownHead = await app.inject({ method: 'HEAD', url, remoteAddress: ip, headers: MARKDOWN });
      assert.equal(markdownGet.statusCode, 404, url);
      assert.equal(markdownHead.statusCode, 404, url);
      assert.match(String(markdownGet.headers['content-type']), /^text\/markdown/u, url);
      assert.match(markdownGet.body, /Digest not found/u, url);
      assert.equal(markdownHead.body, '', url);
    }
    const sitemapGet = await app.inject({ method: 'GET', url: '/sitemap-reports.xml', remoteAddress: ip });
    const sitemapHead = await app.inject({ method: 'HEAD', url: '/sitemap-reports.xml', remoteAddress: ip });
    assert.equal(sitemapGet.statusCode, 404);
    assert.equal(sitemapHead.statusCode, 404);
    assert.match(String(sitemapGet.headers['content-type']), /^application\/xml/u);
    assert.match(sitemapGet.body, /Not found/u);
    assert.equal(sitemapHead.body, '');
    assert.equal(explore.calls.length, 0);
    assert.equal(loads.count, HTML_URLS.length * 2);
  } finally { await app.close(); }
});

test('U-12: a spent closed-report shell ceiling still returns 404 and does not borrow Explore', async () => {
  const explore = exploreLimiter(true);
  const loads = { count: 0 };
  const app = Fastify();
  registerPublicReportShellRoutes(app, {
    config,
    rateLimiter: explore.limiter,
    publicShell: { cache: shellCache(loads) },
  });
  const spent = '203.0.113.20';
  const other = '203.0.113.21';
  try {
    const before = await app.inject({ method: 'GET', url: '/reports/unknown', remoteAddress: other });
    assert.equal(before.statusCode, 404);
    assert.equal(before.body, SHELL);
    let styled = 0;
    let blocked = false;
    for (let attempt = 0; attempt < 80 && !blocked; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/reports/unknown', remoteAddress: spent });
      assert.equal(response.statusCode, 404);
      assert.notEqual(response.statusCode, 429);
      if (response.body === SHELL) styled += 1;
      else {
        assert.match(response.body, /<h1>Digest not found<\/h1>/u);
        blocked = true;
      }
    }
    assert.equal(blocked, true);
    assert.ok(styled > 0 && styled < 80);
    const again = await app.inject({ method: 'HEAD', url: '/reports/unknown', remoteAddress: spent });
    assert.equal(again.statusCode, 404);
    assert.equal(again.body, '');
    assert.match(String(again.headers['content-type']), /^text\/html/u);
    const spared = await app.inject({ method: 'GET', url: '/reports/unknown', remoteAddress: other });
    assert.equal(spared.statusCode, 404);
    assert.equal(spared.body, SHELL);
    assert.equal(explore.calls.length, 0);
    assert.equal(loads.count, styled + 2);
  } finally { await app.close(); }
});

function enabledApp(limiter: SearchRateLimiter, loads: { count: number }): FastifyInstance {
  const app = Fastify();
  const unitOfWork = { execute: async () => { throw new Error('unused'); } } as unknown as ReportUnitOfWork;
  registerPublicReportShellRoutes(app, {
    config: { reports: { publicEnabled: true } } as unknown as AppConfig,
    rateLimiter: limiter,
    unitOfWork,
    publicShell: { cache: shellCache(loads) },
    reportCache: {
      async series() { return null; },
      async issue() { return null; },
      async directory() { throw new Error('directory unused'); },
    },
  });
  return app;
}

test('U-12: an enabled report surface still rate-limits, and HEAD has no body', async () => {
  const allowed = exploreLimiter(false);
  const allowedLoads = { count: 0 };
  const open = enabledApp(allowed.limiter, allowedLoads);
  const ip = '203.0.113.30';
  try {
    const htmlGet = await open.inject({ method: 'GET', url: '/reports/unknown', remoteAddress: ip });
    const htmlHead = await open.inject({ method: 'HEAD', url: '/reports/unknown', remoteAddress: ip });
    assert.equal(htmlGet.statusCode, 404);
    assert.equal(htmlGet.body, SHELL);
    assert.equal(htmlHead.statusCode, 404);
    assert.equal(htmlHead.body, '');
    assert.equal(htmlHead.headers['content-length'], htmlGet.headers['content-length']);
    const issueHead = await open.inject({
      method: 'HEAD', url: '/reports/unknown/issues/edition-1', remoteAddress: ip,
    });
    assert.equal(issueHead.statusCode, 404);
    assert.equal(issueHead.body, '');
    const markdownHead = await open.inject({
      method: 'HEAD', url: '/reports/unknown', remoteAddress: ip, headers: MARKDOWN,
    });
    assert.equal(markdownHead.statusCode, 404);
    assert.equal(markdownHead.body, '');
    assert.match(String(markdownHead.headers['content-type']), /^text\/markdown/u);
    assert.equal(allowed.calls.length, 4);
    assert.ok(allowed.calls.every((subject) => subject.family === 'anonymous'));
  } finally { await open.close(); }

  const exhausted = exploreLimiter(true);
  const exhaustedLoads = { count: 0 };
  const closed = enabledApp(exhausted.limiter, exhaustedLoads);
  try {
    for (const [method, url, headers] of [
      ['GET', '/reports', undefined],
      ['HEAD', '/reports', undefined],
      ['GET', '/reports/unknown', MARKDOWN],
      ['HEAD', '/sitemap-reports.xml', undefined],
    ] as const) {
      const response = await closed.inject({ method, url, remoteAddress: ip, headers });
      assert.equal(response.statusCode, 429, `${method} ${url}`);
      if (method === 'HEAD') assert.equal(response.body, '', url);
      else assert.equal((response.json() as { code: string }).code, 'rate_limited');
    }
    assert.equal(exhausted.calls.length, 4);
    assert.ok(exhausted.calls.every((subject) => subject.family === 'anonymous'));
    assert.equal(exhaustedLoads.count, 0);
  } finally { await closed.close(); }
});
