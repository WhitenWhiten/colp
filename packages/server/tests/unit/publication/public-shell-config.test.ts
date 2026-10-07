import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_PUBLIC_SHELL_META defaults false and rejects illegal values', () => {
  assert.deepEqual(loadConfig(env).publicShellMeta, { enabled: false, webShellOrigin: null });
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_PUBLIC_SHELL_META: 'yes' }),
    /KNOWN_FEATURE_PUBLIC_SHELL_META must be true or false/u,
  );
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_PUBLIC_SHELL_META: 'true' }),
    /WEB_SHELL_ORIGIN is required/u,
  );
});

test('KNOWN_FEATURE_PUBLIC_PROFILE_SHELL is independent, defaults false, and requires the shared shell origin only when on', () => {
  const config = loadConfig(env);
  assert.deepEqual(config.publicProfileShell, { enabled: false, webShellOrigin: null });
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'yes' }),
    /KNOWN_FEATURE_PUBLIC_PROFILE_SHELL must be true or false/u,
  );
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'true' }),
    /WEB_SHELL_ORIGIN is required/u,
  );
  const profileOnly = loadConfig({
    ...env,
    KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'true',
    WEB_SHELL_ORIGIN: 'http://web:80',
  });
  assert.deepEqual(profileOnly.publicShellMeta, { enabled: false, webShellOrigin: null });
  assert.deepEqual(profileOnly.publicProfileShell, { enabled: true, webShellOrigin: 'http://web:80' });
});

test('WEB_SHELL_ORIGIN must be an exact origin when the flag is on', () => {
  const on = loadConfig({
    ...env,
    KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
    WEB_SHELL_ORIGIN: 'http://web:80',
  });
  assert.deepEqual(on.publicShellMeta, { enabled: true, webShellOrigin: 'http://web:80' });
  assert.throws(
    () => loadConfig({
      ...env,
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80/index.html',
    }),
    /WEB_SHELL_ORIGIN must be an exact origin/u,
  );
  assert.throws(
    () => loadConfig({
      ...env,
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
      WEB_SHELL_ORIGIN: 'http://user:pass@web:80',
    }),
    /WEB_SHELL_ORIGIN must be an exact origin/u,
  );
});

test('compose explicitly enables the independently reversible public Profile shell', async () => {
  const compose = await readFile(new URL('../../../../devops/docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: "true"/u);
  assert.match(compose, /WEB_SHELL_ORIGIN: "http:\/\/web:80"/u);
});
