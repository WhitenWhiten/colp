import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  SavedResourceError,
  saveResource,
  unsaveResource,
  type SavedResourceCommandPorts,
  type SavedResourceRecord,
  type SavedResourceType,
} from '../../../src/modules/reading-progress/index.js';
import type { ProductCommandClaim, ProductCommandResult } from '../../../src/modules/commands/index.js';

function harness(overrides: Partial<SavedResourceCommandPorts> = {}) {
  const rows = new Map<string, SavedResourceRecord>();
  const identity = (accountId: string, resourceType: SavedResourceType, resourceId: string) =>
    `${accountId}\u0000${resourceType}\u0000${resourceId}`;
  let claim: ProductCommandClaim = { kind: 'claimed' };
  let completed: ProductCommandResult | undefined;
  const audits: unknown[] = [];
  const savedResources: SavedResourceCommandPorts['savedResources'] = {
    async findLive(input) {
      const record = rows.get(identity(input.accountId, input.resourceType, input.resourceId));
      return record?.deletedAt === null ? record : null;
    },
    async insertLive(input) {
      const record: SavedResourceRecord = { id: '41', accountId: input.accountId,
        resourceType: input.resourceType, resourceId: input.resourceId,
        savedAt: input.at, updatedAt: input.at, deletedAt: null };
      rows.set(identity(input.accountId, input.resourceType, input.resourceId), record);
      return { record, inserted: true };
    },
    async softDelete(input) {
      const key = identity(input.accountId, input.resourceType, input.resourceId);
      const record = rows.get(key);
      if (!record || record.deletedAt !== null) return null;
      const deleted = { ...record, updatedAt: input.at, deletedAt: input.at };
      rows.set(key, deleted);
      return deleted;
    },
  };
  const { savedResources: savedResourceOverrides, ...rest } = overrides;
  const ports: SavedResourceCommandPorts = {
    receipts: {
      async claim() { return claim; },
      async complete(_binding, _fingerprint, result) { completed = result; },
      async purgeExpired() { return 0; },
      async deletePrincipalReceipts() { return 0; },
    },
    targets: { async resolveAccessible() {
      return { resourceType: 'node', resourceId: 'node-1', collectionId: 'collection-1' };
    } },
    savedResources: { ...savedResources, ...savedResourceOverrides },
    audit: { async append(event) { audits.push(event); } },
    clock: { async now() { return new Date('2026-07-25T08:00:00.000Z'); } },
    ...rest,
  };
  const input = (changes: Record<string, unknown> = {}) => ({
    actor: { principalId: 'principal-1', subjectId: 'subject-1', accountId: 'account-1' },
    command: { commandId: randomUUID(), fingerprint: 'fingerprint-1' },
    target: { resourceType: 'node' as const, resourceId: 'node-1' },
    ...changes,
  });
  return { ports, input, setClaim(value: ProductCommandClaim) { claim = value; },
    seed(record: SavedResourceRecord) {
      rows.set(identity(record.accountId, record.resourceType, record.resourceId), record);
    },
    get completed() { return completed; }, rows, audits };
}

test('save creates private state and a privacy-minimal audit without collection side effects', async () => {
  const h = harness();
  const result = await saveResource(h.ports, h.input());
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') {
    assert.equal(result.changed, true);
    assert.equal(result.savedResource.accountId, 'account-1');
  }
  assert.equal(h.completed?.status, 201);
  assert.equal(h.completed?.contractVersion, '1.0.0');
  assert.deepEqual(h.audits, [{ principalId: 'principal-1', accountId: 'account-1',
    eventType: 'saved_resource.saved', resourceType: 'node', changed: true,
    createdAt: new Date('2026-07-25T08:00:00.000Z') }]);
  assert.equal(Object.hasOwn(h.audits[0] as object, 'resourceId'), false);
});

test('a new command for an already-live save is a successful unchanged intent', async () => {
  const h = harness();
  await saveResource(h.ports, h.input());
  const result = await saveResource(h.ports, h.input());
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') assert.equal(result.changed, false);
  assert.equal(h.completed?.status, 200);
  assert.equal(h.audits.length, 2);
});

