import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { test } from 'vitest';

const deploy = new URL('../../../../../deploy/', import.meta.url);
const entrypoint = fileURLToPath(new URL('caddy-entrypoint.sh', deploy));

function start(origin: string | undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'colp-caddy-entrypoint-'));
  try {
    writeFileSync(join(directory, 'caddy'), '#!/bin/sh\nprintf "%s\\n" "$COLP_TLS_SERVER_NAME" "$@"\n', { mode: 0o755 });
    return spawnSync('sh', [entrypoint], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        COLP_SERVER_ORIGIN: origin, COLP_TLS_SERVER_NAME: 'must-be-replaced' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([
  ['https://127.0.0.1', '127.0.0.1'],
  ['https://192.168.1.20:8443', '192.168.1.20'],
  ['https://colp.example.net', 'colp.example.net'],
  ['https://COLP.EXAMPLE.NET:8443/', 'colp.example.net'],
  ['https://localhost:18443', 'localhost'],
  ['https://[::1]', '::1'],
  ['https://[2001:DB8::1]:8443/', '2001:db8::1'],
  ['https://[::ffff:192.0.2.1]', '::ffff:192.0.2.1'],
])('TLS startup derives its certificate selection host from %s', (origin, hostname) => {
  const result = start(origin);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    hostname, 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
  ]);
});

test.each([
  undefined, '', 'http://127.0.0.1', 'https://', 'https://user:password@example.net',
  'https://example.net/path', 'https://example.net?query=1', 'https://example.net#fragment',
  'https://example.net:abc', 'https://2001:db8::1', 'https://[::1]extra',
  'https://example.net\\extra',
  'https://example.net\ndefault_sni attacker.test',
])('TLS startup rejects an invalid origin before invoking Caddy: %s', (origin) => {
  const result = start(origin);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /COLP_SERVER_ORIGIN must be an HTTPS origin/u);
});

test('both TLS Compose services derive SNI without an extra operator setting', () => {
  const compose = parse(readFileSync(new URL('compose.yaml', deploy), 'utf8')) as {
    services: Record<string, { command?: string[]; volumes: string[] }>;
  };
  for (const profile of ['tls-auto', 'tls-internal']) {
    const service = compose.services[`caddy-${profile}`]!;
    assert.deepEqual(service.command, ['/bin/sh', '/etc/caddy/colp-entrypoint.sh']);
    assert.ok(service.volumes.includes('./caddy-entrypoint.sh:/etc/caddy/colp-entrypoint.sh:ro'));
    const config = readFileSync(new URL(`Caddyfile.${profile}`, deploy), 'utf8');
    assert.match(config, /default_sni \{\$COLP_TLS_SERVER_NAME\}/u);
  }
  assert.equal(compose.services['caddy-http']!.command, undefined);
});

test.each(['http', 'tls-auto', 'tls-internal'])('SPA security policy is present in the %s deployment profile', profile => {
  const config = readFileSync(new URL(`Caddyfile.${profile}`, deploy), 'utf8');
  const policy = config.match(/Content-Security-Policy "([^"]+)"/u)?.[1];
  assert.ok(policy);
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'",
    "frame-ancestors 'none'", "base-uri 'self'", "connect-src 'self'"]) assert.ok(policy.includes(directive));
  assert.doesNotMatch(policy.match(/script-src[^;]*/u)?.[0] ?? '', /unsafe-inline|unsafe-eval|https:/u);
  assert.match(config, /X-Frame-Options "DENY"/u);
  assert.match(config, /X-Content-Type-Options "nosniff"/u);
  if (profile === 'http') assert.doesNotMatch(config, /Strict-Transport-Security/u);
  else assert.match(config, /Strict-Transport-Security "max-age=31536000"/u);
});
