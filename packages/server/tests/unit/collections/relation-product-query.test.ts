import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Relation } from '@know-n/colp/types';
import {
  RelationProductReadError,
  createProductEditorCursorSigner,
  createProductRelationCursorSigner,
  getProductRelation,
  getProductRelationPage,
  type ProductRelationReadPorts,
  type ProductRelationRow,
} from '../../../src/modules/collections/index.js';

const COLLECTION_ID = 'relations-product-collection';
const NODE_ID = 'relations-product-node';
const NOW = new Date('2026-07-25T10:00:00.000Z');
const signer = createProductRelationCursorSigner({
  current: { id: 'relation-v1', key: 'relation-product-cursor-key-material' },
});

function row(id: string, updatedAt: string, overrides: Partial<Relation> = {}): ProductRelationRow {
  const payload: Relation = {
    id, collectionId: COLLECTION_ID, fromNodeId: NODE_ID, toNodeId: `to-${id}`,
    type: 'related', label: `Relation ${id}`, visibility: 'protected',
    revision: `revision-${id}`, createdAt: updatedAt, updatedAt, extensions: {}, ...overrides,
  };
  return { id, collectionId: COLLECTION_ID, fromNodeId: payload.fromNodeId,
    toNodeId: payload.toNodeId, payload, resourceRevision: payload.revision,
    updatedAt: new Date(updatedAt), deletedAt: null };
}

function ports(rows: readonly ProductRelationRow[], options: {
  principalId?: string; subjectId?: string; role?: 'owner' | 'editor' | 'viewer' | null;
  visibility?: 'private' | 'protected' | 'unlisted' | 'public'; policyRevision?: string; now?: Date;
} = {}): ProductRelationReadPorts {
  return {
    clock: { now: async () => new Date(options.now ?? NOW) }, cursorSigner: signer,
    accessPolicy: { loadCollectionFacts: async () => ({
      collectionId: COLLECTION_ID, ownerSubjectId: options.role === 'owner' ? (options.subjectId ?? 'owner') : 'owner',
      visibility: options.visibility ?? 'private', policyRevision: options.policyRevision ?? 'policy-1',
      membershipRole: options.role === 'owner' ? 'owner'
        : Object.hasOwn(options, 'role') ? (options.role ?? null) : 'viewer', deleted: false,
    }) },
    reads: {
      loadLiveNode: async ({ nodeId }) => rows.some((candidate) => candidate.fromNodeId === nodeId
        || candidate.toNodeId === nodeId)
        ? { id: nodeId, collectionId: COLLECTION_ID, visibility: options.visibility ?? 'private' } : null,
      loadLiveById: async ({ relationId }) => rows.find((candidate) => candidate.id === relationId) ?? null,
      listLiveByNode: async ({ direction, types, visibilities, endpointVisibilities, limit, after }) => rows
        .filter((candidate) => direction === 'outgoing'
          ? candidate.fromNodeId === NODE_ID : candidate.toNodeId === NODE_ID)
        .filter((candidate) => types.length === 0 || types.includes(candidate.payload.type))
        .filter((candidate) => visibilities.length === 0 || visibilities.includes(candidate.payload.visibility))
        .filter((candidate) => (!candidate.fromVisibility || endpointVisibilities.includes(candidate.fromVisibility))
          && (!candidate.toVisibility || endpointVisibilities.includes(candidate.toVisibility)))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id, 'en'))
        .filter((candidate) => !after || candidate.updatedAt < new Date(after.updatedAt)
          || (candidate.updatedAt.getTime() === new Date(after.updatedAt).getTime() && candidate.id > after.id))
        .slice(0, limit + 1),
    },
  };
}

