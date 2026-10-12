import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { discoverSyncEndpoints } from '../src/manifest-client.js';
import { enforceManagedConfiguration, managedServerOrigin } from '../src/managed-policy.js';
import { config, manifest } from './auth-shell-fixture.js';

describe('P3-27 build configuration and Manifest discovery', () => {
  test('pins production identity, server, extension and public-client settings', () => {
    assert.equal(config().serverOrigin, 'https://known.example');
    for (const invalid of [
      { ...config(), serverOrigin: 'http://known.example' },
      { ...config(), serverOrigin: 'https://localhost' },
      { ...config(), serverOrigin: 'https://user:pass@known.example' },
      { ...config(), serverOrigin: 'https://known.example/path' },
      { ...config(), serverOrigin: 'https://known.example?query=1' },
      { ...config(), serverOrigin: 'https://known.example#fragment' },
      { ...config(), extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { ...config(), clientSecret: 'forbidden' },
      { ...config(), serverOrigin: 'https://evil.example', manifestUrl: 'https://evil.example/manifest',
        issuer: 'https://evil.example/', authorizationEndpoint: 'https://evil.example/api/v1/auth/sign-in/email',
        tokenEndpoint: 'https://evil.example/api/v1/auth/get-session', jwksUri: 'https://evil.example/.well-known/jwks.json',
        revocationEndpoint: 'https://evil.example/api/v1/auth/sign-out' },
    ]) assert.throws(() => parseBuildConfig(invalid));
  });

  test('fails closed for managed identity disablement and locks a managed server origin', () => {
    assert.throws(() => enforceManagedConfiguration({ identityDisabled: true }, config()), /policy_blocked/);
    assert.doesNotThrow(() => enforceManagedConfiguration({ serverOrigin: 'https://staging.known.example' }, config()));
    assert.equal(managedServerOrigin({ serverOrigin: 'https://staging.known.example' }), 'https://staging.known.example');
    assert.doesNotThrow(() => enforceManagedConfiguration({ serverOrigin: 'https://known.example' }, config()));
  });

  test('discovers every required endpoint and rejects cross-origin, query, profile claims and bad schema', () => {
    const endpoints = discoverSyncEndpoints(manifest(), config());
    assert.equal(endpoints.syncSessions, 'https://known.example/v1/session');
    assert.equal(endpoints.syncRetire, 'https://known.example/extensions/sync-retire');
    for (const mutate of [
      (value: any) => { delete value.mounts[0].endpoints.syncPull; },
      (value: any) => { value.mounts[0].endpoints.syncSessions = 'https://evil.example/session'; },
      (value: any) => { value.mounts[0].endpoints.syncSessions += '?token=x'; },
      (value: any) => { value.mounts[0].profiles.push('sync'); },
      (value: any) => { value.mounts[0].futureProfile = true; },
    ]) {
      const value = structuredClone(manifest()); mutate(value);
      assert.throws(() => discoverSyncEndpoints(value, config()));
    }
  });

  test('accepts the COLP Server edition extension on the sync mount', () => {
    const value = structuredClone(manifest()) as any;
    value.mounts[0]['https://know-n.com/colp/extensions/server'] = {
      edition: { name: 'colp-server', version: '0.1.0' }, transport: 'https', cloud: false,
    };
    assert.equal(discoverSyncEndpoints(value, config()).syncSessions, 'https://known.example/v1/session');
  });
});
