import { expect, test } from 'vitest';
import { loadClassificationConfig } from '../../../src/bootstrap/config-classification.js';
import { classificationDeploymentIdentity, createClassificationUpstream, createCloudflareJevClassificationProvider, createCloudflareUpstream } from '../../../src/infrastructure/collections/classification-provider-factory.js';

const credentials = { BOOKMARK_CLASSIFICATION_CF_ACCOUNT_ID: 'a'.repeat(32), BOOKMARK_CLASSIFICATION_CF_ACCESS_KEY: 'cf-api-token' };
const upstream = (env: NodeJS.ProcessEnv) => loadClassificationConfig({ ...credentials, ...env }).provider;

test('the model identifier is configurable and only its shape is constrained', () => {
  expect(upstream({ BOOKMARK_CLASSIFICATION_MODEL: 'custom/model-v2' })?.model).toBe('custom/model-v2');
  expect(upstream({ BOOKMARK_CLASSIFICATION_MODEL: 'jev-latest' })?.model).toBe('jev-latest');
  expect(upstream({})?.model).toBe('typesafe/jev');
  for (const model of ['   ', 'bad model', 'bad\nmodel', 'bad\u0000model']) {
    expect(() => loadClassificationConfig({ ...credentials, BOOKMARK_CLASSIFICATION_MODEL: model })).toThrow('Invalid classification model identifier');
  }
});

test('only registered providers are accepted', () => {  expect(upstream({ BOOKMARK_CLASSIFICATION_PROVIDER: 'cloudflare_jev' })?.id).toBe('cloudflare_jev');
  expect(upstream({})?.id).toBe('cloudflare_jev');
  expect(() => loadClassificationConfig({ ...credentials, BOOKMARK_CLASSIFICATION_PROVIDER: 'typesafe_official' })).toThrow('Unsupported classification provider');
});

test('an unset expected model version stays in alias mode and a set one pins', () => {
  expect(upstream({})?.expectedModelVersion).toBeNull();
  expect(upstream({ BOOKMARK_CLASSIFICATION_EXPECTED_MODEL_VERSION: '' })?.expectedModelVersion).toBeNull();
  expect(upstream({ BOOKMARK_CLASSIFICATION_EXPECTED_MODEL_VERSION: 'jev-1.13.0' })?.expectedModelVersion).toBe('jev-1.13.0');
});

test('the endpoint is overridable while the default stays the Cloudflare AI run URL', () => {
  expect(upstream({})?.endpoint).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`);
  expect(upstream({ BOOKMARK_CLASSIFICATION_ENDPOINT: 'https://gateway.example.test/run' })?.endpoint).toBe('https://gateway.example.test/run');
});

test('the per-attempt request timeout defaults, is overridable, and fails closed outside its bounds', () => {
  expect(upstream({})?.requestTimeoutMs).toBe(10_000);
  expect(upstream({ BOOKMARK_CLASSIFICATION_REQUEST_TIMEOUT_MS: '15000' })?.requestTimeoutMs).toBe(15_000);
  expect(upstream({ BOOKMARK_CLASSIFICATION_REQUEST_TIMEOUT_MS: '  ' })?.requestTimeoutMs).toBe(10_000);
  for (const value of ['0', '999', '30001', '1.5', 'soon']) {
    expect(() => loadClassificationConfig({ ...credentials, BOOKMARK_CLASSIFICATION_REQUEST_TIMEOUT_MS: value }))
      .toThrow('Invalid classification request timeout');
  }
});

test('the calibration identity follows the configured upstream and needs a pinned version', () => {
  const configured = loadClassificationConfig({ ...credentials,
    BOOKMARK_CLASSIFICATION_MODEL: 'custom/model-v2', BOOKMARK_CLASSIFICATION_EXPECTED_MODEL_VERSION: 'custom-2.1.0' }).provider;
  expect(classificationDeploymentIdentity(configured)).toEqual({ providerId: 'cloudflare_jev', model: 'custom/model-v2', modelVersion: 'custom-2.1.0' });
  // Alias mode has no version to bind a calibration certificate to.
  expect(classificationDeploymentIdentity(upstream({}))).toBeNull();
  expect(classificationDeploymentIdentity(null)).toBeNull();
});

test('missing credentials keep the deployment provider disabled instead of fabricating one', () => {
  expect(loadClassificationConfig({}).provider).toBeNull();
  expect(loadClassificationConfig({ BOOKMARK_CLASSIFICATION_MODEL: 'custom/model' }).provider).toBeNull();
  // A half-configured credential pair fails closed instead of degrading to an anonymous provider.
  expect(() => loadClassificationConfig({ BOOKMARK_CLASSIFICATION_CF_ACCOUNT_ID: 'a'.repeat(32) })).toThrow('Incomplete classification provider credentials');
  expect(() => loadClassificationConfig({ BOOKMARK_CLASSIFICATION_CF_ACCESS_KEY: 'tok' })).toThrow('Incomplete classification provider credentials');
  expect(() => loadClassificationConfig({ BOOKMARK_CLASSIFICATION_CF_ACCOUNT_ID: 'not-hex', BOOKMARK_CLASSIFICATION_CF_ACCESS_KEY: 'tok' })).toThrow('Incomplete classification provider credentials');
  expect(loadClassificationConfig(credentials).provider?.id).toBe('cloudflare_jev');
});

test('the endpoint policy only allows plaintext HTTP for a local upstream', () => {
  const base = { accountId: 'a'.repeat(32), accessKey: 'cf-api-token', gatewayId: 'default' };
  // HTTPS anywhere; plain HTTP only where the operator runs the classifier.
  for (const allowed of ['https://gateway.example.test/run', 'http://127.0.0.1:8080/v1/systemone',
    'http://localhost:11434/v1/systemone', 'http://10.0.0.5:8000/run', 'http://192.168.1.20/run', 'http://172.16.4.4/run', 'http://169.254.10.20/run']) {
    expect(() => createCloudflareJevClassificationProvider(createCloudflareUpstream({ ...base, endpoint: allowed }))).not.toThrow();
  }
  // The account-scoped Cloudflare token must never travel in cleartext to a public host.
  for (const rejected of ['http://gateway.example.test/run', 'http://172.32.0.1/run', 'ftp://127.0.0.1/run',
    'file:///etc/passwd', 'https://user:pass@gateway.example.test/run']) {
    expect(() => createCloudflareJevClassificationProvider(createCloudflareUpstream({ ...base, endpoint: rejected })))
      .toThrow('Invalid classification provider configuration');
  }
});

test('the derived Cloudflare endpoint requires a well-formed account id', () => {
  expect(createCloudflareUpstream({ accountId: 'a'.repeat(32), accessKey: 'tok' }).endpoint)
    .toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`);
  for (const accountId of [undefined, '', 'undefined', 'not-hex', 'a'.repeat(31)]) {
    expect(() => createCloudflareUpstream({ accountId, accessKey: 'tok' }))
      .toThrow('Invalid classification provider configuration');
  }
  // A native wire has no Cloudflare account URL to derive; it needs an explicit endpoint.
  expect(() => createClassificationUpstream({ wire: 'typesafe_systemone_v1', accessKey: 'tok' }))
    .toThrow('Invalid classification provider configuration');
  expect(createClassificationUpstream({ wire: 'typesafe_systemone_v1', endpoint: 'https://api.typesafe.ai/v1/systemone' }).endpoint)
    .toBe('https://api.typesafe.ai/v1/systemone');
});
