import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

/**
 * Deployment ingress contract for the self-hosted stack (deploy/compose.yaml).
 * Know-N enforced the same promise on its nginx templates; here every Caddy
 * variant must route the protocol, API, MCP and OAuth discovery surfaces to
 * the server before the SPA catch-all, so a COLP client can never receive
 * index.html where it expects a Manifest, a Problem document or an MCP reply.
 */
const CADDYFILES = ['Caddyfile.tls-auto', 'Caddyfile.tls-internal', 'Caddyfile.http'] as const;
const DEPLOY = new URL('../../../../../deploy/', import.meta.url);

// Every server-owned public prefix must be covered by the proxied matcher.
const PROXIED_PREFIXES = ['/api/*', '/collections/*', '/.well-known/*', '/colp/*', '/health', '/ready'];
const SERVER_PATHS = [
  '/.well-known/collection-protocol',
  '/.well-known/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/collections/-/mcp',
  '/colp/v0.1/sync/collections',
  '/api/health',
];

function matcherCovers(prefixes: string[], path: string): boolean {
  return prefixes.some((prefix) => prefix.endsWith('*')
    ? path.startsWith(prefix.slice(0, -1))
    : path === prefix);
}

describe('Caddy ingress keeps COLP, MCP and OAuth discovery on the server', () => {
  for (const name of CADDYFILES) {
    test(`${name} proxies protocol surfaces before the SPA catch-all`, async () => {
      const source = await readFile(new URL(name, DEPLOY), 'utf8');
      const matcher = source.match(/@proxied path ([^\n]+)/u);
      assert.ok(matcher?.[1], 'a named @proxied path matcher is declared');
      const prefixes = matcher[1].trim().split(/\s+/u);
      for (const prefix of PROXIED_PREFIXES) assert.ok(prefixes.includes(prefix), prefix);
      for (const path of SERVER_PATHS) assert.ok(matcherCovers(prefixes, path), path);

      const proxiedIndex = source.indexOf('handle @proxied {');
      const spaIndex = source.indexOf('\n\thandle {');
      assert.ok(proxiedIndex >= 0 && spaIndex > proxiedIndex,
        'the proxied handle must be declared before the SPA catch-all');
      const proxied = source.slice(proxiedIndex, spaIndex);
      assert.match(proxied, /reverse_proxy server:3000/u);
      assert.match(proxied, /header_up X-Forwarded-Proto (https|http)\b/u);
      assert.doesNotMatch(proxied, /try_files|file_server/u,
        'proxied surfaces must never fall back to static files');

      const spa = source.slice(spaIndex);
      assert.match(spa, /try_files \{path\} \/index\.html/u);
      assert.match(spa, /file_server/u);
      assert.doesNotMatch(spa, /reverse_proxy/u);
    });
  }

  test('TLS variants assert https and the plain variant asserts http upstream', async () => {
    for (const name of CADDYFILES) {
      const source = await readFile(new URL(name, DEPLOY), 'utf8');
      const expected = name === 'Caddyfile.http' ? 'http' : 'https';
      assert.match(source, new RegExp(`header_up X-Forwarded-Proto ${expected}\\n`, 'u'), name);
    }
  });
});
