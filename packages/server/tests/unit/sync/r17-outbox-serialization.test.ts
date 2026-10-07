import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation, SyncPullEvent, SyncPullEventV02 } from '@know-n/colp/types';
import { SyncPullReadError } from '../../../src/modules/sync/application/sync-pull.js';
import type { TrustedSyncNodeRevision } from '../../../src/modules/sync/sync-node-update.js';
import { byteAwareEventCount } from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import {
  buildV01OperationEvent,
  buildV02CreateNodeEvent,
  measureByteAwareEventCount,
  measurePullPageResponseSerialization,
  measureSyncNodeUpdateBudget,
  measureSyncPullCursorSerialization,
  runR17OutboxSerializationEvidence,
  type R17OutboxSerializationEvidence,
} from '../../../scripts/evidence/r17-outbox-serialization.js';

const COLLECTION_ID = 'r17-collection';
const ROOT_ID = 'r17-root';
const NODE_ID = 'r17-node';
const CURSOR_PREFIX = 'r17-cursor';
const MAX_BUDGET = Number.MAX_SAFE_INTEGER;

function createNodeOperation(index: number, options: { readonly unicode?: boolean } = {}): Operation {
  const title = options.unicode ? `R17 node ${index} 中文 🎯 描述` : `R17 node ${index}`;
  return {
    opId: `op-r17-${String(index).padStart(5, '0')}`,
    replicaId: 'replica-r17',
    sequence: index,
    collectionId: COLLECTION_ID,
    type: 'create_node',
    baseRevision: null,
    occurredAt: '2026-07-26T00:00:00Z',
    dependencies: [],
    payload: {
      parentId: ROOT_ID,
      node: {
        kind: 'bookmark',
        title,
        url: `https://example.test/r17/${index}`,
        description: options.unicode
          ? 'description with unicode 描述 and an emoji 🎯 evidence payload'
          : `description for node ${index}`,
        tags: ['r17', ...(options.unicode ? ['证据'] : [])],
        visibility: 'inherit',
        extensions: {},
      },
    },
  } as Operation;
}

function createMaxPayloadOperation(index: number): Operation {
  return {
    opId: `op-r17-max-${String(index).padStart(5, '0')}`,
    replicaId: 'replica-r17',
    sequence: 1_000 + index,
    collectionId: COLLECTION_ID,
    type: 'create_node',
    baseRevision: null,
    occurredAt: '2026-07-26T00:00:00Z',
    dependencies: [],
    payload: {
      parentId: ROOT_ID,
      node: {
        kind: 'bookmark',
        title: `R17 large payload node ${index}`,
        url: `https://example.test/r17/large/${index}`,
        description: 'x'.repeat(8_192),
        tags: Array.from({ length: 64 }, (_, tagIndex) => `tag-${tagIndex}`),
        visibility: 'inherit',
        extensions: { 'https://extensions.example/large': { nested: Array.from({ length: 128 }, (_, i) => i) } },
      },
    },
  } as Operation;
}

function v01OperationEvents(count: number): SyncPullEvent[] {
  return Array.from({ length: count }, (_, index) => buildV01OperationEvent(
    createNodeOperation(index + 1), `${CURSOR_PREFIX}-${String(index + 1).padStart(5, '0')}`,
  ));
}

function v02CreateNodeEvents(count: number): SyncPullEventV02[] {
  return Array.from({ length: count }, (_, index) => buildV02CreateNodeEvent(
    createNodeOperation(index + 1), `${CURSOR_PREFIX}-v2-${String(index + 1).padStart(5, '0')}`,
  ));
}

test('R17 v0.1 operation event preserves the wire contract and the operation document', () => {
  const operation = createNodeOperation(1, { unicode: true });
  const event = buildV01OperationEvent(operation, `${CURSOR_PREFIX}-00001`);
  assert.equal(event.cursor, `${CURSOR_PREFIX}-00001`);
  assert.equal(event.kind, 'operation');
  assert.deepEqual(event.operation, operation);
  assert.ok(JSON.stringify(event).includes(`"${operation.opId}"`), 'serialized event must carry the opId');
});

test('R17 v0.2 node-created event goes through the real production digest + validation path', () => {
  const operation = createNodeOperation(7, { unicode: true });
  const event = buildV02CreateNodeEvent(operation, `${CURSOR_PREFIX}-v2-00007`);
  assert.equal(event.kind, 'operation');
  assert.equal(event.cursor, `${CURSOR_PREFIX}-v2-00007`);
  assert.deepEqual(event.operation, operation);
  assert.equal(event.effect.kind, 'node_created');
  assert.equal(event.effect.operationDigest, canonicalOperationDigest(operation),
    'v0.2 event must embed the production canonical operation digest');
  assert.equal(event.effect.effectDigest, canonicalAuthoritativeEffectDigest(event.effect),
    'v0.2 event must embed the production canonical authoritative effect digest');
  assert.equal(event.effect.nodeChildrenRevision, null, 'a bookmark node must not carry a children revision');
  assert.equal(event.effect.node.kind, 'bookmark');
  assert.equal(event.effect.node.id, NODE_ID);
  assert.equal(event.effect.placement.parentId, ROOT_ID);
  assert.equal(event.effect.parentRevision.parentId, ROOT_ID);
  assert.ok(typeof event.effect.effectId === 'string' && event.effect.effectId.length > 0);
});

