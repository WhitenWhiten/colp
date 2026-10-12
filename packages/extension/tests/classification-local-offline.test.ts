import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { classificationEndpointIsLoopback } from '../src/classification-local-presets.js';
import { localClassificationCanRunOffline, LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_DRAFT } from '../src/classification-local-session.js';
import { MemoryStorageArea } from '../src/credential-store.js';

let local: MemoryStorageArea;
beforeEach(() => {
  local = new MemoryStorageArea();
  vi.stubGlobal('chrome', { storage: { local, session: new MemoryStorageArea() } });
});
afterEach(() => vi.unstubAllGlobals());

test.each([
  ['http://localhost:8080/classify', true], ['https://LOCALHOST/classify', true],
  ['http://model.localhost:8080/classify', true], ['http://127.0.0.1:8080/classify', true],
  ['http://127.1.2.3/classify', true], ['http://[::1]:8080/classify', true],
  ['http://127.1/classify', true],
  ['https://api.typesafe.ai/v1/systemone', false], ['http://192.168.1.20/classify', false],
  ['http://10.0.0.5/classify', false], ['http://172.16.4.4/classify', false],
  ['http://169.254.10.20/classify', false], ['http://model.local/classify', false],
  ['https://localhost.example.org/classify', false], ['https://127.example.org/classify', false],
  ['https://[::2]/classify', false], ['ftp://localhost/classify', false],
  ['https://user:password@localhost/classify', false], ['broken-endpoint', false],
])('offline eligibility for %s is %s', async (endpoint, expected) => {
  expect(classificationEndpointIsLoopback(endpoint)).toBe(expected);
  await local.set({ [LOCAL_CLASSIFICATION_KEY]: { endpoint } });
  expect(await localClassificationCanRunOffline()).toBe(expected);
});

test('a restored draft without a saved credential does not enable offline calls', async () => {
  await local.set({ [LOCAL_CLASSIFICATION_DRAFT]: { endpoint: 'http://localhost:8080/classify' } });
  expect(await localClassificationCanRunOffline()).toBe(false);
});

test.each([{}, { endpoint: 42 }, 'corrupt'])('malformed stored settings fail offline eligibility: %j', async stored => {
  await local.set({ [LOCAL_CLASSIFICATION_KEY]: stored });
  expect(await localClassificationCanRunOffline()).toBe(false);
});

test('an unavailable settings store fails offline eligibility', async () => {
  vi.spyOn(local, 'get').mockRejectedValue(new Error('storage_unavailable'));
  expect(await localClassificationCanRunOffline()).toBe(false);
});
