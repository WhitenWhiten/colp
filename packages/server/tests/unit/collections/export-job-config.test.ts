import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config.js';
import {
  DEFAULT_EXPORT_R2_PREFIX,
  exportObjectKey,
} from '../../../src/modules/collections/index.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('explicit false disables exports without R2 and rejects illegal values', () => {
  const disabled = { ...env, KNOWN_FEATURE_EXPORT_JOBS: 'false' };
  assert.equal(loadConfig(disabled).exportJobs.enabled, false);
  assert.equal(loadConfig(disabled).exportJobs.r2, null);
  assert.equal(loadConfig(disabled).exportJobs.prefix, DEFAULT_EXPORT_R2_PREFIX);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_EXPORT_JOBS: 'yes' }),
    /KNOWN_FEATURE_EXPORT_JOBS must be true or false/u,
  );
});

test('exports default on and require R2 credentials unless explicitly disabled', () => {
  assert.throws(() => loadConfig(env), /EXPORT_R2_ENDPOINT is required/u);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_EXPORT_JOBS: 'true' }),
    /EXPORT_R2_ENDPOINT is required/u,
  );
  const enabled = loadConfig({
    ...env,
    EXPORT_R2_ENDPOINT: 'https://export.example.test',
    EXPORT_R2_REGION: 'auto',
    EXPORT_R2_BUCKET: 'export-private',
    EXPORT_R2_ACCESS_KEY_ID: 'export-key',
    EXPORT_R2_SECRET_ACCESS_KEY: 'export-secret',
  });
  assert.equal(enabled.exportJobs.enabled, true);
  assert.equal(enabled.exportJobs.r2?.bucket, 'export-private');
  assert.equal(enabled.exportJobs.r2?.prefix, 'export/');
  assert.notEqual(enabled.exportJobs.prefix, 'avatar/');
});

test('export object keys use the private export prefix, not avatar', () => {
  assert.equal(DEFAULT_EXPORT_R2_PREFIX, 'export/');
  assert.equal(exportObjectKey(DEFAULT_EXPORT_R2_PREFIX, 'job-1'), 'export/job-1');
  assert.equal(exportObjectKey(DEFAULT_EXPORT_R2_PREFIX, 'job-1').startsWith('avatar/'), false);
  const adapter = readFileSync(
    join(import.meta.dirname, '../../../src/infrastructure/collections/export-object-store-r2-adapter.ts'),
    'utf8',
  );
  assert.match(adapter, /exportObjectKey\(options\.prefix, jobId\)/u);
  assert.doesNotMatch(adapter, /['"`]avatar\//u);
});

test('collections application sources do not import pg or aws-sdk', () => {
  const roots = [
    join(import.meta.dirname, '../../../src/modules/collections/application'),
    join(import.meta.dirname, '../../../src/modules/collections'),
  ];
  for (const directory of roots) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      assert.equal(/from ['"]pg['"]/u.test(source), false, `${name} imports pg`);
      assert.equal(/from ['"]@aws-sdk\//u.test(source), false, `${name} imports aws-sdk`);
    }
  }
});

test('ProductErrorCode published enum is unchanged (no conflict member)', () => {
  const document = parse(readFileSync(
    join(import.meta.dirname, '../../../openapi/product-v1.yaml'),
    'utf8',
  )) as { components: { schemas: { ProductErrorCode: { enum: string[] } } } };
  const codes = document.components.schemas.ProductErrorCode.enum;
  assert.equal(codes.length, 26);
  assert.equal(codes.includes('conflict'), false);
});
