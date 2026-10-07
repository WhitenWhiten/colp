import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { applySelfHostedPreset } from '../../../src/bootstrap/self-hosted-preset.js';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COLP_SERVER_ORIGIN: 'https://colp.test',
    COLP_SERVER_SECRET: randomBytes(32).toString('base64'),
    ...overrides,
  };
}

describe('self-hosted preset', () => {
  it('derives the production contract from the six-value setup', () => {
    const env = environment();
    applySelfHostedPreset(env);
    expect(env.PUBLICATION_ORIGIN).toBe('https://colp.test');
    expect(env.PRODUCT_ORIGIN).toBe('https://colp.test');
    expect(env.ALLOWED_ORIGINS).toContain('chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen');
    expect(env.KNOWN_EDITION).toBe('self-hosted');
    expect(env.KNOWN_FEATURE_MCP_READ).toBe('true');
    expect(env.KNOWN_FEATURE_COMMUNITY).toBe('false');
    expect(env.MCP_OAUTH_AUDIENCE).toBe('https://colp.test/collections/-/mcp');
    expect(env.PUBLICATION_SERVER_UUID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('derives distinct key material with distinct HKDF info labels', () => {
    const env = environment();
    applySelfHostedPreset(env);
    const keys = [env.AUTH_HMAC_KEY, env.SESSION_HMAC_KEY, env.MCP_HMAC_KEY, env.SYNC_HMAC_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    expect(env.AUTH_KEY_ID).toBe('self-hosted-v1');
  });

  it('preserves explicit operator overrides', () => {
    const env = environment({ PRODUCT_ORIGIN: 'https://internal.example', KNOWN_FEATURE_FEED: 'true' });
    applySelfHostedPreset(env);
    expect(env.PRODUCT_ORIGIN).toBe('https://internal.example');
    expect(env.KNOWN_FEATURE_FEED).toBe('true');
  });

  it.each([
    [{ COLP_SERVER_ORIGIN: undefined }, 'COLP_SERVER_ORIGIN'],
    [{ COLP_SERVER_SECRET: undefined }, 'COLP_SERVER_SECRET'],
    [{ COLP_SERVER_SECRET: Buffer.alloc(31).toString('base64') }, 'COLP_SERVER_SECRET'],
    [{ COLP_SERVER_ORIGIN: 'http://192.0.2.10' }, 'COLP_INSECURE_HTTP'],
  ])('refuses invalid setup (%s)', (overrides, variable) => {
    expect(() => applySelfHostedPreset(environment(overrides))).toThrow(variable);
  });

  it('allows loopback HTTP and requires the explicit opt-in elsewhere', () => {
    expect(() => applySelfHostedPreset(environment({ COLP_SERVER_ORIGIN: 'http://127.0.0.1:3000' }))).not.toThrow();
    expect(() => applySelfHostedPreset(environment({ COLP_SERVER_ORIGIN: 'http://192.0.2.10', COLP_INSECURE_HTTP: 'true' }))).not.toThrow();
  });
});

