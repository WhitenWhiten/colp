import assert from 'node:assert/strict';
import { test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { uploadBookmarkFavicon, type BookmarkFaviconCommandPorts } from '../../../src/modules/collections/application/bookmark-favicon-command.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');
const BODY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function commandPorts(overrides: {
  upsertFailsWith?: Error;
  retireFailsFor?: string;
  deleteFails?: boolean;
  withPrevious?: boolean;
  boundBeforeFailure?: boolean;
} = {}) {
  const trace = {
    puts: 0,
    deletes: 0,
    retired: [] as Array<{ objectId: string; deletableAt: number }>,
  };
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const bound = new Map<string, string>();
  if (overrides.withPrevious === true) bound.set('node-1', 'object-previous');
  const ports = {
    receipts: {
      claim: async () => ({ kind: 'claimed' }),
      complete: async () => undefined,
    },
    collections: {
      lockForUpdate: async () => ({ deletedAt: null }),
    },
    accessPolicy: {
      loadCollectionFacts: async () => ({
        collectionId: 'collection-1', ownerSubjectId: 'subject-1',
        visibility: 'private', policyRevision: 'policy-1', membershipRole: 'owner', deleted: false,
      }),
    },
    nodes: {
      getNode: async () => ({
        id: 'node-1', collectionId: 'collection-1', kind: 'bookmark',
        deletedAt: null, title: 't', url: 'https://example.com/x',
        parentId: 'parent-1', positionToken: 'p1', tags: [], description: null,
        visibility: 'private', resourceRevision: 'r1', createdAt: NOW, updatedAt: NOW,
      }),
    },
    bookmarkIcons: {
      findByNodeId: async (nodeId: string) => {
        const objectId = bound.get(nodeId);
        return objectId === undefined ? null : {
          nodeId, collectionId: 'collection-1', objectId, contentType: 'image/png',
          byteSize: 10, digestSha256: Buffer.alloc(32), createdAt: NOW, updatedAt: NOW,
        };
      },
      upsert: async (row: { nodeId: string; objectId: string }) => {
        if (overrides.upsertFailsWith) throw overrides.upsertFailsWith;
        // With a retirement fault injected, emulate the outer unit of work
        // rolling the fresh binding back after the retirement throws.
        if (overrides.retireFailsFor === undefined) bound.set(row.nodeId, row.objectId);
      },
    },
    faviconSources: {
      setMode: async () => undefined,
    },
    faviconStore: {
      put: async (objectId: string, body: Buffer, contentType: string) => {
        trace.puts += 1;
        objects.set(objectId, { body, contentType });
      },
      get: async (objectId: string) => objects.get(objectId) ?? null,
      delete: async (objectId: string) => {
        trace.deletes += 1;
        if (overrides.deleteFails) throw new Error('injected r2 delete failure');
        objects.delete(objectId);
      },
    },
    faviconGc: {
      recordRetired: async (input: { objectId: string; deletableAt: Date }) => {
        if (overrides.retireFailsFor !== undefined && input.objectId === overrides.retireFailsFor) {
          throw new Error('injected recordRetired failure');
        }
        trace.retired.push({ objectId: input.objectId, deletableAt: input.deletableAt.getTime() });
      },
    },
    // FO-C-02: production opens an INDEPENDENT transaction here (the command
    // transaction is aborted when this runs); the harness emulates the
    // fresh-transaction semantics: binding re-read, skip-when-bound, insert.
    orphanLedger: async (input: {
      objectId: string; nodeId: string; collectionId: string; at: Date;
    }) => {
      const current = bound.get(input.nodeId);
      if (current !== undefined && current === input.objectId) return;
      if (overrides.retireFailsFor !== undefined && input.objectId === overrides.retireFailsFor) {
        throw new Error('injected recordRetired failure');
      }
      trace.retired.push({ objectId: input.objectId, deletableAt: input.at.getTime() });
    },
    clock: { now: async () => NOW },
  } as unknown as BookmarkFaviconCommandPorts;
  return { ports, trace, objects, bound };
}

const uploadInput = () => ({
  actor: { principalId: 'principal-1', subjectId: 'subject-1' },
  commandId: '11111111-1111-4111-8111-111111111111',
  collectionId: 'collection-1',
  nodeId: 'node-1',
  body: BODY,
  contentType: 'image/png',
  productOrigin: 'https://app.example.test',
});

test('FO-C-02 upload: DB write failure with delete failure still ledgers the unbound object', async () => {
  const { ports, trace } = commandPorts({
    upsertFailsWith: new Error('db down'), deleteFails: true,
  });
  await assert.rejects(() => uploadBookmarkFavicon(ports!, uploadInput()), /db down/);
  assert.equal(trace.puts, 1);
  assert.equal(trace.deletes, 1);
  assert.equal(trace.retired.length, 1, 'unbound object must be ledged for GC');
  assert.equal(trace.retired[0]!.deletableAt, NOW.getTime(), 'unbound objects are immediately deletable');
  const objectId = trace.retired[0]!.objectId;
  assert.equal(ports!.faviconStore, ports!.faviconStore);
  assert.ok(await ports!.faviconStore.get(objectId), 'object still exists (delete failed)');
});

test('FO-C-02 upload: normal success never ledges the new object', async () => {
  const { ports, trace } = commandPorts();
  const result = await uploadBookmarkFavicon(ports!, uploadInput());
  assert.equal(result.kind, 'created');
  assert.equal(trace.retired.length, 0);
});

test('FO-C-02 upload: previous-binding retirement failure ledges the new object', async () => {
  const { ports, trace, bound } = commandPorts({ withPrevious: true, retireFailsFor: 'object-previous' });
  await assert.rejects(() => uploadBookmarkFavicon(ports!, uploadInput()), /recordRetired/);
  assert.equal(trace.retired.length, 1, 'new object must be ledged when retirement rolled back');
});
