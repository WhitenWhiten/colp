import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  buildPublicationDiscoveryOutput,
  composePublicationHttpRead,
  createPublicationDiscoveryPage,
  createPublicationSnapshotPageResponse,
  planPublicationSnapshotDelivery,
  mergePublicationAntiDiscoveryHeaders,
  parseIJson,
  validateServerWireDocument,
  selectPublicationDiscoveryCandidates,
  type PublicationHttpReadRepresentation,
} from '../../src/server/index.js';

const coverage = '[coverage:server-boundaries-completion]';
const validators = createValidatorRegistry();
const lastModified = new Date('2026-07-19T01:02:03.000Z');
const snapshotFixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-snapshot.json');

function isPublicDiscoveryItem(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return validators.validate('visibility', candidate.visibility).valid
    && candidate.visibility === 'public'
    && validators.validate('opaqueId', candidate.id).valid;
}
const throws = (_value: unknown): _value is Record<string, unknown> => { throw new Error('validator'); };

function representation(value: unknown, change: Record<string, unknown> = {}): PublicationHttpReadRepresentation {
  return {
    value,
    revision: 'coverage-revision',
    projectionKey: 'public',
    protocolVersion: '0.1',
    lastModified,
    ...change,
  } as PublicationHttpReadRepresentation;
}

function readInput(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access: 'anonymous-public',
    endpoint: 'metadata',
    method: 'GET',
    rawSearch: '',
    validators,
    resolveRepresentation: () => representation({ collection: { id: 'coverage' } }),
    ...change,
  };
}

