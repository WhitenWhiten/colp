import { describe, expect, it } from 'vitest';

import {
  buildFreshProbePrefix,
  mergeLoopbackNoProxy,
  parseDirectS3ApiUrl,
  parseLocalEnvironment,
} from '../../../scripts/phase4a-r2-local-env.mjs';

function syntheticEnvironmentText(): string {
  const account = 'f'.repeat(32);
  return [
    '# synthetic runtime values',
    'P4A_PROBE_TARGET=cloudflare-r2-direct-object-api',
    `P4A_R2_ENDPOINT=https://${account}.r2.cloudflarestorage.com`,
    `P4A_R2_ACCOUNT_ID=${account}`,
    'P4A_R2_BUCKET=known-test',
    `P4A_R2_ACCESS_KEY_ID=${'c'.repeat(32)}`,
    `P4A_R2_SECRET_ACCESS_KEY=${'d'.repeat(64)}`,
    `P4A_R2_READ_ACCESS_KEY_ID=${'a'.repeat(32)}`,
    `P4A_R2_READ_SECRET_ACCESS_KEY=${'b'.repeat(64)}`,
    `P4A_CLOUDFLARE_CONTROL_API_TOKEN=${'e'.repeat(53)}`,
    '',
  ].join('\n');
}

describe('Phase 4A local real-R2 environment', () => {
  it('loads only the fixed real-R2 environment contract', () => {
    const environment = parseLocalEnvironment(syntheticEnvironmentText());
    expect(environment.P4A_R2_READ_ACCESS_KEY_ID).toBe('a'.repeat(32));
    expect(environment.P4A_R2_ACCESS_KEY_ID).toBe('c'.repeat(32));
    expect(environment.P4A_R2_ENDPOINT).toBe(
      `https://${'f'.repeat(32)}.r2.cloudflarestorage.com`,
    );
    expect(environment.P4A_R2_BUCKET).toBe('known-test');
  });

  it('rejects malformed, duplicate and non-distinct credential material', () => {
    const serialized = syntheticEnvironmentText();
    expect(() => parseLocalEnvironment(serialized.replace('c'.repeat(32), 'a'.repeat(32))))
      .toThrow('local_r2_credentials_not_distinct');
    expect(() => parseLocalEnvironment(`${serialized}NODE_OPTIONS=--inspect\n`))
      .toThrow('local_r2_env_key_forbidden');
    expect(() => parseLocalEnvironment(
      `${serialized}P4A_R2_BUCKET=duplicate\n`,
    )).toThrow('local_r2_env_key_duplicate');
  });

  it('requires a direct HTTPS account endpoint with exactly one bucket path', () => {
    const account = 'f'.repeat(32);
    expect(() => parseDirectS3ApiUrl(`http://${account}.r2.cloudflarestorage.com/known-test`))
      .toThrow('local_r2_s3_api_url_invalid');
    expect(() => parseDirectS3ApiUrl(`https://${account}.r2.cloudflarestorage.com/a/b`))
      .toThrow('local_r2_s3_api_url_invalid');
    expect(() => parseDirectS3ApiUrl(`https://${account}.example.com/known-test`))
      .toThrow('local_r2_s3_api_url_invalid');
  });

  it('keeps loopback hosts out of HTTP(S)_PROXY so local delivery fetch is not proxied', () => {
    expect(mergeLoopbackNoProxy({}).NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(mergeLoopbackNoProxy({ NO_PROXY: 'example.test' }).NO_PROXY)
      .toContain('127.0.0.1');
    expect(mergeLoopbackNoProxy({ NO_PROXY: 'localhost,127.0.0.1' }).NO_PROXY)
      .toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('creates a fresh dedicated prefix without target or credential material', () => {
    const prefix = buildFreshProbePrefix(
      'i16',
      new Date('2026-08-08T12:34:56.000Z'),
      '0123456789abcdef',
    );
    expect(prefix).toBe('capability-probes/local-20260808123456-i16-0123456789abcdef/');
    expect(() => buildFreshProbePrefix('unknown', new Date(), '0123456789abcdef'))
      .toThrow('local_r2_probe_prefix_input_invalid');
  });
});