test('R17 pull-side budget serializes each event exactly once (byteAwareEventCount)', () => {
  const events = [...v01OperationEvents(40), ...v02CreateNodeEvents(10)];
  const measured = measureByteAwareEventCount(events, MAX_BUDGET);
  assert.equal(measured.count, events.length, 'with an unbounded budget every event must fit');
  assert.equal(measured.stringifyCalls, events.length,
    'the pull budget must run exactly one JSON.stringify per event, never a second serialized copy');
  assert.equal(byteAwareEventCount(events, MAX_BUDGET), events.length,
    'direct production byteAwareEventCount must agree with the measured count');
  const independentBytes = events.reduce(
    (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0,
  );
  assert.equal(measured.serializedBytes, independentBytes,
    'the serialized byte accounting must equal the real UTF-8 bytes of the actual events');
});

test('R17 Unicode and max-payload bytes are accounted exactly (no byte-for-byte drift)', () => {
  const unicode = buildV01OperationEvent(createNodeOperation(1, { unicode: true }), `${CURSOR_PREFIX}-u`);
  const large = buildV01OperationEvent(createMaxPayloadOperation(2), `${CURSOR_PREFIX}-max`);
  const emptyExtensions = buildV02CreateNodeEvent(createNodeOperation(3), `${CURSOR_PREFIX}-v2-empty`);
  const events: (SyncPullEvent | SyncPullEventV02)[] = [unicode, large, emptyExtensions];
  const measured = measureByteAwareEventCount(events, MAX_BUDGET);
  assert.equal(measured.count, events.length);
  assert.equal(measured.stringifyCalls, events.length);
  const perEvent = events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8'));
  assert.equal(measured.serializedBytes, perEvent.reduce((sum, bytes) => sum + bytes, 0));
  assert.ok(perEvent[0]! > 120, 'the unicode event must serialize to more than 120 UTF-8 bytes');
  assert.ok(perEvent[1]! > 8_000, 'the max-payload event must dominate the page byte budget');
  assert.ok(measured.serializedBytes >= perEvent[1]!, 'the total must at least cover the largest event');
  // Empty extensions must survive serialization byte-for-byte in the v0.2 event.
  assert.ok(JSON.stringify(emptyExtensions).includes('"extensions":{}'),
    'an empty extensions object must be preserved verbatim in the v0.2 event');
});

test('R17 bounded budget: the pull-side count stops inside the page while stringify stays once per event', () => {
  const events = v01OperationEvents(20);
  const perEvent = events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8') + 1);
  const firstOnlyBudget = 1_024 + perEvent[0]!;
  const measured = measureByteAwareEventCount(events, firstOnlyBudget);
  assert.equal(measured.count, 1, 'a budget that admits only the first event must count exactly one');
  assert.equal(measured.stringifyCalls, measured.count + 1,
    'the budget scan must stringify each admitted event once plus the single overflowing candidate, then stop');
  // A budget that admits the first k events counts exactly k (linearity) and
  // still stringifies each admitted event exactly once, never a second copy.
  const k = 5;
  const kBudget = 1_024 + perEvent.slice(0, k).reduce((sum, bytes) => sum + bytes, 0);
  const kMeasured = measureByteAwareEventCount(events, kBudget);
  assert.equal(kMeasured.count, k, 'a budget admitting k events must count exactly k');
  assert.equal(kMeasured.stringifyCalls, k + 1,
    'one stringify per admitted event plus the single overflow candidate');
  // A budget below the first event fails closed with payload_too_large, not an empty page.
  assert.throws(() => byteAwareEventCount(events, 1_024), (error: unknown) =>
    error instanceof SyncPullReadError && error.code === 'payload_too_large');
});

test('R17 node-update budget is an exact constant: 5 stringifies merged, 4 on conflict', () => {
  const payload = (title: string): Readonly<Record<string, unknown>> => ({
    kind: 'bookmark',
    title,
    url: 'https://example.test/r17',
    tags: [],
    visibility: 'inherit',
    extensions: {},
  });
  const operation: Operation = {
    opId: 'op-r17-update',
    replicaId: 'replica-r17',
    sequence: 2,
    collectionId: COLLECTION_ID,
    targetId: NODE_ID,
    baseRevision: 'node-r1',
    type: 'update_node_content',
    occurredAt: '2026-07-26T00:00:00Z',
    dependencies: [],
    payload: { base: { title: 'Before' }, value: { title: 'After' } },
  } as Operation;
  const trustedBase: TrustedSyncNodeRevision = {
    collectionId: COLLECTION_ID,
    resourceId: NODE_ID,
    revision: 'node-r1',
    kind: 'bookmark',
    deleted: false,
    payload: payload('Before'),
  };
  const applied = measureSyncNodeUpdateBudget(operation, trustedBase,
    { ...trustedBase, payload: payload('Before') });
  assert.equal(applied.evaluation.status, 'merged');
  assert.equal(applied.stringifyCalls, 5,
    'a merged applied update must stringify base/value/trusted/current (4) plus the merged value (1)');
  const rebased = measureSyncNodeUpdateBudget(operation, trustedBase,
    { ...trustedBase, revision: 'node-r2', payload: payload('Before') });
  assert.equal(rebased.evaluation.status, 'merged');
  assert.equal(rebased.evaluation.resultStatus, 'rebased');
  assert.equal(rebased.stringifyCalls, 5, 'a rebased merge must use the same exact 5-stringify budget');
  const untrusted = measureSyncNodeUpdateBudget(operation,
    { ...trustedBase, payload: payload('Untrusted') },
    { ...trustedBase, payload: payload('Before') });
  assert.equal(untrusted.evaluation.status, 'conflict');
  assert.equal(untrusted.evaluation.code, 'sync_base_untrusted');
  assert.equal(untrusted.stringifyCalls, 4,
    'a conflict that fails before merge must stop after the 4 input stringifies');
});

test('R17 sync pull cursor serialization is deterministic and verifies round-trip through the real keyring', () => {
  const measured = measureSyncPullCursorSerialization();
  assert.ok(measured.first.cursor.startsWith('spc2.'), 'the cursor must be a real spc2 cursor');
  assert.equal(measured.deterministic, true,
    'signing the same scope at the same instant must produce the identical cursor string, call count and bytes');
  assert.equal(measured.first.stringifyCalls, measured.second.stringifyCalls);
  assert.equal(measured.first.serializedBytes, measured.second.serializedBytes);
  assert.equal(measured.verified.valid, true, 'the signed cursor must verify against the real keyring');
  assert.equal(measured.cursorAscii, true, 'the cursor must be ASCII (spc2 wire format)');
  assert.ok(measured.cursorBytes <= 128, 'the cursor must respect the opaqueId 128-byte budget');
});

test('R17 response serialization is a single JSON.stringify pass for the whole page', () => {
  const events = [...v01OperationEvents(25), ...v02CreateNodeEvents(5)];
  const measured = measurePullPageResponseSerialization(events, `${CURSOR_PREFIX}-next`);
  assert.equal(measured.stringifyCalls, 1, 'the whole page must serialize in exactly one JSON.stringify');
  assert.equal(measured.serializedBytes, Buffer.byteLength(measured.serialized, 'utf8'));
  const parsed = JSON.parse(measured.serialized) as { events: readonly unknown[]; nextCursor: string; hasMore: boolean };
  assert.equal(parsed.events.length, events.length, 'the serialized page must contain every event');
  assert.equal(parsed.nextCursor, `${CURSOR_PREFIX}-next`);
  assert.equal(parsed.hasMore, false);
});

test('R17 evidence runner records measured evidence with a pass.overall gate', async () => {
  const evidence: R17OutboxSerializationEvidence = await runR17OutboxSerializationEvidence();
  assert.equal(evidence.evidence, 'r17_outbox_serialization');
  assert.equal(evidence.decision.optimize, false, 'R17 must conclude 不实施优化 (no byte cache)');
  assert.equal(evidence.measured.pullBudget.stringifyCalls, evidence.measured.pullBudget.eventCount);
  assert.equal(evidence.measured.pullBudget.count, evidence.measured.pullBudget.eventCount);
  assert.equal(evidence.measured.syncNodeUpdateBudget.applied.stringifyCalls, 5);
  assert.equal(evidence.measured.syncNodeUpdateBudget.conflict.stringifyCalls, 4);
  assert.equal(evidence.measured.responseSerialization.stringifyCalls, 1);
  assert.equal(evidence.measured.cursorSerialization.deterministic, true);
  assert.equal(evidence.measured.cursorSerialization.verifyValid, true);
  assert.equal(evidence.measured.v02Event.operationDigestValid, true);
  assert.equal(evidence.measured.v02Event.effectDigestValid, true);
  assert.equal(evidence.pass.overall, true);
});