test('exact replay and command reuse return receipt outcomes before target resolution', async () => {
  let resolutions = 0;
  const h = harness({ targets: { async resolveAccessible() { resolutions += 1; return null; } } });
  h.setClaim({ kind: 'replay', result: { status: 201, body: Buffer.from('{}'), stableHeaders: {},
    mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: 'node:node-1' } });
  assert.equal((await saveResource(h.ports, h.input())).kind, 'replay');
  h.setClaim({ kind: 'reused' });
  assert.deepEqual(await saveResource(h.ports, h.input()), { kind: 'reused' });
  assert.equal(resolutions, 0);
});

test('in_progress and expired receipt claims short-circuit target access, storage, audit and completion', async () => {
  for (const claim of [
    { kind: 'in_progress', retryAfterSeconds: 7 },
    { kind: 'expired', resultDigest: 'sha256:not-a-real-digest' },
  ] as const) {
    let resolutions = 0;
    let storageTouched = 0;
    const h = harness({
      targets: { async resolveAccessible() { resolutions += 1; return null; } },
      savedResources: {
        findLive: async () => { storageTouched += 1; return null; },
        insertLive: async () => { storageTouched += 1; throw new Error('save must not reach storage'); },
        softDelete: async () => { storageTouched += 1; throw new Error('unsave must not reach storage'); },
      },
    });
    h.setClaim(claim);
    assert.deepEqual(await saveResource(h.ports, h.input()), claim);
    assert.deepEqual(await unsaveResource(h.ports, h.input()), claim);
    assert.equal(resolutions, 0);
    assert.equal(storageTouched, 0);
    assert.deepEqual(h.audits, []);
    assert.equal(h.completed, undefined);
  }
});

test('unsave is idempotent per intent and save after unsave creates a fresh live fact', async () => {
  const h = harness();
  await saveResource(h.ports, h.input());
  const removed = await unsaveResource(h.ports, h.input());
  assert.deepEqual(removed, { kind: 'unsaved', changed: true });
  const absent = await unsaveResource(h.ports, h.input());
  assert.deepEqual(absent, { kind: 'unsaved', changed: false });
  const restored = await saveResource(h.ports, h.input());
  assert.equal(restored.kind, 'saved');
  if (restored.kind === 'saved') assert.equal(restored.changed, true);
});

test('invalid target type and inaccessible target use stable validation/concealment errors', async () => {
  const h = harness({ targets: { async resolveAccessible() { return null; } } });
  await assert.rejects(() => saveResource(h.ports, h.input()),
    (error: unknown) => error instanceof SavedResourceError && error.code === 'saved_resource_not_found');
  await assert.rejects(() => saveResource(h.ports, h.input({
    target: { resourceType: 'annotation', resourceId: 'annotation-1' },
  })), (error: unknown) => error instanceof SavedResourceError && error.code === 'invalid_saved_resource_target');
});

test('authority rows are keyed per account so identical targets stay isolated', async () => {
  const h = harness();
  const first = await saveResource(h.ports, h.input());
  const second = await saveResource(h.ports, h.input({
    actor: { principalId: 'principal-2', subjectId: 'subject-2', accountId: 'account-2' },
  }));
  assert.equal(first.kind, 'saved');
  assert.equal(second.kind, 'saved');
  if (first.kind === 'saved' && second.kind === 'saved') {
    assert.equal(first.changed, true);
    assert.equal(second.changed, true);
    assert.equal(first.savedResource.accountId, 'account-1');
    assert.equal(second.savedResource.accountId, 'account-2');
  }
  assert.equal(h.rows.size, 2);
  const mine = await unsaveResource(h.ports, h.input());
  assert.deepEqual(mine, { kind: 'unsaved', changed: true });
  assert.equal(h.rows.get('account-2\u0000node\u0000node-1')?.deletedAt, null);
  const theirs = await unsaveResource(h.ports, h.input({
    actor: { principalId: 'principal-2', subjectId: 'subject-2', accountId: 'account-2' },
  }));
  assert.deepEqual(theirs, { kind: 'unsaved', changed: true });
});

