import { describe, expect, it, vi } from 'vitest';

import { enforceApiKeyTransport } from '../../src/security/index.js';
import type { ApiKeyClassifier, ApiKeyTransportInput } from '../../src/security/index.js';

const evidence = '[evidence:security.api-key-transport]';
const liveKey = 'colp_live_Aa9._~-safe';
const testKey = 'colp_test_Bb8+/safe=';

function inspect(overrides: Partial<ApiKeyTransportInput> = {}) {
  return enforceApiKeyTransport({ requestTarget: '/collections', ...overrides });
}

function rejected(reason: string) {
  return { allowed: false, reason };
}

describe(`${evidence} SEC-0008 API key transport`, () => {
  it(`${evidence} accepts live and test API keys only as a single Bearer Authorization value`, () => {
    for (const [scheme, key] of [['Bearer', liveKey], ['bearer', testKey]] as const) {
      const decision = inspect({ authorization: `${scheme} ${key}` });
      expect(decision).toEqual({ allowed: true, reason: 'allowed', authorizationPresent: true });
      expect(JSON.stringify(decision)).not.toContain(key);
    }
    expect(inspect({ authorization: [`Bearer ${liveKey}`] })).toMatchObject({
      allowed: true,
      authorizationPresent: true,
    });
  });

  it(`${evidence} permits credential-free relative and absolute request targets with ordinary query data`, () => {
    for (const requestTarget of [
      '/collections?limit=20&cursor=next',
      'https://publisher.example.test/collections?include=nodes&empty=',
    ]) {
      expect(inspect({ requestTarget })).toEqual({
        allowed: true,
        reason: 'allowed',
        authorizationPresent: false,
      });
    }
  });

  it(`${evidence} rejects known credential parameter names with empty or populated values`, () => {
    for (const name of [
      'api_key',
      'api-key',
      'apiKey',
      'key',
      'access_token',
      'access-token',
      'accessToken',
      'authorization',
      'x-api-key',
      'x_api_key',
      'xApiKey',
    ]) {
      expect(inspect({ requestTarget: `/items?${name}` })).toEqual(rejected('credential_in_query'));
      expect(inspect({ requestTarget: `/items?${name}=ordinary-looking` })).toEqual(
        rejected('credential_in_query'),
      );
    }
  });

  it(`${evidence} treats known names case-insensitively after percent decoding and rejects duplicates`, () => {
    for (const requestTarget of [
      '/items?API_KEY=value',
      '/items?api%5Fkey=value',
      '/items?access%5Ftoken=',
      '/items?ok=1&key=&key=second',
      '/items?authorization=x&AUTHORIZATION=y',
    ]) {
      expect(inspect({ requestTarget })).toEqual(rejected('credential_in_query'));
    }
    expect(inspect({
      requestTarget: '/items?DEPLOYMENT%5FSECRET=ordinary',
      credentialQueryParameterNames: ['deployment_secret'],
    })).toEqual(rejected('credential_in_query'));
  });

  it(`${evidence} rejects a complete built-in live or test key anywhere in a query name or value`, () => {
    for (const requestTarget of [
      `/items?${liveKey}=x`,
      `/items?next=${testKey}`,
      `/items?prefix-${liveKey}-suffix=x`,
      `/items?next=prefix%3A${encodeURIComponent(testKey)}%3Asuffix`,
    ]) {
      expect(inspect({ requestTarget })).toEqual(rejected('credential_in_query'));
    }
  });

  it(`${evidence} rejects built-in keys whose token68 payload contains a raw or encoded plus`, () => {
    for (const requestTarget of [
      '/items?next=colp_live_+',
      '/items?colp_test_Aa+9=value',
      '/items?next=colp_live_%2B',
      '/items?colp_test_Aa%2B9=value',
    ]) {
      expect(inspect({ requestTarget })).toEqual(rejected('credential_in_query'));
    }
  });

  it(`${evidence} rejects plain and percent-encoded Bearer credentials in every query position`, () => {
    for (const requestTarget of [
      `/items?next=${encodeURIComponent(`Bearer ${liveKey}`)}`,
      `/items?${encodeURIComponent(`Bearer ${testKey}`)}=next`,
      `/items?next=Bearer%20${encodeURIComponent(testKey)}`,
    ]) {
      expect(inspect({ requestTarget })).toEqual(rejected('credential_in_query'));
    }
  });

  it(`${evidence} rejects a query credential even when a valid Authorization header is also present`, () => {
    expect(inspect({
      requestTarget: `/items?api_key=${encodeURIComponent(testKey)}`,
      authorization: `Bearer ${liveKey}`,
    })).toEqual(rejected('credential_in_query'));
  });

  it(`${evidence} rejects repeated, array-multiple, Basic, empty, control-bearing, and CRLF Authorization`, () => {
    const structurallyInvalidAuthorization: Array<string | readonly string[]> = [
      [`Bearer ${liveKey}`, `Bearer ${testKey}`],
      `Basic ${liveKey}`,
      '',
      'Bearer',
      'Bearer not token',
    ];
    for (const authorization of structurallyInvalidAuthorization) {
      expect(inspect({ authorization })).toEqual(rejected('invalid_authorization'));
    }
    for (const authorization of [`Bearer ${liveKey}\u0000`, `Bearer ${liveKey}\r\nX-Leak: yes`]) {
      expect(inspect({ authorization })).toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} fails closed for malformed, empty, or control-bearing request targets`, () => {
    for (const requestTarget of [
      '',
      'items?ok=1',
      '?ok=1',
      'https:publisher.example.test/items?ok=1',
      'http:/publisher.example.test/items?ok=1',
      'https://[::1/items',
      '/items?ok=%',
      '/items?ok=%0',
      '/items?ok=%GG',
      '/items?ok=%E9',
      '/items?ok=%00',
      '/items?ok=%0d%0a',
      '/items?ok=raw space',
      '/items?ok=1\u0000',
      '/items\r\nX: y',
      // Decoded C1 controls (U+0080–U+009F), including percent-encoded forms.
      '/items?ok=%C2%80',
      '/items?ok=%C2%9F',
      '/items?ok=%C2%85',
      '/items?ok=1\u0080',
      '/items?ok=1\u009F',
      '/items?ok=1\u0085',
    ]) {
      expect(inspect({ requestTarget })).toEqual(rejected('invalid_input'));
    }
  });

  it(`${evidence} still accepts ordinary multi-byte UTF-8 query data outside the C1 range`, () => {
    for (const requestTarget of [
      '/items?q=%C3%A9',
      '/items?label=%E2%9C%93',
      '/items?name=caf%C3%A9',
    ]) {
      expect(inspect({ requestTarget })).toEqual({
        allowed: true,
        reason: 'allowed',
        authorizationPresent: false,
      });
    }
  });

  it(`${evidence} inspects raw queries without authority, path, userinfo, or fragment confusion`, () => {
    for (const requestTarget of [
      `//publisher.example.test/items?next=${liveKey}`,
      `https://user:pass@publisher.example.test/items?next=${testKey}`,
      `/items\\shadow?next=${liveKey}`,
      `https://publisher.example.test\\@attacker.test/items?next=${testKey}`,
    ]) {
      expect(inspect({ requestTarget })).toMatchObject({ allowed: false });
    }
    expect(inspect({ requestTarget: '//publisher.example.test/items?next=ordinary' })).toMatchObject({
      allowed: true,
    });
    expect(inspect({
      requestTarget: 'https://user:pass@publisher.example.test/items?next=ordinary#ignored',
    })).toMatchObject({ allowed: true });
  });

  it(`${evidence} lets a custom classifier recognize arbitrary key formats without leaking them`, () => {
    const customSecret = 'deployment-key-4e9c';
    const classifier = vi.fn((candidate: string) => candidate === customSecret);
    const queryDecision = inspect({
      requestTarget: `/items?session=${customSecret}`,
      classifyApiKey: classifier,
    });
    expect(queryDecision).toEqual(rejected('credential_in_query'));
    expect(JSON.stringify(queryDecision)).not.toContain(customSecret);
    expect(classifier).toHaveBeenCalledWith(customSecret);

    expect(inspect({
      requestTarget: `/items?${customSecret}=next`,
      classifyApiKey: classifier,
    })).toEqual(rejected('credential_in_query'));
    expect(inspect({
      requestTarget: `/items?next=${encodeURIComponent(`Bearer ${customSecret}`)}`,
      classifyApiKey: classifier,
    })).toEqual(rejected('credential_in_query'));

    classifier.mockClear();
    const headerDecision = inspect({ authorization: `Bearer ${customSecret}`, classifyApiKey: classifier });
    expect(headerDecision).toEqual({ allowed: true, reason: 'allowed', authorizationPresent: true });
    expect(classifier).toHaveBeenCalledOnce();
    expect(classifier).toHaveBeenCalledWith(customSecret);
    expect(classifier.mock.calls.flat().join('\n')).not.toContain('Bearer ');
  });

  it(`${evidence} gives custom classifiers plus-preserving and form-decoded candidates deterministically`, () => {
    const customSecret = 'deployment+key';
    for (const requestTarget of [
      '/items?next=deployment+key',
      '/items?deployment+key=next',
      '/items?next=ordinary&next=deployment+key',
      '/items?next=deployment%2Bkey',
      '/items?next=Bearer%20deployment%2Bkey',
    ]) {
      const classifier = vi.fn((candidate: string) => candidate === customSecret);
      const decision = inspect({ requestTarget, classifyApiKey: classifier });
      expect(decision).toEqual(rejected('credential_in_query'));
      expect(JSON.stringify(decision)).not.toContain(customSecret);
      expect(classifier.mock.calls.filter(([candidate]) => candidate === customSecret)).toHaveLength(1);
    }

    const fragmentClassifier = vi.fn((candidate: string) => candidate === customSecret);
    expect(inspect({
      requestTarget: '/items?next=ordinary#next=deployment+key',
      classifyApiKey: fragmentClassifier,
    })).toMatchObject({ allowed: true });
    expect(fragmentClassifier).not.toHaveBeenCalledWith(customSecret);
  });

  it(`${evidence} preserves ordinary form queries unless a classifier identifies the raw-plus candidate`, () => {
    const classifier = vi.fn((_candidate: string) => false);
    expect(inspect({
      requestTarget: '/items?q=a+b&literal=a%2Bb&space=a%20b&structured=a%26b%3Dc&&empty=&bare',
      classifyApiKey: classifier,
    })).toEqual({ allowed: true, reason: 'allowed', authorizationPresent: false });
    expect(classifier.mock.calls.filter(([candidate]) => candidate === 'a+b')).toHaveLength(1);
    expect(classifier).toHaveBeenCalledWith('a b');
    expect(classifier).toHaveBeenCalledWith('a&b=c');
  });

  it(`${evidence} fails closed when the custom classifier throws or returns a non-boolean`, () => {
    const throwing: ApiKeyClassifier = () => {
      throw new Error(`classifier rejected ${liveKey}`);
    };
    const nonBoolean = (() => 'yes') as unknown as ApiKeyClassifier;
    const thenable = (() => Promise.resolve(true)) as unknown as ApiKeyClassifier;
    for (const classifyApiKey of [throwing, nonBoolean, thenable]) {
      expect(inspect({ requestTarget: '/items?candidate=opaque', classifyApiKey })).toEqual(
        rejected('classifier_failure'),
      );
      expect(inspect({ authorization: 'Bearer opaque', classifyApiKey })).toEqual(
        rejected('classifier_failure'),
      );
    }
    const proxied = new Proxy((() => true) as ApiKeyClassifier, {});
    expect(inspect({ classifyApiKey: proxied })).toEqual(rejected('invalid_input'));
  });

  it(`${evidence} snapshots dynamic arrays and classifies each candidate at most once`, () => {
    const changing = vi.fn(() => changing.mock.calls.length === 2);
    expect(inspect({
      requestTarget: '/items?candidate=candidate',
      classifyApiKey: changing,
    })).toMatchObject({ allowed: true });
    expect(changing).toHaveBeenCalledOnce();

    const original = 'deployment-key-original';
    const replacement = 'deployment-key-replacement';
    const values = [`Bearer ${original}`];
    const input = { requestTarget: '/items?next=ordinary', authorization: values };
    const classifier = vi.fn((candidate: string) => {
      values[0] = `Bearer ${replacement}`;
      return candidate === original;
    });
    expect(enforceApiKeyTransport({ ...input, classifyApiKey: classifier })).toEqual({
      allowed: true,
      reason: 'allowed',
      authorizationPresent: true,
    });
    expect(values[0]).toBe(`Bearer ${replacement}`);
  });

  it(`${evidence} enforces the query-entry ceiling before accepting oversized input`, () => {
    const atCeiling = Array.from({ length: 256 }, (_, index) => `p${index}=v`).join('&');
    const overCeiling = `${atCeiling}&overflow=v`;
    expect(inspect({ requestTarget: `/items?${atCeiling}` })).toMatchObject({ allowed: true });
    expect(inspect({ requestTarget: `/items?${overCeiling}` })).toEqual(rejected('query_limit_exceeded'));
  });

  it(`${evidence} does not interpret a fragment as query data and avoids benign lookalike false positives`, () => {
    for (const requestTarget of [
      `/items?next=ok#api_key=${liveKey}`,
      '/items?monkey=value&tokenize=yes&api_keys=metadata',
      '/items?next=colp_live_&label=bearerish',
    ]) {
      expect(inspect({ requestTarget })).toMatchObject({ allowed: true, authorizationPresent: false });
    }
  });

  it(`${evidence} fails closed for accessor, Proxy, sparse, and dynamically exposed input`, () => {
    const accessor = Object.defineProperty({}, 'requestTarget', {
      enumerable: true,
      get: vi.fn(() => `/items?api_key=${liveKey}`),
    });
    const proxied = new Proxy({ requestTarget: '/items' }, {});
    const sparseAuthorization = new Array<string>(2);
    sparseAuthorization[1] = `Bearer ${liveKey}`;
    const authorizationAccessor = Object.defineProperty([`Bearer ${liveKey}`], '0', {
      get: vi.fn(() => `Bearer ${liveKey}`),
    });

    for (const input of [
      accessor,
      proxied,
      { requestTarget: '/items', authorization: sparseAuthorization },
      { requestTarget: '/items', authorization: authorizationAccessor },
    ]) {
      expect(enforceApiKeyTransport(input as ApiKeyTransportInput)).toEqual(rejected('invalid_input'));
    }
    expect(Object.getOwnPropertyDescriptor(accessor, 'requestTarget')?.get).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(authorizationAccessor, '0')?.get).not.toHaveBeenCalled();
  });

  it(`${evidence} never echoes a secret through decisions, thrown errors, or JSON serialization`, () => {
    const secrets = [liveKey, testKey, `Bearer ${liveKey}`];
    for (const secret of secrets) {
      let thrown: unknown;
      let decision: unknown;
      try {
        decision = inspect({ requestTarget: `/items?api_key=${encodeURIComponent(secret)}` });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      const observable = `${String(decision)}\n${JSON.stringify(decision)}\n${String(thrown)}`;
      expect(observable).not.toContain(secret);
    }
  });
});
