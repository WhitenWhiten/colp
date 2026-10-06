import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicationUtf8JsonBytes } from '../../src/server/publication-http-utf8.js';
import { preparePublicationSnapshotWire } from '../../src/server/publication-snapshot-wire.js';
import { preparedPublicationJsonBytes } from '../../src/server/publication-prepared-json.js';
import { createPublicationSnapshotPageResponse } from '../../src/server/publication-snapshot-next-link.js';

const fixture = () => JSON.parse(readFileSync(resolve(import.meta.dirname,
  '../../fixtures/protocol/examples/collection-snapshot.json'), 'utf8')) as unknown;

describe('Reuse only validated final Publication bytes', () => {
  it('retains the final representation and returns detached copies', () => {
    const prepared = preparePublicationSnapshotWire(fixture());
    const expected = new TextEncoder().encode(JSON.stringify(prepared));
    expect(preparedPublicationJsonBytes(prepared)).toEqual(expected);
    const first = publicationUtf8JsonBytes(prepared);
    first.fill(0);
    expect(publicationUtf8JsonBytes(prepared)).toEqual(expected);
    expect(preparedPublicationJsonBytes({ ...prepared })).toBeUndefined();
  });
  it('does not trust unregistered frozen inputs or invoke getters', () => {
    expect(() => publicationUtf8JsonBytes(Object.freeze({ value: NaN }))).toThrow(TypeError);
    let calls = 0;
    expect(() => publicationUtf8JsonBytes(Object.freeze({ get value() { calls++; return 1; } }))).toThrow(TypeError);
    expect(calls).toBe(0);
  });
  it('retains GET/HEAD metadata equivalence and absent HEAD/304 bodies', async () => {
    const get = createPublicationSnapshotPageResponse(fixture(), { method: 'GET' });
    const head = createPublicationSnapshotPageResponse(fixture(), { method: 'HEAD' });
    const cached = createPublicationSnapshotPageResponse(fixture(), { method: 'GET', status: 304 });
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.body).toBeNull();
    expect(cached.body).toBeNull();
    const body = await get.arrayBuffer();
    expect(Number(get.headers.get('content-length'))).toBe(body.byteLength);
  });
});
