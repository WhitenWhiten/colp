import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  CLASSIFY_INBOX_SKIP_COMMAND_SCOPE,
  ClassifyInboxSkipError,
  parseClassifyInboxSkipBody,
  skipClassifyInboxFingerprint,
  skipClassifyInboxItem,
  type ClassifyInboxSkipInsertResult,
  type ClassifyInboxSkipSnapshot,
  type SkipClassifyInboxItemPorts,
} from '../../../src/modules/collections/index.js';
import { createMemoryProductCommandReceiptPort } from '../../support/product-http-harness.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const NODE_ID = 'node-bookmark';
const COLLECTION_ID = 'col-classify-inbox';
const PRINCIPAL = 'acct-owner';
const SUBJECT = 'subject-owner';

function eligibleSnapshot(
  overrides: Partial<ClassifyInboxSkipSnapshot> = {},
): ClassifyInboxSkipSnapshot {
  return {
    nodeId: NODE_ID,
    collectionId: COLLECTION_ID,
    isOwner: true,
    kind: 'bookmark',
    softDeleted: false,
    url: 'https://system.example.com/essay',
    parentKind: 'root',
    sidecarStatus: null,
    ...overrides,
  };
}

function memoryPorts(initial: ClassifyInboxSkipSnapshot | null): {
  readonly ports: SkipClassifyInboxItemPorts;
  readonly writes: string[];
} {
  const receipts = new Map();
  const writes: string[] = [];
  let snapshot = initial;
  const ports: SkipClassifyInboxItemPorts = {
    receipts: createMemoryProductCommandReceiptPort(receipts),
    inbox: {
      async loadEligibilitySnapshot(input) {
        if (snapshot === null) return null;
        if (snapshot.nodeId !== input.nodeId) return null;
        if (input.ownerSubjectId !== SUBJECT) return null;
        return snapshot;
      },
      async insertSkipped(input) {
        if (snapshot === null || snapshot.nodeId !== input.nodeId) return 'blocked';
        if (snapshot.sidecarStatus === 'skipped') return 'already_skipped';
        if (snapshot.sidecarStatus === 'accepted') return 'blocked';
        snapshot = { ...snapshot, sidecarStatus: 'skipped' };
        writes.push(input.nodeId);
        return 'inserted' satisfies ClassifyInboxSkipInsertResult;
      },
    },
    clock: { now: async () => NOW },
  };
  return { ports, writes };
}

function actorInput(commandId: string, nodeId = NODE_ID) {
  return {
    actor: { principalId: PRINCIPAL, subjectId: SUBJECT },
    commandId,
    nodeId,
    body: {},
  };
}

test('parseClassifyInboxSkipBody accepts only the empty object', () => {
  assert.deepEqual(parseClassifyInboxSkipBody({}), {});
  assert.throws(
    () => parseClassifyInboxSkipBody(undefined),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'invalid_document',
  );
  assert.throws(
    () => parseClassifyInboxSkipBody({ extra: true }),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'invalid_document',
  );
});

test('fingerprint is specific to this skip route and nodeId', () => {
  const left = skipClassifyInboxFingerprint(NODE_ID);
  const right = skipClassifyInboxFingerprint('other-node');
  assert.notEqual(left, right);
  assert.equal(skipClassifyInboxFingerprint(NODE_ID), left);
  assert.equal(CLASSIFY_INBOX_SKIP_COMMAND_SCOPE, 'collections:classify-inbox-skip:v1');
  assert.equal(CLASSIFY_INBOX_SKIP_COMMAND_SCOPE.includes('link-health'), false);
});

test('eligible skip inserts one sidecar row and returns skipped receipt', async () => {
  const { ports, writes } = memoryPorts(eligibleSnapshot());
  const commandId = randomUUID();
  const result = await skipClassifyInboxItem(ports, actorInput(commandId));
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.receipt, { nodeId: NODE_ID, decision: 'skipped' });
  assert.deepEqual(writes, [NODE_ID]);
});

test('same Known-Command-Id replays the first receipt without a second write', async () => {
  const { ports, writes } = memoryPorts(eligibleSnapshot());
  const commandId = randomUUID();
  const first = await skipClassifyInboxItem(ports, actorInput(commandId));
  assert.equal(first.kind, 'succeeded');
  const replay = await skipClassifyInboxItem(ports, actorInput(commandId));
  assert.equal(replay.kind, 'replay');
  if (first.kind !== 'succeeded' || replay.kind !== 'replay') return;
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')), first.receipt);
  assert.deepEqual(writes, [NODE_ID]);
});

test('new command id on an already skipped node is 200 without another write', async () => {
  const { ports, writes } = memoryPorts(eligibleSnapshot({ sidecarStatus: 'skipped' }));
  const result = await skipClassifyInboxItem(ports, actorInput(randomUUID()));
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.receipt, { nodeId: NODE_ID, decision: 'skipped' });
  assert.deepEqual(writes, []);
});

test('already accepted, ineligible, missing, and foreign nodes conceal as resource_not_found', async () => {
  const accepted = memoryPorts(eligibleSnapshot({ sidecarStatus: 'accepted' }));
  await assert.rejects(
    () => skipClassifyInboxItem(accepted.ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'resource_not_found',
  );
  assert.deepEqual(accepted.writes, []);

  const nested = memoryPorts(eligibleSnapshot({ parentKind: 'folder' }));
  await assert.rejects(
    () => skipClassifyInboxItem(nested.ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'resource_not_found',
  );

  const missing = memoryPorts(null);
  await assert.rejects(
    () => skipClassifyInboxItem(missing.ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'resource_not_found',
  );

  const foreign = memoryPorts(eligibleSnapshot());
  await assert.rejects(
    () => skipClassifyInboxItem(foreign.ports, {
      actor: { principalId: PRINCIPAL, subjectId: 'subject-stranger' },
      commandId: randomUUID(),
      nodeId: NODE_ID,
      body: {},
    }),
    (error: unknown) => error instanceof ClassifyInboxSkipError && error.code === 'resource_not_found',
  );
  assert.deepEqual(foreign.writes, []);
});
