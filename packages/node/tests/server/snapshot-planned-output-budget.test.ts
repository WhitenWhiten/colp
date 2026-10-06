import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  planPublicationSnapshotDelivery, createPublicationSnapshotSinglePageResponse,
  PublicationPublicProjectionError,
} from '../../src/server/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';
import { ColpClient, ColpWireValidationError } from '../../src/client/index.js';

function largeSnapshot(): Snapshot {
  const snapshot = JSON.parse(readFileSync(resolve(import.meta.dirname,
    '../../fixtures/protocol/examples/collection-snapshot.json'), 'utf8')) as Snapshot;
  const root = snapshot.nodes.find(node => node.kind === 'root')!;
  snapshot.nodes = [root];
  snapshot.annotations = [];
  for (let index = 0; index < 10_000; index += 1) {
    const node: StrictNode = {
      id: `output-folder-${index}`, collectionId: snapshot.collection.id,
      kind: 'folder', parentId: root.id, position: index.toString(36), title: 'Folder',
      createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt,
      revision: snapshot.revision, extensions: {},
    };
    snapshot.nodes.push(node);
  }
  return snapshot;
}

describe('A static delivery plan carries a compatible default output budget', () => {
  it('round-trips large output with explicit receiver limits and preserves the default parser cap', async () => {
    const source = largeSnapshot();
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: source });
    if (plan.delivery !== 'single-page') throw new Error('Expected a static single-page plan');
    const response = createPublicationSnapshotSinglePageResponse(plan, { method: 'GET', headers: { ETag: '"large-r1"' } });
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname,
      '../../fixtures/protocol/examples/public-manifest.json'), 'utf8')) as unknown;
    const fetch: typeof globalThis.fetch = async request => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      return url.pathname === '/.well-known/collection-protocol' ? Response.json(manifest) : response.clone();
    };
    const options = { manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch };
    const rejected = await new ColpClient(options).getSnapshot(source.collection.id).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ColpWireValidationError);
    expect(rejected).toMatchObject({ stage: 'parse', cause: { code: 'max_members' } });
    const client = new ColpClient({ ...options, jsonLimits: { maxMembers: 1_000_000 },
      requestLimits: { maxBytes: 64 * 1024 * 1024 },
      snapshotLimits: { maxObjects: 1_000_000, maxBytes: 64 * 1024 * 1024 } });
    const received = await client.getSnapshot(source.collection.id);
    expect(received.nodes).toHaveLength(source.nodes.length);
    expect(validateSnapshotSemantics(received, { publicationExtensionMode: 'consumer' }).valid).toBe(true);
  }, 30_000);

  it('delivers a 10,000-folder snapshot with default options', async () => {
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: largeSnapshot() });
    if (plan.delivery !== 'single-page') throw new Error('Expected a static single-page plan');
    const response = createPublicationSnapshotSinglePageResponse(plan, { method: 'GET' });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as Snapshot;
    expect(snapshot.nodes).toHaveLength(10_001);
    expect(validateSnapshotSemantics(snapshot, { publicationExtensionMode: 'consumer' }).valid).toBe(true);
  }, 30_000);
  it('honors an explicitly tighter projection budget', () => {
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: largeSnapshot() });
    if (plan.delivery !== 'single-page') throw new Error('Expected a single-page plan');
    expect(() => createPublicationSnapshotSinglePageResponse(plan, {
      method: 'GET', publicProjectionLimits: { maxNodes: 10 },
    })).toThrow(PublicationPublicProjectionError);
  });
  it('does not invoke accessors while resolving output options', () => {
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: largeSnapshot() });
    if (plan.delivery !== 'single-page') throw new Error('Expected a single-page plan');
    let reads = 0;
    expect(() => createPublicationSnapshotSinglePageResponse(plan, {
      method: 'GET', get publicProjectionLimits() { reads += 1; return {}; },
    })).toThrow(TypeError);
    expect(reads).toBe(0);
  });
  it('rejects a copied single-page capability', () => {
    const plan = planPublicationSnapshotDelivery({ classification: 'static', query: {}, snapshot: largeSnapshot() });
    if (plan.delivery !== 'single-page') throw new Error('Expected a single-page plan');
    expect(() => createPublicationSnapshotSinglePageResponse({ ...plan }, { method: 'GET' })).toThrow(TypeError);
  });
});
