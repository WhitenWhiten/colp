import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applySelfHostedPreset, SECRET_NAMES } from '../../../src/bootstrap/self-hosted-preset.js';
import { loadConfig } from '../../../src/bootstrap/config.js';

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

  it('derives a distinct value for every secret', () => {
    const env = baseEnv();
    applySelfHostedPreset(env);
    const values = SECRET_NAMES.filter((name) => !name.endsWith('_KEY_ID') && !name.endsWith('_KEYID')).map((name) => env[name]);
    expect(new Set(values).size).toBe(values.length);
    expect(env.PUBLICATION_CURSOR_ACTIVE_KEY_ID).toBe('self-hosted-v1');
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
