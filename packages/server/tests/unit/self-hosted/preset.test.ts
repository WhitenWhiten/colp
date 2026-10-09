import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applySelfHostedPreset, SECRET_NAMES } from '../../../src/bootstrap/self-hosted-preset.js';
import { loadConfig } from '../../../src/bootstrap/config.js';
import {
  createPublicationManifestCandidateV02,
  type PublicationEndpointName,
} from '../../../src/modules/publication/application/manifest-candidate.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    COLP_SERVER_ORIGIN: 'https://colp.test',
    COLP_SERVER_SECRET: SECRET,
    DATABASE_URL: 'postgres://x',
    ...extra,
  };
}

describe('self-hosted preset', () => {
  it('lets production loadConfig pass from the six owner variables', () => {
    const env = baseEnv();
    applySelfHostedPreset(env);
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('lets production loadConfig pass for an acknowledged loopback http origin', () => {
    const env = baseEnv({
      COLP_SERVER_ORIGIN: 'http://127.0.0.1:8080',
      COLP_INSECURE_HTTP: 'true',
    });
    applySelfHostedPreset(env);
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('refuses a LAN http origin even when insecure HTTP is acknowledged (D26)', () => {
    const env = baseEnv({
      COLP_SERVER_ORIGIN: 'http://192.168.1.20:8080',
      COLP_INSECURE_HTTP: 'true',
    });
    expect(() => applySelfHostedPreset(env)).toThrow(/tls-internal/);
  });

  it('defaults database TLS off and keeps an explicit require', () => {
    const disabled = baseEnv();
    applySelfHostedPreset(disabled);
    expect(disabled.DATABASE_SSL_MODE).toBe('disable');
    expect(loadConfig(disabled).databaseSsl).toBe(false);

    const required = baseEnv({ DATABASE_SSL_MODE: 'require' });
    applySelfHostedPreset(required);
    expect(required.DATABASE_SSL_MODE).toBe('require');
    expect(loadConfig(required).databaseSsl).toBe(true);
  });

  it('declares a private-network ingress and keeps an explicit one', () => {
    const env = baseEnv();
    applySelfHostedPreset(env);
    expect(env.TRUSTED_INGRESS).toBe('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    expect(loadConfig(env).httpSecurity.trustedIngressDeclared).toBe(true);

    const peerOnly = baseEnv({ TRUSTED_INGRESS: '' });
    applySelfHostedPreset(peerOnly);
    expect(peerOnly.TRUSTED_INGRESS).toBe('');
    expect(loadConfig(peerOnly).httpSecurity.trustedIngressDeclared).toBe(true);
  });

  it('still refuses production http when the insecure flag is absent', () => {
    const env = baseEnv({ COLP_SERVER_ORIGIN: 'http://127.0.0.1:8080' });
    applySelfHostedPreset(env);
    expect(() => loadConfig(env)).toThrow(/https/);
  });

  it('turns on browser sync for an https origin and for acknowledged loopback http', () => {
    const tls = baseEnv();
    applySelfHostedPreset(tls);
    const tlsConfig = loadConfig(tls);
    expect(tlsConfig.syncSession?.extensionAuth.issuer).toBe('https://colp.test/api/v1/auth');
    expect(tlsConfig.syncSession?.allowedOrigins).toEqual(['chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen']);
    expect(tlsConfig.publication.endpoints.syncSessions).toBe('https://colp.test/colp/v0.1/sync/sessions');
    expect(tlsConfig.publication.endpoints.syncEffectPages).toMatch(/\{effectId\}.*\{pageNumber\}$/u);

    const loopback = baseEnv({ COLP_SERVER_ORIGIN: 'http://localhost:8080', COLP_INSECURE_HTTP: 'true' });
    applySelfHostedPreset(loopback);
    expect(loadConfig(loopback).syncSession?.extensionAuth.jwksUri).toBe('http://localhost:8080/api/v1/auth/jwks');
  });

  it('builds the COLP 0.2 sync manifest the extension discovers, on https and loopback http', () => {
    for (const extra of [{}, { COLP_SERVER_ORIGIN: 'http://localhost:8080', COLP_INSECURE_HTTP: 'true' }]) {
      const env = baseEnv(extra);
      applySelfHostedPreset(env);
      const { publication } = loadConfig(env);
      const implemented = Object.keys(publication.endpoints) as PublicationEndpointName[];
      const { manifest } = createPublicationManifestCandidateV02(publication, implemented);
      const mount = manifest.mounts[0] as unknown as Record<string, unknown> & {
        readonly profiles: readonly string[];
        readonly endpoints: Record<string, string>;
        readonly auth: { readonly oauth: boolean };
      };
      expect(manifest.protocolVersions).toContain('0.2');
      expect(Object.keys(mount.endpoints)).toEqual(expect.arrayContaining(
        ['syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
      ));
      expect(mount.profiles).not.toContain('sync');
      expect(mount.auth.oauth).toBe(true);
      expect(mount['https://known.example/extensions/sync-retire']).toMatchObject({ method: 'DELETE' });
    }
  });

  it('binds the sync redirect to the first allowed extension and keeps sync opt-out', () => {
    const custom = baseEnv({ COLP_ALLOWED_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop, pplpnpegpnghcddhmpgkbfkdfadjiaen' });
    applySelfHostedPreset(custom);
    expect(custom.SYNC_OAUTH_REDIRECT_URI).toBe('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2');
    expect(loadConfig(custom).syncSession?.allowedOrigins).toHaveLength(2);

    const off = baseEnv({ SYNC_SESSION_ENABLED: 'false' });
    applySelfHostedPreset(off);
    const config = loadConfig(off);
    expect(config.syncSession).toBeUndefined();
    expect(config.publication.endpoints.syncSessions).toBeUndefined();
  });

  it('derives a distinct value for every secret', () => {
    const env = baseEnv();
    applySelfHostedPreset(env);
    const values = SECRET_NAMES.filter((name) => !name.endsWith('_KEY_ID') && !name.endsWith('_KEYID')).map((name) => env[name]);
    expect(new Set(values).size).toBe(values.length);
    expect(env.PUBLICATION_CURSOR_ACTIVE_KEY_ID).toBe('self-hosted-v1');
    expect(SECRET_NAMES.filter((name) => name.endsWith('_ENDPOINT'))).toEqual([]);
  });

  it('keeps an explicit override', () => {
    const env = baseEnv({ KNOWN_FEATURE_LINK_HEALTH: 'false', PUBLICATION_ORIGIN: 'https://override.test' });
    applySelfHostedPreset(env);
    expect(env.KNOWN_FEATURE_LINK_HEALTH).toBe('false');
    expect(env.PUBLICATION_ORIGIN).toBe('https://override.test');
  });

  it('refuses a missing origin, a short secret, and unacknowledged public http', () => {
    expect(() => applySelfHostedPreset({ COLP_SERVER_SECRET: SECRET })).toThrow(/COLP_SERVER_ORIGIN/);
    expect(() => applySelfHostedPreset({
      COLP_SERVER_ORIGIN: 'https://colp.test',
      COLP_SERVER_SECRET: 'short',
    })).toThrow(/COLP_SERVER_SECRET/);
    expect(() => applySelfHostedPreset({
      COLP_SERVER_ORIGIN: 'http://192.168.1.20:8080',
      COLP_SERVER_SECRET: SECRET,
    })).toThrow(/only on 127\.0\.0\.1/);
  });

  it('refuses the shipped COLP_SERVER_SECRET placeholder even though it is long enough', () => {
    expect(() => applySelfHostedPreset({
      COLP_SERVER_ORIGIN: 'https://colp.test',
      COLP_SERVER_SECRET: 'replace-with-openssl-rand-base64-48',
    })).toThrow(/cryptographically random/);
  });

  it('is stable for the same origin', () => {
    const left = baseEnv();
    const right = baseEnv();
    applySelfHostedPreset(left);
    applySelfHostedPreset(right);
    expect(left.PUBLICATION_SERVER_UUID).toBe(right.PUBLICATION_SERVER_UUID);
    expect(left.PUBLICATION_SERVER_UUID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(createHash('sha256').update(String(left.BETTER_AUTH_SECRET)).digest('hex'))
      .toBe(createHash('sha256').update(String(right.BETTER_AUTH_SECRET)).digest('hex'));
  });

  it('refuses COLP_MULTI_USER=true until invite codes ship (D27)', () => {
    expect(() => applySelfHostedPreset(baseEnv({ COLP_MULTI_USER: 'true' }))).toThrow(/invite codes/);
    expect(() => applySelfHostedPreset(baseEnv({ COLP_MULTI_USER: 'false' }))).not.toThrow();
  });

  it('derives a stable setup token that differs per secret', () => {
    const left = baseEnv();
    const right = baseEnv();
    const other = baseEnv({ COLP_SERVER_SECRET: Buffer.alloc(32, 8).toString('base64') });
    for (const env of [left, right, other]) applySelfHostedPreset(env);
    expect(left.COLP_SETUP_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(left.COLP_SETUP_TOKEN).toBe(right.COLP_SETUP_TOKEN);
    expect(left.COLP_SETUP_TOKEN).not.toBe(other.COLP_SETUP_TOKEN);
  });

  it('does not honor a caller-supplied predictable setup token', () => {
    const env = baseEnv({ COLP_SETUP_TOKEN: 'known-public-token' });
    applySelfHostedPreset(env);
    expect(env.COLP_SETUP_TOKEN).not.toBe('known-public-token');
    expect(env.COLP_SETUP_TOKEN).toBeDefined();
  });

  it('derives the API-key signer, so a restart keeps the same valid P-256 key', () => {
    const left = baseEnv();
    const right = baseEnv();
    applySelfHostedPreset(left);
    applySelfHostedPreset(right);
    expect(left.AUTOMATION_ES256_PRIVATE_JWK).toBe(right.AUTOMATION_ES256_PRIVATE_JWK);
    const jwk = JSON.parse(String(left.AUTOMATION_ES256_PRIVATE_JWK)) as Record<string, string>;
    const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
    const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, string>;
    expect(publicJwk.x).toBe(jwk.x);
    expect(publicJwk.y).toBe(jwk.y);
    expect(jwk.kid).toBe('self-hosted-v1');
    expect(() => loadConfig(left)).not.toThrow();
  });
});
