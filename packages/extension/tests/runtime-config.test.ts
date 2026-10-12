import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { resolveRuntimeConfig } from '../src/config.js';
import { enforceManagedConfiguration, managedServerOrigin } from '../src/managed-policy.js';
import { config } from './auth-shell-fixture.js';

describe('resolveRuntimeConfig', () => {
  test('no override keeps the pinned origin', () => {
    const build = config();
    assert.equal(resolveRuntimeConfig(build).serverOrigin, build.serverOrigin);
    assert.equal(resolveRuntimeConfig(build, '').serverOrigin, build.serverOrigin);
  });

  test('an https override rewrites manifest, auth, JWKS, and revocation onto that origin', () => {
    const resolved = resolveRuntimeConfig(config(), 'https://colp.example.net');
    assert.equal(resolved.serverOrigin, 'https://colp.example.net');
    assert.equal(resolved.manifestUrl, 'https://colp.example.net/.well-known/collection-protocol');
    assert.equal(resolved.issuer, 'https://colp.example.net/');
    assert.equal(resolved.authorizationEndpoint, 'https://colp.example.net/api/v1/auth/sign-in/email');
    assert.equal(resolved.tokenEndpoint, 'https://colp.example.net/api/v1/auth/get-session');
    assert.equal(resolved.jwksUri, 'https://colp.example.net/.well-known/jwks.json');
    assert.equal(resolved.revocationEndpoint, 'https://colp.example.net/api/v1/auth/sign-out');
  });

  test('a loopback http runtime origin is accepted in a production build', () => {
    const resolved = resolveRuntimeConfig(config(), 'http://127.0.0.1:8080');
    assert.equal(resolved.serverOrigin, 'http://127.0.0.1:8080');
    assert.equal(resolved.manifestUrl, 'http://127.0.0.1:8080/.well-known/collection-protocol');
    assert.equal(resolved.issuer, 'http://127.0.0.1:8080/');
    assert.equal(resolved.jwksUri, 'http://127.0.0.1:8080/.well-known/jwks.json');
    assert.equal(resolved.revocationEndpoint, 'http://127.0.0.1:8080/api/v1/auth/sign-out');
    assert.equal(resolveRuntimeConfig(config(), 'http://[::1]:8080').serverOrigin, 'http://[::1]:8080');
  });

  test('a LAN or public http runtime origin is refused (COLP: http only on loopback)', () => {
    assert.throws(() => resolveRuntimeConfig(config(), 'http://192.168.1.20:8080'), /HTTPS is required/);
    assert.throws(() => resolveRuntimeConfig(config(), 'http://203.0.113.10:8080'), /HTTPS is required/);
    assert.throws(() => resolveRuntimeConfig(config(), 'http://127.0.0.1:8080/extra'), /exact/);
  });

  test('development loopback http is allowed', () => {
    const dev = { ...config(), environment: 'development' as const };
    const resolved = resolveRuntimeConfig(dev, 'http://127.0.0.1:4173');
    assert.equal(resolved.serverOrigin, 'http://127.0.0.1:4173');
    assert.equal(resolved.manifestUrl, 'http://127.0.0.1:4173/.well-known/collection-protocol');
  });

  test('a managed serverOrigin locks instead of conflicting with the build', () => {
    const build = config();
    assert.equal(managedServerOrigin({ serverOrigin: 'https://colp.example.net' }), 'https://colp.example.net');
    assert.equal(managedServerOrigin({}), undefined);
    assert.doesNotThrow(() => enforceManagedConfiguration({ serverOrigin: 'https://colp.example.net' }, build));
    assert.throws(() => enforceManagedConfiguration({ serverOrigin: 1 }, build), /managed_configuration_conflict/);
  });
});
