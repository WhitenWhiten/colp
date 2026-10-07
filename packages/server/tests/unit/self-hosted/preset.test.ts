import { createHash } from 'node:crypto';
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
    })).toThrow(/COLP_INSECURE_HTTP/);
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
});
