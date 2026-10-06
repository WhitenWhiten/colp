import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import { planPublicationSnapshotDelivery, createPublicationSnapshotSinglePageResponse, composePublicationHttpRead } from '../../src/server/index.js';
import { ColpClient } from '../../src/client/index.js';
import type { Snapshot } from '../../src/types/index.js';

const namespace = 'https://example.test/review-public-extension';
function fixture(): Snapshot {
  return JSON.parse(readFileSync(resolve(import.meta.dirname,
    '../../fixtures/protocol/examples/collection-snapshot.json'), 'utf8')) as Snapshot;
}
function digest(snapshot: Snapshot): string {
  const { contentDigest: _oldDigest, ...value } = snapshot;
  return `sha-256=:${createHash('sha256').update(canonicalize(value)!).digest('base64')}:`;
}

describe('Snapshot public projection and content digest round-trip', () => {
  it.each([false, true])('finalizes composed HTTP responses and client reads; extension retained=%s', async retained => {
    const source = fixture();
    source.collection.extensions = { [namespace]: { note: 'public note', accessToken: 'private-token' } };
    source.annotations.push({ ...source.annotations[0]!, id: 'private-note', visibility: 'private', value: 'private note' });
    source.contentDigest = digest(source);
    const before = structuredClone(source);
    expect(validateSnapshotSemantics(source, { publicationExtensionMode: 'consumer' }).valid).toBe(true);
    const input = {
      access: 'anonymous-public' as const, endpoint: 'snapshot' as const,
      method: 'GET' as const, rawSearch: '', validators: createValidatorRegistry(),
      publicProjection: { publicExtensionNamespaces: retained ? [namespace] : [] },
      resolveRepresentation: () => ({ value: source, revision: source.revision,
        projectionKey: 'public', protocolVersion: source.protocolVersion,
        lastModified: new Date(source.generatedAt) }),
    };
    const response = await composePublicationHttpRead(input);
    const body = await response.clone().json() as Snapshot;
    expect(response.status).toBe(200);
    expect(body.contentDigest).toBe(digest(body));
    expect(body.contentDigest).not.toBe(source.contentDigest);
    expect(validateSnapshotSemantics(body, { publicationExtensionMode: 'consumer' }).valid).toBe(true);
    expect(body.annotations).toHaveLength(1);
    if (retained) expect(body.collection.extensions).toEqual({ [namespace]: { note: 'public note' } });
    else expect(body.collection.extensions).toBeUndefined();
    const head = await composePublicationHttpRead({ ...input, method: 'HEAD' });
    const cached = await composePublicationHttpRead({ ...input, ifNoneMatch: response.headers.get('etag')! });
    expect(head.body).toBeNull();
    expect(head.headers.get('etag')).toBe(response.headers.get('etag'));
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'));
    expect(cached.status).toBe(304);
    expect(cached.body).toBeNull();
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname,
      '../../fixtures/protocol/examples/public-manifest.json'), 'utf8')) as unknown;
    const fetch: typeof globalThis.fetch = async request => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      return response.clone();
    };
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch });
    expect((await client.getSnapshot(source.collection.id)).contentDigest).toBe(body.contentDigest);
    expect(source).toEqual(before);
  });

  it.each([false, true])('recomputes after projection; extension retained=%s', async retained => {
    const source = fixture();
    source.collection.extensions = { [namespace]: { note: 'approved public information' } };
    source.contentDigest = digest(source);
    const before = structuredClone(source);
    expect(validateSnapshotSemantics(source, { publicationExtensionMode: 'consumer' }).valid).toBe(true);
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: source });
    if (plan.delivery !== 'single-page') throw new Error('Expected a static single-page plan');
    const response = createPublicationSnapshotSinglePageResponse(plan, {
      method: 'GET', publicExtensionNamespaces: retained ? [namespace] : [],
    });
    const received = await response.json() as Snapshot;
    expect(response.status).toBe(200);
    expect(createValidatorRegistry().validate('snapshot', received).valid).toBe(true);
    expect(validateSnapshotSemantics(received, { publicationExtensionMode: 'consumer' })).toEqual({ valid: true, issues: [] });
    expect(received.contentDigest).toBe(digest(received));
    if (retained) expect(received.contentDigest).toBe(source.contentDigest);
    else expect(received.contentDigest).not.toBe(source.contentDigest);
    expect(source).toEqual(before);
  });

  it('does not invent an optional digest', async () => {
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: fixture() });
    if (plan.delivery !== 'single-page') throw new Error('Expected a single-page plan');
    expect(await createPublicationSnapshotSinglePageResponse(plan, { method: 'GET' }).json()).not.toHaveProperty('contentDigest');
  });
});