describe(`server coverage boundary completion ${coverage}`, () => {
  it(`decodes every supported JSON key escape and audits escaped prohibited names ${coverage}`, () => {
    const value = parseIJson('{"a\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0062":1}') as Record<string, unknown>;
    expect(value['a"\\/\b\f\n\r\tb']).toBe(1);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const escaped = JSON.stringify(key).replaceAll('_', '\\u005f');
      expect(() => parseIJson(`{${escaped}:1}`)).toThrow(SyntaxError);
    }
  });

  it(`rejects malformed JSON and reports semantic validation without leaking parser details ${coverage}`, () => {
    expect(() => parseIJson('{"unterminated":')).toThrow(SyntaxError);
    const parseFailure = validateServerWireDocument(
      validators,
      'manifest',
      '{"unterminated":',
      () => ({ valid: true, issues: [] }),
    );
    expect(parseFailure).toMatchObject({ valid: false, stage: 'parse' });
    const semanticFailure = validateServerWireDocument(
      validators,
      'manifest',
      '{}',
      () => ({ valid: false, issues: [{ code: 'invalid', message: 'invalid', path: '' }] }),
    );
    expect(semanticFailure).toMatchObject({ valid: false });
  });

  it(`fails closed for malformed HTTP read inputs before invoking callbacks ${coverage}`, async () => {
    const invalidInputs = [
      null,
      [],
      {},
      readInput({ endpoint: 'unknown' }),
      readInput({ method: 'POST' }),
      readInput({ access: 'unknown' }),
      readInput({ rawSearch: 42 }),
      readInput({ validators: {} }),
      readInput({ validators: null }),
      readInput({ resolveRepresentation: 42 }),
      readInput({ extra: true }),
    ];
    for (const input of invalidInputs) {
      await expect(composePublicationHttpRead(input as never)).rejects.toThrow(TypeError);
    }

    const accessor = Object.defineProperty(readInput(), 'rawSearch', {
      enumerable: true,
      get: () => { throw new Error('raw-search-secret'); },
    });
    await expect(composePublicationHttpRead(accessor as never)).rejects.toThrow(TypeError);
    await expect(composePublicationHttpRead({
      ...readInput({ access: 'authorized-private' }),
      authorize: () => ({ allowed: true, context: {} }),
      resolveRepresentation: undefined,
    } as never)).rejects.toThrow(TypeError);
    const nullRepresentation = await composePublicationHttpRead({
      access: 'anonymous-public', endpoint: 'metadata', method: 'GET', rawSearch: '', validators,
      resolveRepresentation: () => null as never,
    });
    expect(nullRepresentation.status).toBe(500);

    const inheritedValidators = Object.create({ validate: () => true });
    const inheritedResponse = await composePublicationHttpRead(readInput({ validators: inheritedValidators }) as never);
    expect(inheritedResponse.status).toBe(500);
    const proxiedValidators = new Proxy(inheritedValidators, { get: () => { throw new Error('validator-secret'); } });
    await expect(composePublicationHttpRead(readInput({ validators: proxiedValidators }) as never)).rejects.toThrow(TypeError);
    await expect(composePublicationHttpRead({
      ...readInput({ endpoint: 'directory', rawSearch: '?limit=1' }),
      validators: { validate: () => { throw new Error('validator-failure'); } },
    } as never)).resolves.toMatchObject({ status: 500 });
  });

  it(`validates authorization decisions and representation snapshots at the boundary ${coverage}`, async () => {
    const authorized = (authorize: () => unknown, change: Record<string, unknown> = {}) => composePublicationHttpRead({
      access: 'authorized-private',
      endpoint: 'metadata',
      method: 'GET',
      rawSearch: '',
      validators,
      authorize: authorize as never,
      resolveRepresentation: (() => representation({ collection: { id: 'coverage' } }, {
        principalScope: 'coverage-principal',
        ...change,
      })) as never,
    } as never);

    for (const decision of [null, [], {}, { allowed: true }, { allowed: false, problem: 'bad' }, { allowed: true, context: {}, extra: 1 }]) {
      await expect(authorized(() => decision)).rejects.toThrow(TypeError);
    }
    for (const change of [
      { value: null },
      { value: [] },
      { lastModified: 'not-a-date' },
      { headers: [['x-valid', 1]] },
      { headers: [['x-valid', 'yes']] },
      { headers: [['bad name', 'yes']] },
      { headers: Object.create(null, { 'x-valid': { enumerable: true, value: 1 } }) },
      { cacheControl: [1] },
      { cacheControl: {} },
      { vary: [1] },
      { snapshotIdentity: [] },
      { snapshotIdentity: new Date() },
      { pageIdentity: { unsupported: true } },
    ]) {
      const response = await authorized(() => ({ allowed: true, context: {} }), change);
      expect(response.status).toBe(500);
    }
    const headerArray = [['x-valid', 'yes']] as unknown as Array<unknown> & { extra?: boolean };
    headerArray.extra = true;
    const malformedHeaders = await authorized(() => ({ allowed: true, context: {} }), { headers: headerArray });
    expect(malformedHeaders.status).toBe(500);

    for (const headers of [
      [['x-valid', 'yes', 'extra']],
      [[, 'yes']],
      Object.create({ inherited: 'yes' }),
      new Headers({ 'x-valid': 'yes' }),
    ]) {
      const response = await authorized(() => ({ allowed: true, context: {} }), { headers });
      expect(response.status).toBe(500);
    }
  });

  it(`covers anonymous discovery selection, issued pages, and anti-discovery headers ${coverage}`, () => {
    const item = { visibility: 'public', id: 'candidate-1' };
    const selected = selectPublicationDiscoveryCandidates('anonymous-directory', [item], isPublicDiscoveryItem);
    const page = createPublicationDiscoveryPage(selected, { items: [selected.items[0]!], nextCursor: null });
    expect(buildPublicationDiscoveryOutput(page)).toMatchObject({ channel: 'anonymous-directory', nextCursor: null });

    for (const channel of ['bad', ''] as const) {
      expect(() => selectPublicationDiscoveryCandidates(channel as never, [], isPublicDiscoveryItem)).toThrow(TypeError);
    }
    expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', [{ visibility: 'public' }], isPublicDiscoveryItem)).toThrow(TypeError);
    expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', [{ visibility: 'unknown' }], isPublicDiscoveryItem)).toThrow(TypeError);
    expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', [item, { visibility: 'private', secret: 'hidden' }], isPublicDiscoveryItem)).not.toThrow();
    expect(() => createPublicationDiscoveryPage(selected, { items: [item], nextCursor: null })).toThrow(TypeError);
    expect(() => createPublicationDiscoveryPage({} as never, { items: [], nextCursor: null })).toThrow(TypeError);
    expect(() => createPublicationDiscoveryPage(null as never, { items: [], nextCursor: null })).toThrow(TypeError);
    expect(() => buildPublicationDiscoveryOutput({} as never)).toThrow(TypeError);
    expect(() => buildPublicationDiscoveryOutput(null as never)).toThrow(TypeError);

    for (const candidates of [
      null,
      { 0: item, length: 1 },
      (() => { const value = [item]; (value as unknown as { extra: boolean }).extra = true; return value; })(),
      new Array(1),
    ]) {
      expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', candidates, isPublicDiscoveryItem)).toThrow(TypeError);
    }
    expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', [], undefined as never)).toThrow(TypeError);
    // Throwing stub only: not a schema proof.
    expect(() => selectPublicationDiscoveryCandidates('anonymous-directory', [item], throws)).toThrow(TypeError);
    expect(() => createPublicationDiscoveryPage(selected, { items: [], nextCursor: 42 as never })).toThrow(TypeError);
    expect(() => createPublicationDiscoveryPage(selected, { items: [], nextCursor: 'x'.repeat(8193) })).toThrow(TypeError);
    expect(() => selectPublicationDiscoveryCandidates(
      'anonymous-directory',
      Array.from({ length: 10_001 }, () => item),
      isPublicDiscoveryItem,
    )).toThrow(RangeError);
    let valid = true;
    const mutableSelection = selectPublicationDiscoveryCandidates(
      'anonymous-directory',
      [item],
      (value): value is Record<string, unknown> => valid && isPublicDiscoveryItem(value),
    );
    valid = false;
    expect(() => buildPublicationDiscoveryOutput(createPublicationDiscoveryPage(
      mutableSelection,
      { items: [mutableSelection.items[0]!], nextCursor: null },
    ))).toThrow(TypeError);

    const headersWithForbidden = Object.create(null) as Record<string, string>;
    headersWithForbidden.__proto__ = 'blocked';
    expect(() => mergePublicationAntiDiscoveryHeaders(headersWithForbidden)).toThrow(TypeError);
    expect(() => mergePublicationAntiDiscoveryHeaders([['x-valid', 'yes', 'extra'] as never])).toThrow(TypeError);
    expect(() => mergePublicationAntiDiscoveryHeaders({ 'x-valid': '\0' })).toThrow(TypeError);
    expect(() => mergePublicationAntiDiscoveryHeaders({ 'x-valid': 'x'.repeat(8193) })).toThrow(RangeError);
  
    expect(mergePublicationAntiDiscoveryHeaders()).toMatchObject({});
    expect(mergePublicationAntiDiscoveryHeaders({ 'X-Coverage': 'yes' }).get('x-robots-tag')).toBe('noindex, nofollow');
    expect(mergePublicationAntiDiscoveryHeaders([['X-Coverage', 'yes']]).get('referrer-policy')).toBe('no-referrer');
    expect(() => mergePublicationAntiDiscoveryHeaders({ 'Bad Header': 'yes' })).toThrow(TypeError);
  });

  it(`covers Snapshot response status and header cleanup boundaries ${coverage}`, () => {
    const body = { type: 'about:blank', status: 204 };
    for (const status of [204, 205]) {
      const response = createPublicationSnapshotPageResponse(body, {
        method: 'HEAD',
        status,
        headers: { Link: '<https://example.test>; rel="next"', 'X-Coverage': 'yes' },
      });
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get('link')).toBeNull();
    }
    expect(() => createPublicationSnapshotPageResponse(body, {
      method: 'GET',
      status: 200,
      headers: { 'Bad Header': 'yes' },
    })).toThrow(TypeError);
    expect(() => createPublicationSnapshotPageResponse(body, {
      method: 'GET',
      status: 200,
      nextUrl: 42 as never,
    })).toThrow(TypeError);
  });

  it(`rejects malformed Snapshot delivery inputs and limits before adapter emission ${coverage}`, () => {
    const snapshot = JSON.parse(readFileSync(snapshotFixturePath, 'utf8')) as Record<string, unknown>;
    for (const input of [
      null,
      {},
      { classification: 'unknown', query: {}, snapshot },
      { classification: 'static', query: { unsupported: true }, snapshot },
      { classification: 'dynamic', query: {}, snapshot: null },
    ]) {
      expect(() => planPublicationSnapshotDelivery(input as never)).toThrow();
    }
    expect(() => planPublicationSnapshotDelivery(
      { classification: 'static', query: {}, snapshot },
      { limits: { smallMaxUtf8Bytes: 1 } },
    )).not.toThrow();
    expect(() => planPublicationSnapshotDelivery(
      { classification: 'dynamic', query: {}, snapshot },
      { limits: {} },
    )).not.toThrow();
    expect(() => planPublicationSnapshotDelivery(
      { classification: 'dynamic', query: {}, snapshot },
      { limits: { hardMaxUtf8Bytes: 0 } },
    )).toThrow();
    try {
      planPublicationSnapshotDelivery({ classification: 'unknown', query: {}, snapshot } as never);
      throw new Error('Expected invalid classification to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).cause).toBeInstanceOf(TypeError);
    }
  });
});
