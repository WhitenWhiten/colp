import { describe, expect, it } from 'vitest';

import {
  createPublicationRepresentationHttpHeaders,
  createPublicationHttpHeaders,
  createPublicationRepresentationHeaders,
} from '../../src/server/publication-http-headers.js';

const evidence = '[evidence:http.validators]';
const base = {
  representation: '{"items":[1]}',
  revision: 'rev-1',
  projectionKey: 'public',
  queryContract: 'snapshotQuery' as const,
  query: { root: 'root', depth: 1, limit: 20, pageCursor: 'cursor-a' },
  negotiatedMediaType: 'application/json',
  protocolVersion: '0.1',
  lastModified: new Date('2026-07-18T01:02:03.987Z'),
};

describe(`PUB-0021 Publication HTTP validators ${evidence}`, () => {
  it(`builds a quoted strong ETag and IMF-fixdate, normalizing sub-second dates ${evidence}`, () => {
    const headers = createPublicationRepresentationHttpHeaders(base);
    expect(headers.get('etag')).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]+"$/);
    expect(headers.get('last-modified')).toBe('Sat, 18 Jul 2026 01:02:03 GMT');
  });

  it.each([
    ['representation bytes', { representation: '{"items":[2]}' }],
    ['projection', { projectionKey: 'compact' }],
    ['query', { query: { root: 'root', depth: 2, limit: 20, pageCursor: 'cursor-a' } }],
    ['pagination identity', { pageIdentity: { pageNumber: 2 } }],
    ['media type', { negotiatedMediaType: 'application/json;profile=compact' }],
    ['protocol version', { protocolVersion: '0.2' }],
    ['revision', { revision: 'rev-2' }],
  ])(`changes ETag when %s changes while revision may remain stable ${evidence}`, (_label, change) => {
    const first = createPublicationRepresentationHttpHeaders(base).get('etag');
    const second = createPublicationRepresentationHttpHeaders({ ...base, ...change }).get('etag');
    expect(second).not.toBe(first);
  });

  it(`distinguishes same revision representations and snapshot/page identity ${evidence}`, () => {
    const a = createPublicationRepresentationHeaders({ ...base, representation: 'A', snapshotIdentity: { snapshotId: 's', sequence: 1 }, pageIdentity: { key: 'p1' } }).get('etag');
    const b = createPublicationRepresentationHeaders({ ...base, representation: 'B', snapshotIdentity: { snapshotId: 's', sequence: 1 }, pageIdentity: { key: 'p1' } }).get('etag');
    const c = createPublicationHttpHeaders({ ...base, representation: 'A', snapshotIdentity: { snapshotId: 's', sequence: 2 }, pageIdentity: { key: 'p1' } }).get('etag');
    const d = createPublicationHttpHeaders({ ...base, representation: 'A', snapshotIdentity: { snapshotId: 's', sequence: 1 }, pageIdentity: { key: 'p2' } }).get('etag');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it(`preserves existing headers while replacing validators and merging negotiated Vary fields ${evidence}`, () => {
    const headers = createPublicationRepresentationHttpHeaders({ ...base, headers: { Origin: 'https://consumer.example', Vary: 'Origin, Accept', ETag: 'old', 'X-Trace': 'trace-1' } });
    expect(headers.get('origin')).toBe('https://consumer.example');
    expect(headers.get('vary')).toBe('Origin, Accept, Collection-Protocol-Version');
    expect(headers.get('x-trace')).toBe('trace-1');
    expect(headers.get('etag')).not.toBe('old');
  });

  it.each([
    ['invalid date', { lastModified: new Date(Number.NaN) }],
    ['CRLF header', { headers: { 'X-Bad': 'ok\r\nInjected: yes' } }],
    ['oversize representation', { representation: new Uint8Array(64 * 1024 * 1024 + 1) }],
    ['invalid media type', { negotiatedMediaType: 'application/*' }],
    ['query contract mismatch', { queryContract: 'none' as const, query: { unexpected: true } }],
  ])(`rejects %s without reflecting attacker input ${evidence}`, (_label, invalid) => {
    expect(() => createPublicationRepresentationHttpHeaders({ ...base, ...invalid })).toThrow();
    try {
      createPublicationRepresentationHttpHeaders({ ...base, ...invalid });
    } catch (error) {
      expect(String(error)).not.toContain('Injected');
      expect(String(error)).not.toContain('unexpected');
    }
  });

  it(`retains PUB-0006 strong ETag regression guarantees ${evidence}`, () => {
    const etag = createPublicationRepresentationHttpHeaders(base).get('etag') as string;
    expect(etag.startsWith('W/')).toBe(false);
    expect(etag).toMatch(/^"pub\.r1\./);
    expect(etag).not.toContain('cursor-a');
  });
});
