import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { test } from 'vitest';
import { applyPublicShellHeaders, applyPublicShellLastModified, sendPublicShellBody } from '../../../src/transport/public-shell-routes.js';

test('only explicit digest embeds may be framed, for GET and HEAD', async () => {
  const app = Fastify();
  for (const path of ['/reports', '/reports/:slug', '/reports/:slug/issues/:editionId', '/u/:handle', '/share/:slug']) {
    app.route({ method: ['GET', 'HEAD'], url: path, handler: async (request, reply) => {
      reply.header('X-Frame-Options', 'DENY');
      applyPublicShellHeaders(reply);
      applyPublicShellLastModified(reply, '2026-09-01T00:00:00Z');
      return sendPublicShellBody(reply, request.method, 200, '<html>fixture</html>');
    } });
  }
  try {
    for (const method of ['GET', 'HEAD'] as const) {
      for (const [url, allowed] of [
        ['/reports/weekly?embed=1', true], ['/reports/weekly/issues/edition-1?embed=1&bg=%23ffffff', true],
        ['/reports/weekly', false], ['/reports/weekly/issues/edition-1?embed=0', false],
        ['/reports/weekly?embed=0&embed=1', false], ['/reports?embed=1', false],
        ['/u/reader?embed=1', false], ['/share/collection?embed=1', true],
      ] as const) {
        const response = await app.inject({ method, url });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['x-frame-options'], allowed ? undefined : 'DENY', url);
        assert.ok(String(response.headers['content-security-policy']).includes(allowed ? 'frame-ancestors *' : "frame-ancestors 'none'"), url);
        assert.ok(String(response.headers['content-security-policy']).includes("script-src 'self'"));
        assert.equal(response.headers['last-modified'], undefined);
        const cached = await app.inject({ method, url, headers: { 'if-none-match': String(response.headers.etag) } });
        assert.equal(cached.statusCode, 304);
        assert.equal(cached.body, '');
        assert.equal(cached.headers['content-security-policy'], response.headers['content-security-policy']);
      }
    }
  } finally { await app.close(); }
});