test('seeded authority rows are honored verbatim and never leak across accounts', async () => {
  const h = harness();
  const otherAccountRow: SavedResourceRecord = { id: '99', accountId: 'account-2',
    resourceType: 'node', resourceId: 'node-1', savedAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'), deletedAt: null };
  h.seed(otherAccountRow);
  h.seed({ id: '98', accountId: 'account-1', resourceType: 'node', resourceId: 'node-1',
    savedAt: new Date('2026-07-01T00:00:00.000Z'), updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: new Date('2026-07-02T00:00:00.000Z') });
  const result = await saveResource(h.ports, h.input());
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') assert.equal(result.changed, true);
  assert.equal(h.rows.get('account-1\u0000node\u0000node-1')?.savedAt.toISOString(),
    '2026-07-25T08:00:00.000Z');
  assert.deepEqual(h.rows.get('account-2\u0000node\u0000node-1'), otherAccountRow);
});

const liveAuthority = (changes: Partial<SavedResourceRecord> = {}): SavedResourceRecord => ({
  id: '41', accountId: 'account-1', resourceType: 'node', resourceId: 'node-1',
  savedAt: new Date('2026-07-25T07:00:00.000Z'), updatedAt: new Date('2026-07-25T07:00:00.000Z'),
  deletedAt: null, ...changes,
});
const invalidLiveRows: Array<[string, Partial<SavedResourceRecord>]> = [
  ['a row owned by another account', { accountId: 'account-2' }],
  ['a row for another resource type', { resourceType: 'collection' }],
  ['a row for another resource id', { resourceId: 'node-other' }],
  ['a live row that is already deleted', { deletedAt: new Date('2026-07-25T07:30:00.000Z') }],
  ['a non-Date savedAt', { savedAt: '2026-07-25T07:00:00.000Z' as unknown as Date }],
  ['a NaN savedAt', { savedAt: new Date('invalid') }],
  ['a non-Date updatedAt', { updatedAt: '2026-07-25T07:00:00.000Z' as unknown as Date }],
  ['a NaN updatedAt', { updatedAt: new Date('invalid') }],
  ['an updatedAt before savedAt', { updatedAt: new Date('2026-07-25T06:00:00.000Z') }],
];

test.each(invalidLiveRows)('save fails closed when findLive returns %s', async (_label, changes) => {
  const h = harness({ savedResources: { findLive: async () => liveAuthority(changes) } });
  await assert.rejects(() => saveResource(h.ports, h.input()), (error: unknown) => error instanceof SavedResourceError
    && error.code === 'invalid_saved_resource_input'
    && error.message === 'Saved resource storage returned invalid authority facts.');
  assert.equal(h.completed, undefined);
  assert.deepEqual(h.audits, []);
});

const deletedAuthority = (changes: Partial<SavedResourceRecord> = {}): SavedResourceRecord => ({
  id: '41', accountId: 'account-1', resourceType: 'node', resourceId: 'node-1',
  savedAt: new Date('2026-07-25T07:00:00.000Z'), updatedAt: new Date('2026-07-25T08:00:00.000Z'),
  deletedAt: new Date('2026-07-25T08:00:00.000Z'), ...changes,
});
const invalidDeletedRows: Array<[string, Partial<SavedResourceRecord>]> = [
  ['a row owned by another account', { accountId: 'account-2' }],
  ['a row for another resource type', { resourceType: 'collection' }],
  ['a row for another resource id', { resourceId: 'node-other' }],
  ['a non-Date deletedAt', { deletedAt: '2026-07-25T08:00:00.000Z' as unknown as Date }],
  ['a NaN deletedAt', { deletedAt: new Date('invalid') }],
  ['a deletedAt that differs from updatedAt', { deletedAt: new Date('2026-07-25T08:30:00.000Z') }],
];

test.each(invalidDeletedRows)('unsave fails closed when softDelete returns %s', async (_label, changes) => {
  const h = harness({ savedResources: { softDelete: async () => deletedAuthority(changes) } });
  await assert.rejects(() => unsaveResource(h.ports, h.input()), (error: unknown) => error instanceof SavedResourceError
    && error.code === 'invalid_saved_resource_input'
    && error.message === 'Saved resource storage returned invalid deletion facts.');
  assert.equal(h.completed, undefined);
  assert.deepEqual(h.audits, []);
});

test('P2B-15 saved resource write and hydrate adapters reuse the Publication ancestor access fact', async () => {
  for (const file of ['saved-resource-postgres.ts', 'saved-resource-read-postgres.ts']) {
    const source = await readFile(new URL(`../../../src/infrastructure/reading-progress/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes("buildPublicationBookmarkPublicAccessSql('n', 'c')"),
      `${file} must delegate bookmark access to the shared Publication fact`);
  }
});
