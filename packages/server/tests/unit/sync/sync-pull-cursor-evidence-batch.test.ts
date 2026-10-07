import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  buildIssuedCursorEntries,
  lineageProvesExpiredCursor,
  prepareIssuedCursorEvidenceItems,
  prepareIssuedCursorLineageItems,
  selectPersistedIssuedCursorItems,
  type CursorEvidenceAuthorityFacts,
} from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import {
  createSyncPullCursorKeyring,
  createSyncPullCursorLineageKeyring,
  SyncPullReadError,
  type SyncPullCursorContext,
  type SyncPullCursorLineageFacts,
} from '../../../src/modules/sync/index.js';
import type { SyncPullCursorLineageTable } from '../../../src/infrastructure/database/runtime.js';

const context: SyncPullCursorContext = Object.freeze({
  replicaId: 'replica-1', collectionId: 'collection-1', leaseGeneration: '7',
  sessionId: 'session-1', principalId: 'account-1', protocolVersion: '0.1',
  policyRevision: 'policy-4', limit: 2,
  purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
});
const authority: CursorEvidenceAuthorityFacts = Object.freeze({
  accountId: 'account-1', collectionId: 'collection-1', replicaId: 'replica-1',
  leaseGeneration: '7', policyRevision: 'policy-4', collectionRevision: 'content-r1',
  protocolVersion: '0.1',
});
const pageUpper = Object.freeze({ commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' });

function keyring() {
  return createSyncPullCursorKeyring({
    active: { id: 'batch-unit', secret: Buffer.alloc(32, 53).toString('base64') },
    retained: [], ttlMs: 60_000, now: () => 1_000,
  });
}

function signedCursor(keys: ReturnType<typeof keyring>, tuple: typeof pageUpper): string {
  return keys.sign({ ...context, tuple });
}

test('prepareIssuedCursorEvidenceItems rejects visible/event count mismatch', () => {
  const keys = keyring();
  const cursor = signedCursor(keys, pageUpper);
  assert.throws(() => prepareIssuedCursorEvidenceItems({
    visible: [{ commitOrdinal: '1', streamKind: 'operation', stableId: 'op-1' }],
    eventCursors: [],
    nextCursor: cursor,
    pageUpperTuple: pageUpper,
    keyring: keys,
    context,
    authority,
  }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
  keys.destroy();
});

test('prepareIssuedCursorEvidenceItems rejects duplicate digests in one page', () => {
  const keys = keyring();
  const tupleOne = Object.freeze({ commitOrdinal: '10', streamKind: 'operation' as const, stableId: 'op-10' });
  const tupleTwo = Object.freeze({ commitOrdinal: '11', streamKind: 'operation' as const, stableId: 'op-11' });
  const cursor = signedCursor(keys, tupleOne);
  assert.throws(() => prepareIssuedCursorEvidenceItems({
    visible: [
      { commitOrdinal: '10', streamKind: 'operation', stableId: 'op-10' },
      { commitOrdinal: '11', streamKind: 'operation', stableId: 'op-11' },
    ],
    eventCursors: [cursor, cursor],
    nextCursor: signedCursor(keys, tupleTwo),
    pageUpperTuple: tupleTwo,
    keyring: keys,
    context,
    authority,
  }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
  keys.destroy();
});

test('prepareIssuedCursorEvidenceItems rejects an invalid cursor signature', () => {
  const keys = keyring();
  assert.throws(() => prepareIssuedCursorEvidenceItems({
    visible: [],
    eventCursors: [],
    nextCursor: 'spc2.invalid-cursor',
    pageUpperTuple: pageUpper,
    keyring: keys,
    context,
    authority,
  }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'invalid_cursor_scope');
  keys.destroy();
});

test('prepareIssuedCursorEvidenceItems covers 0/1/2 issued cursors with stable facts', () => {
  const keys = keyring();
  const tupleOne = Object.freeze({ commitOrdinal: '10', streamKind: 'operation' as const, stableId: 'op-10' });
  const tupleTwo = Object.freeze({ commitOrdinal: '11', streamKind: 'conflict' as const, stableId: 'conflict-11' });
  const cursorOne = signedCursor(keys, tupleOne);
  const cursorTwo = signedCursor(keys, tupleTwo);

  const empty = prepareIssuedCursorEvidenceItems({
    visible: [],
    eventCursors: [],
    nextCursor: signedCursor(keys, pageUpper),
    pageUpperTuple: pageUpper,
    keyring: keys,
    context,
    authority,
  });
  assert.equal(empty.items.length, 1);
  assert.equal(empty.items[0]?.tuple, pageUpper);

  const one = prepareIssuedCursorEvidenceItems({
    visible: [{ commitOrdinal: '10', streamKind: 'operation', stableId: 'op-10' }],
    eventCursors: [cursorOne],
    nextCursor: cursorOne,
    pageUpperTuple: tupleOne,
    keyring: keys,
    context,
    authority,
  });
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0]?.digest, createHash('sha256').update(cursorOne, 'utf8').digest('hex'));
  assert.equal(one.items[0]?.evidenceFacts.page_limit, 2);

  const two = prepareIssuedCursorEvidenceItems({
    visible: [
      { commitOrdinal: '10', streamKind: 'operation', stableId: 'op-10' },
      { commitOrdinal: '11', streamKind: 'conflict', stableId: 'conflict-11' },
    ],
    eventCursors: [cursorOne, cursorTwo],
    nextCursor: cursorTwo,
    pageUpperTuple: tupleTwo,
    keyring: keys,
    context,
    authority,
  });
  assert.equal(two.items.length, 2);
  assert.notEqual(two.items[0]?.digest, two.items[1]?.digest);
  const persisted = selectPersistedIssuedCursorItems(two);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.digest, two.items[1]?.digest);
  const verifiedMid = keys.verify(cursorOne, context);
  assert.equal(verifiedMid.valid, true, 'intermediate event cursors stay HMAC-verifiable without a DB row');
  keys.destroy();
});

test('buildIssuedCursorEntries adds synthetic page upper only when needed', () => {
  const keys = keyring();
  const tuple = Object.freeze({ commitOrdinal: '5', streamKind: 'operation' as const, stableId: 'op-5' });
  const cursor = signedCursor(keys, tuple);
  assert.deepEqual(buildIssuedCursorEntries({
    visible: [{ commitOrdinal: '5', streamKind: 'operation', stableId: 'op-5' }],
    eventCursors: [cursor],
    nextCursor: cursor,
    pageUpperTuple: tuple,
  }), [{ cursor, tuple }]);
  assert.deepEqual(buildIssuedCursorEntries({
    visible: [],
    eventCursors: [],
    nextCursor: cursor,
    pageUpperTuple: pageUpper,
  }), [{ cursor, tuple: pageUpper }]);
  keys.destroy();
});

function lineageKeyring() {
  return createSyncPullCursorLineageKeyring({
    active: { id: 'lineage-batch-unit', secret: Buffer.alloc(32, 57).toString('base64') },
    retained: [],
  });
}

function lineageFactsFromItem(item: {
  readonly cursorDigest: string; readonly sessionId: string; readonly accountId: string;
  readonly collectionId: string; readonly replicaId: string; readonly leaseGeneration: bigint;
  readonly policyRevision: string; readonly protocolVersion: '0.1' | '0.2';
  readonly pageLimit: number; readonly tupleCommitOrdinal: bigint; readonly tupleStreamKind: number;
  readonly tupleStableId: string; readonly cursorExpiresAt: Date;
}): SyncPullCursorLineageFacts {
  return Object.freeze({
    cursorDigest: item.cursorDigest, sessionId: item.sessionId, accountId: item.accountId,
    collectionId: item.collectionId, replicaId: item.replicaId,
    leaseGeneration: BigInt(item.leaseGeneration).toString(), policyRevision: item.policyRevision,
    protocolVersion: item.protocolVersion, pageLimit: item.pageLimit,
    tuple: Object.freeze({ commitOrdinal: BigInt(item.tupleCommitOrdinal).toString(),
      streamKind: item.tupleStreamKind === 0 ? 'operation' as const : 'conflict' as const,
      stableId: item.tupleStableId }),
    cursorExpiresAt: item.cursorExpiresAt.getTime(),
  });
}

/** Mirrors the production lineageFactsFromRow mapping (snake_case DB row -> facts). */
function lineageFactsFromRow(row: SyncPullCursorLineageTable): SyncPullCursorLineageFacts {
  return Object.freeze({
    cursorDigest: row.cursor_digest, sessionId: row.session_id, accountId: row.account_id,
    collectionId: row.collection_id, replicaId: row.replica_id,
    leaseGeneration: BigInt(row.lease_generation).toString(), policyRevision: row.policy_revision,
    protocolVersion: row.protocol_version, pageLimit: row.page_limit,
    tuple: Object.freeze({ commitOrdinal: BigInt(row.tuple_commit_ordinal).toString(),
      streamKind: row.tuple_stream_kind === 0 ? 'operation' as const : 'conflict' as const,
      stableId: row.tuple_stable_id }),
    cursorExpiresAt: row.cursor_expires_at.getTime(),
  });
}

function jsonSafe(value: unknown): unknown {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
}

test('prepareIssuedCursorLineageItems signs minimal digest-only lineage for every issued cursor', () => {
  const keys = keyring();
  const lineageKeys = lineageKeyring();
  const tupleOne = Object.freeze({ commitOrdinal: '10', streamKind: 'operation' as const, stableId: 'op-10' });
  const tupleTwo = Object.freeze({ commitOrdinal: '11', streamKind: 'conflict' as const, stableId: 'conflict-11' });
  const prepared = prepareIssuedCursorEvidenceItems({
    visible: [
      { commitOrdinal: '10', streamKind: 'operation', stableId: 'op-10' },
      { commitOrdinal: '11', streamKind: 'conflict', stableId: 'conflict-11' },
    ],
    eventCursors: [signedCursor(keys, tupleOne), signedCursor(keys, tupleTwo)],
    nextCursor: signedCursor(keys, tupleTwo),
    pageUpperTuple: tupleTwo,
    keyring: keys,
    context,
    authority,
  });
  const issuedAt = new Date(1_000);
  const items = prepareIssuedCursorLineageItems({
    items: prepared.items, keyring: lineageKeys, lineageRetentionMs: 60_000, issuedAt,
  });
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.keyVersion, 'lineage-batch-unit');
    assert.match(item.receipt, /^spl1\./u);
    assert.ok(item.lineageExpiresAt.getTime() > item.cursorExpiresAt.getTime(),
      'lineage must outlive the cursor expiry it proves');
    assert.ok(item.issuedAt.getTime() === issuedAt.getTime());
    assert.equal(jsonSafe(item).includes('spc2.'), false,
      'lineage must not retain the full signed cursor payload');
    assert.equal(lineageKeys.verify(item.receipt, lineageFactsFromItem(item)).valid, true,
      'the persisted lineage receipt must authenticate its own row facts');
  }
  assert.notEqual(items[0]?.receipt, items[1]?.receipt);
  lineageKeys.destroy();
  keys.destroy();
});

test('lineageProvesExpiredCursor admits only receipt-authenticated expired binding matches', () => {
  const lineageKeys = lineageKeyring();
  const cursorDigest = 'c'.repeat(64);
  const row = {
    lineage_id: 1n, cursor_digest: cursorDigest, session_id: 'session-1', account_id: 'account-1',
    collection_id: 'collection-1', replica_id: 'replica-1', lease_generation: 7n,
    policy_revision: 'policy-4', protocol_version: '0.1' as const, page_limit: 2,
    tuple_commit_ordinal: 42n, tuple_stream_kind: 1, tuple_stable_id: 'conflict-2',
    cursor_expires_at: new Date(10_000), lineage_expires_at: new Date(120_000),
    issued_at: new Date(1_000), key_version: 'lineage-batch-unit',
    receipt: '',
  } satisfies SyncPullCursorLineageTable;
  const facts = lineageFactsFromRow(row);
  const receiptRow = { ...row, receipt: lineageKeys.sign(facts) } satisfies SyncPullCursorLineageTable;
  const authority = Object.freeze({ accountId: 'account-1', collectionId: 'collection-1',
    replicaId: 'replica-1' });

  assert.equal(lineageProvesExpiredCursor(receiptRow, authority, 11_000, lineageKeys), true,
    'an expired, receipt-authenticated binding match is provably old');
  assert.equal(lineageProvesExpiredCursor(receiptRow, authority, 9_999, lineageKeys), false,
    'a not-yet-expired cursor must never be called provably old');
  for (const other of [
    { accountId: 'account-2' }, { collectionId: 'collection-2' }, { replicaId: 'replica-2' },
  ]) {
    assert.equal(lineageProvesExpiredCursor(receiptRow, { ...authority, ...other }, 11_000, lineageKeys),
      false, `a binding mismatch (${Object.keys(other)[0]}) must stay invalid`);
  }
  const tamperedRow = { ...receiptRow, receipt: `${receiptRow.receipt.slice(0, -1)}${receiptRow.receipt.endsWith('A') ? 'B' : 'A'}` };
  assert.equal(lineageProvesExpiredCursor(tamperedRow, authority, 11_000, lineageKeys), false,
    'a corrupted lineage receipt must fail closed');
  assert.equal(lineageProvesExpiredCursor(receiptRow, authority, 11_000, undefined), false,
    'without a lineage keyring no cursor can be proven old');
  assert.equal(lineageProvesExpiredCursor({ ...receiptRow, cursor_digest: 'd'.repeat(64) }, authority,
    11_000, lineageKeys), false, 'a row whose facts were re-keyed must fail closed');
  lineageKeys.destroy();
});