describe('P2B-12 Relation Product query', () => {
  test('merges both endpoint branches with the stable updated-desc/id-asc comparator without gaps', async () => {
    const rows = [
      row('a', '2026-07-25T09:00:00.000Z'),
      row('b', '2026-07-25T09:00:00.000Z', { fromNodeId: 'from-b', toNodeId: NODE_ID }),
      row('c', '2026-07-25T08:00:00.000Z'),
      row('d', '2026-07-25T07:00:00.000Z', { fromNodeId: 'from-d', toNodeId: NODE_ID }),
      row('e', '2026-07-25T06:00:00.000Z'),
    ];
    const actor = { principalId: 'principal-owner', subjectId: 'owner' };
    const first = await getProductRelationPage(ports(rows, { role: 'owner', subjectId: actor.subjectId }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'both', actor, limit: 2,
      types: ['supports', 'related'], visibilities: ['protected', 'public'],
    });
    assert.deepEqual(first.relations.map((item) => item.id), ['a', 'b']);
    assert.ok(first.page.nextCursor);
    const second = await getProductRelationPage(ports(rows, { role: 'owner', subjectId: actor.subjectId }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'both', actor,
      cursor: first.page.nextCursor!, types: ['related', 'supports'], visibilities: ['public', 'protected'],
    });
    assert.deepEqual(second.relations.map((item) => item.id), ['c', 'd']);
    assert.ok(second.page.nextCursor);
    const third = await getProductRelationPage(ports(rows, { role: 'owner', subjectId: actor.subjectId }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'both', actor,
      cursor: second.page.nextCursor!, types: ['supports', 'related'], visibilities: ['protected', 'public'],
    });
    assert.deepEqual(third.relations.map((item) => item.id), ['e']);
    assert.equal(new Set([...first.relations, ...second.relations, ...third.relations].map((item) => item.id)).size, 5);
  });

  test('binds cursor to node, direction, canonical filters, principal, limit, policy and purpose', async () => {
    const rows = [row('a', '2026-07-25T09:00:00.000Z'), row('b', '2026-07-25T08:00:00.000Z')];
    const actor = { principalId: 'principal-owner', subjectId: 'owner' };
    const first = await getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner' }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, limit: 1,
      types: ['related'], visibilities: ['protected'],
    });
    for (const changed of [
      { nodeId: 'other-node' }, { direction: 'incoming' as const },
      { types: ['supports'] as const }, { visibilities: ['public'] as const },
      { actor: { principalId: 'other-principal', subjectId: 'owner' } },
    ]) {
      await assert.rejects(getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner' }), {
        collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor,
        types: ['related'], visibilities: ['protected'], cursor: first.page.nextCursor!, ...changed,
      }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'invalid_cursor');
    }
    await assert.rejects(getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner', policyRevision: 'policy-2' }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor,
      types: ['related'], visibilities: ['protected'], cursor: first.page.nextCursor!,
    }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'invalid_cursor');
  });

  test('conceals item existence and applies owner/editor/viewer/outsider visibility rules', async () => {
    const privateRow = row('private', '2026-07-25T09:00:00.000Z', { visibility: 'private' });
    const protectedRow = row('protected', '2026-07-25T08:00:00.000Z', { visibility: 'protected' });
    const publicRow = row('public', '2026-07-25T07:00:00.000Z', { visibility: 'public' });
    for (const role of ['owner', 'editor'] as const) {
      const result = await getProductRelation(ports([privateRow], { role, subjectId: role }), {
        collectionId: COLLECTION_ID, relationId: privateRow.id,
        actor: { principalId: role, subjectId: role },
      });
      assert.equal(result.id, privateRow.id);
    }
    await assert.rejects(getProductRelation(ports([privateRow], { role: 'viewer', subjectId: 'viewer' }), {
      collectionId: COLLECTION_ID, relationId: privateRow.id,
      actor: { principalId: 'viewer', subjectId: 'viewer' },
    }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'relation_not_found');
    assert.equal((await getProductRelation(ports([protectedRow], { role: 'viewer' }), {
      collectionId: COLLECTION_ID, relationId: protectedRow.id,
      actor: { principalId: 'viewer', subjectId: 'viewer' },
    })).id, protectedRow.id);
    assert.equal((await getProductRelation(ports([publicRow], { role: null, visibility: 'public' }), {
      collectionId: COLLECTION_ID, relationId: publicRow.id,
      actor: { principalId: 'outsider', subjectId: 'outsider' },
    })).id, publicRow.id);
  });

  test('maps an explicit DTO without payload or internal authority facts', async () => {
    const result = await getProductRelation(ports([row('a', '2026-07-25T09:00:00.000Z')], { role: 'owner', subjectId: 'owner' }), {
      collectionId: COLLECTION_ID, relationId: 'a', actor: { principalId: 'owner', subjectId: 'owner' },
    });
    assert.deepEqual(Object.keys(result).sort(), [
      'collectionId', 'createdAt', 'extensions', 'fromNodeId', 'id', 'label', 'revision',
      'toNodeId', 'type', 'updatedAt', 'visibility',
    ]);
  });

  test('redacts extension namespaces for an authenticated outsider on a public collection', async () => {
    const publicRow = row('public-with-extension', '2026-07-25T09:00:00.000Z', {
      visibility: 'public', extensions: { internal: { traceId: 'secret' } },
    });
    const result = await getProductRelation(ports([publicRow], {
      role: null, subjectId: 'outsider', visibility: 'public',
    }), {
      collectionId: COLLECTION_ID, relationId: publicRow.id,
      actor: { principalId: 'principal-outsider', subjectId: 'outsider' },
    });
    assert.deepEqual(result.extensions, {});
  });

  test('pushes endpoint visibility into the bounded branch so concealed rows cannot consume the page', async () => {
    const hidden = { ...row('hidden', '2026-07-25T09:00:00.000Z', { visibility: 'public' }),
      fromVisibility: 'private' as const, toVisibility: 'public' as const };
    const visible = { ...row('visible', '2026-07-25T08:00:00.000Z', { visibility: 'public' }),
      fromVisibility: 'public' as const, toVisibility: 'public' as const };
    const result = await getProductRelationPage(ports([hidden, visible], { role: null, visibility: 'public' }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', limit: 1,
      actor: { principalId: 'outsider', subjectId: 'outsider' },
    });
    assert.deepEqual(result.relations.map((relation) => relation.id), ['visible']);
  });

  test('fails closed for tampering, expiry, and cross-purpose Editor cursor replay', async () => {
    const rows = [row('a', '2026-07-25T09:00:00.000Z'), row('b', '2026-07-25T08:00:00.000Z')];
    const actor = { principalId: 'principal-owner', subjectId: 'owner' };
    const first = await getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner' }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, limit: 1,
    });
    const cursor = first.page.nextCursor!;
    const editorCursor = createProductEditorCursorSigner({
      current: { id: 'relation-v1', key: 'relation-product-cursor-key-material' },
    }).sign({ v: 1, purpose: 'product-editor-cursor', principalId: actor.principalId,
      collectionId: COLLECTION_ID, limit: 1, comparatorVersion: 'v1',
      after: { parentKey: '', positionKey: '', nodeId: NODE_ID }, contentRevision: 'content-1',
      policyRevision: 'policy-1', snapshotId: 'snapshot-1', issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString() });
    for (const invalid of [`${cursor.slice(0, -1)}x`, editorCursor]) {
      await assert.rejects(getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner' }), {
        collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, cursor: invalid,
      }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'invalid_cursor');
    }
    await assert.rejects(getProductRelationPage(ports(rows, { role: 'owner', subjectId: 'owner',
      now: new Date(NOW.getTime() + 16 * 60 * 1000) }), {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, cursor,
    }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'invalid_cursor');
  });

  test('continues across retained-key rotation and rejects an unknown keyring', async () => {
    const rows = [row('a', '2026-07-25T09:00:00.000Z'), row('b', '2026-07-25T08:00:00.000Z')];
    const actor = { principalId: 'principal-owner', subjectId: 'owner' };
    const old = createProductRelationCursorSigner({ current: { id: 'old', key: 'relation-old-key-material' } });
    const first = await getProductRelationPage({ ...ports(rows, { role: 'owner', subjectId: 'owner' }), cursorSigner: old }, {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, limit: 1,
    });
    const rotated = createProductRelationCursorSigner({ current: { id: 'new', key: 'relation-new-key-material' },
      previous: [{ id: 'old', key: 'relation-old-key-material', retainUntil: '2026-07-25T11:00:00Z' }] });
    const continued = await getProductRelationPage({ ...ports(rows, { role: 'owner', subjectId: 'owner' }),
      cursorSigner: rotated }, { collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor,
      cursor: first.page.nextCursor! });
    assert.deepEqual(continued.relations.map((relation) => relation.id), ['b']);
    await assert.rejects(getProductRelationPage({ ...ports(rows, { role: 'owner', subjectId: 'owner' }),
      cursorSigner: createProductRelationCursorSigner({ current: { id: 'other', key: 'relation-other-key-material' } }) }, {
      collectionId: COLLECTION_ID, nodeId: NODE_ID, direction: 'outgoing', actor, cursor: first.page.nextCursor!,
    }), (error: unknown) => error instanceof RelationProductReadError && error.code === 'invalid_cursor');
  });
});
