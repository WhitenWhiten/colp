import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { buildPublicationTargetAncestorRestrictionSql,
  PUBLICATION_TARGET_ACCESS_MAX_DEPTH } from '../../../src/infrastructure/publication/target-access-facts.js';
import type { ProductCommandClaim, ProductCommandResult } from '../../../src/modules/commands/index.js';
import {
  ReadingProgressError,
  readingProgressEtag,
  resetReadingProgress,
  upsertReadingProgress,
  type ReadingProgressCommandPorts,
  type ReadingProgressRecord,
  type ReadingProgressStatus,
} from '../../../src/modules/reading-progress/index.js';

function harness(overrides: Partial<ReadingProgressCommandPorts> = {}) {
  let row: ReadingProgressRecord | null = null;
  let claim: ProductCommandClaim = { kind: 'claimed' };
  let completed: ProductCommandResult | undefined;
  const audits: unknown[] = [];
  const { progress: progressOverrides, ...rest } = overrides;
  const progress: ReadingProgressCommandPorts['progress'] = {
    async findForUpdate(input) {
      return row && row.accountId === input.accountId && row.resourceType === input.resourceType
        && row.resourceId === input.resourceId ? row : null;
    },
    async insertOnly(input) {
      if (row) return null;
      row = { accountId: input.accountId, resourceType: input.resourceType, resourceId: input.resourceId,
        status: input.status, progress: input.progress, revision: 1,
        completedAt: input.status === 'completed' ? input.at : null, createdAt: input.at, updatedAt: input.at };
      return row;
    },
    async upsert(input) {
      const prior = row;
      row = { accountId: input.accountId, resourceType: input.resourceType, resourceId: input.resourceId,
        status: input.status, progress: input.progress, revision: (prior?.revision ?? 0) + 1,
        completedAt: input.status === 'completed' ? prior?.completedAt ?? input.at : null,
        createdAt: prior?.createdAt ?? input.at, updatedAt: input.at };
      return { record: row, inserted: prior === null };
    },
    async reset() { const prior = row; row = null; return prior; },
  };
  const ports: ReadingProgressCommandPorts = {
    receipts: {
      async claim() { return claim; },
      async complete(_binding, _fingerprint, result) { completed = result; },
      async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    targets: { async resolveAccessible(input) {
      return { resourceType: input.resourceType, resourceId: input.resourceId, collectionId: 'collection-1' };
    } },
    progress: { ...progress, ...progressOverrides },
    audit: { async append(event) { audits.push(event); } },
    clock: { async now() { return new Date('2026-07-25T10:00:00.000Z'); } },
    ...rest,
  };
  const input = (status: ReadingProgressStatus = 'in_progress', progress = 0.25,
    changes: Record<string, unknown> = {}) => ({
    actor: { principalId: 'principal-1', subjectId: 'subject-1', accountId: 'account-1' },
    command: { commandId: randomUUID(), fingerprint: randomUUID() },
    target: { resourceType: 'node' as const, resourceId: 'node-1' },
    state: { status, progress }, ...changes,
  });
  const resetInput = () => {
    const value = input(); return { actor: value.actor, command: value.command, target: value.target };
  };
  return { ports, input, resetInput, setClaim(value: ProductCommandClaim) { claim = value; }, audits,
    get row() { return row; }, get completed() { return completed; } };
}

test('accepts canonical states, normalizes negative zero, and owns completion timestamps', async () => {
  const h = harness();
  const notStarted = await upsertReadingProgress(h.ports, h.input('not_started', -0));
  assert.equal(notStarted.kind, 'upserted');
  if (notStarted.kind === 'upserted') {
    assert.equal(Object.is(notStarted.readingProgress.progress, -0), false);
    assert.equal(notStarted.readingProgress.completedAt, null);
  }
  const partial = await upsertReadingProgress(h.ports, h.input('in_progress', 0.12345));
  assert.equal(partial.kind, 'upserted');
  const completed = await upsertReadingProgress(h.ports, h.input('completed', 1));
  assert.equal(completed.kind, 'upserted');
  if (completed.kind === 'upserted') assert.equal(completed.readingProgress.completedAt?.toISOString(), '2026-07-25T10:00:00.000Z');
  const stillCompleted = await upsertReadingProgress(h.ports, h.input('completed', 1));
  if (stillCompleted.kind === 'upserted') assert.equal(stillCompleted.readingProgress.completedAt?.toISOString(), '2026-07-25T10:00:00.000Z');
  const leftCompleted = await upsertReadingProgress(h.ports, h.input('in_progress', 0.5));
  if (leftCompleted.kind === 'upserted') assert.equal(leftCompleted.readingProgress.completedAt, null);
  assert.deepEqual(h.audits.at(-1), { principalId: 'principal-1', accountId: 'account-1',
    eventType: 'reading_progress.upserted', resourceType: 'node', status: 'in_progress', createdAt: new Date('2026-07-25T10:00:00.000Z') });
  assert.equal(Object.hasOwn(h.audits.at(-1) as object, 'resourceId'), false);
  assert.equal(Object.hasOwn(h.audits.at(-1) as object, 'progress'), false);
});

test('rejects non-finite, out-of-range, over-precision, mismatched states, and client-owned facts', async () => {
  const h = harness();
  for (const [status, progress] of [
    ['in_progress', Number.NaN], ['in_progress', Number.POSITIVE_INFINITY], ['in_progress', Number.NEGATIVE_INFINITY],
    ['not_started', Number.MIN_VALUE], ['completed', 1 - Number.EPSILON / 2],
    ['in_progress', 0.10000000000000002],
    ['not_started', -0.00001], ['completed', 1.00001], ['in_progress', 0], ['in_progress', 1],
    ['not_started', 0.1], ['completed', 0.9], ['in_progress', 0.123456],
  ] as const) {
    await assert.rejects(() => upsertReadingProgress(h.ports, h.input(status, progress)),
      (error: unknown) => error instanceof ReadingProgressError && error.code === 'invalid_reading_progress_state');
  }
  for (const state of [
    { status: 'in_progress', progress: 0.5, completedAt: '2026-01-01T00:00:00Z' },
    { status: 'in_progress', progress: 0.5, revision: 4 },
    { status: 'in_progress', progress: 0.5, owner: 'account-other' },
    { status: 'in_progress', progress: 0.5, annotation: { type: 'reading_state' } },
  ]) await assert.rejects(() => upsertReadingProgress(h.ports, h.input('in_progress', 0.5, { state })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'invalid_reading_progress_input');
});

test('accepts exact five-decimal boundary and ordinary binary floating-point values', async () => {
  for (const progress of [0.00001, 0.1, 0.12345, 0.99999]) {
    const h = harness();
    const outcome = await upsertReadingProgress(h.ports, h.input('in_progress', progress));
    assert.equal(outcome.kind, 'upserted');
    if (outcome.kind === 'upserted') assert.equal(outcome.readingProgress.progress, progress);
  }
});

test('exact replay/reuse short-circuit target access and reset deletes explicit state', async () => {
  let resolutions = 0;
  const h = harness({ targets: { async resolveAccessible() { resolutions += 1; return null; } } });
  h.setClaim({ kind: 'replay', result: { status: 201, body: Buffer.from('{}'), stableHeaders: {},
    mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: 'node:node-1' } });
  assert.equal((await upsertReadingProgress(h.ports, h.input())).kind, 'replay');
  h.setClaim({ kind: 'reused' });
  assert.deepEqual(await upsertReadingProgress(h.ports, h.input()), { kind: 'reused' });
  assert.equal(resolutions, 0);

  const resetHarness = harness();
  await upsertReadingProgress(resetHarness.ports, resetHarness.input());
  const reset = await resetReadingProgress(resetHarness.ports, resetHarness.resetInput());
  assert.deepEqual(reset, { kind: 'reset', changed: true });
  const absent = await resetReadingProgress(resetHarness.ports, resetHarness.resetInput());
  assert.deepEqual(absent, { kind: 'reset', changed: false });
  assert.equal(resetHarness.row, null);
  assert.equal(resetHarness.completed?.status, 204);
});

test('in_progress and expired receipt claims short-circuit target access, audit and completion', async () => {
  for (const claim of [
    { kind: 'in_progress', retryAfterSeconds: 7 },
    { kind: 'expired', resultDigest: 'sha256:not-a-real-digest' },
  ] as const) {
    let resolutions = 0;
    const h = harness({ targets: { async resolveAccessible() { resolutions += 1; return null; } } });
    h.setClaim(claim);
    assert.deepEqual(await upsertReadingProgress(h.ports, h.input()), claim);
    assert.deepEqual(await resetReadingProgress(h.ports, h.resetInput()), claim);
    assert.equal(resolutions, 0);
    assert.deepEqual(h.audits, []);
    assert.equal(h.completed, undefined);
  }
});

test('expectedEtag null performs a create-only insert and refuses an existing representation', async () => {
  const h = harness();
  const created = await upsertReadingProgress(h.ports,
    h.input('in_progress', 0.25, { concurrency: { expectedEtag: null } }));
  assert.equal(created.kind, 'upserted');
  if (created.kind === 'upserted') {
    assert.equal(created.inserted, true);
    assert.equal(created.readingProgress.revision, 1);
  }
  assert.equal(h.audits.length, 1);
  const completedAfterCreate = h.completed;
  await assert.rejects(() => upsertReadingProgress(h.ports,
    h.input('in_progress', 0.5, { concurrency: { expectedEtag: null } })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_precondition_failed'
      && error.currentEtag === readingProgressEtag(h.row!));
  assert.equal(h.completed, completedAfterCreate);
  assert.equal(h.audits.length, 1);
  // without an insertOnly port the create-only intent still inserts through the ordinary upsert
  const fallback = harness({ progress: { insertOnly: undefined } });
  const viaUpsert = await upsertReadingProgress(fallback.ports,
    fallback.input('in_progress', 0.25, { concurrency: { expectedEtag: null } }));
  assert.equal(viaUpsert.kind, 'upserted');
  if (viaUpsert.kind === 'upserted') assert.equal(viaUpsert.inserted, true);
});

test('expectedEtag matching updates while a stale etag rejects with the current etag', async () => {
  const h = harness();
  const first = await upsertReadingProgress(h.ports, h.input('in_progress', 0.25));
  assert.equal(first.kind, 'upserted');
  const currentEtag = first.kind === 'upserted' ? readingProgressEtag(first.readingProgress) : '';
  const matched = await upsertReadingProgress(h.ports,
    h.input('in_progress', 0.75, { concurrency: { expectedEtag: currentEtag } }));
  assert.equal(matched.kind, 'upserted');
  if (matched.kind === 'upserted') {
    assert.equal(matched.inserted, false);
    assert.equal(matched.readingProgress.revision, 2);
  }
  const updatedEtag = matched.kind === 'upserted' ? readingProgressEtag(matched.readingProgress) : '';
  const auditsBefore = h.audits.length;
  await assert.rejects(() => upsertReadingProgress(h.ports,
    h.input('in_progress', 0.9, { concurrency: { expectedEtag: '"reading-progress:stale"' } })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_precondition_failed'
      && error.currentEtag === updatedEtag);
  assert.equal(h.audits.length, auditsBefore);
  // a strong tag can never match a missing representation
  const missing = harness();
  await assert.rejects(() => upsertReadingProgress(missing.ports,
    missing.input('in_progress', 0.5, { concurrency: { expectedEtag: '"reading-progress:ghost"' } })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_precondition_failed'
      && error.currentEtag === null);
  assert.equal(missing.completed, undefined);
  assert.deepEqual(missing.audits, []);
});

test('create-only insertOnly race reports the concurrent winner etag as a precondition failure', async () => {
  const winner: ReadingProgressRecord = { accountId: 'account-1', resourceType: 'node', resourceId: 'node-1',
    status: 'in_progress', progress: 0.5, revision: 1, completedAt: null,
    createdAt: new Date('2026-07-25T09:00:00.000Z'), updatedAt: new Date('2026-07-25T09:00:00.000Z') };
  let raced = false;
  const h = harness({
    progress: {
      async findForUpdate() { return raced ? winner : null; },
      async insertOnly() { raced = true; return null; },
    },
  });
  await assert.rejects(() => upsertReadingProgress(h.ports,
    h.input('in_progress', 0.25, { concurrency: { expectedEtag: null } })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_precondition_failed'
      && error.currentEtag === readingProgressEtag(winner));
  assert.equal(raced, true);
  assert.equal(h.completed, undefined);
  assert.deepEqual(h.audits, []);
});

test('reset honors the same expectedEtag precondition gate as upsert', async () => {
  const h = harness();
  const first = await upsertReadingProgress(h.ports, h.input('in_progress', 0.25));
  assert.equal(first.kind, 'upserted');
  const currentEtag = first.kind === 'upserted' ? readingProgressEtag(first.readingProgress) : '';
  await assert.rejects(() => resetReadingProgress(h.ports,
    { ...h.resetInput(), concurrency: { expectedEtag: '"reading-progress:stale"' } }),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_precondition_failed'
      && error.currentEtag === currentEtag);
  assert.notEqual(h.row, null);
  assert.equal(h.completed?.status, 201);
  const matched = await resetReadingProgress(h.ports,
    { ...h.resetInput(), concurrency: { expectedEtag: currentEtag } });
  assert.deepEqual(matched, { kind: 'reset', changed: true });
  assert.equal(h.completed?.status, 204);
});

test('concurrency preconditions require findForUpdate support from storage', async () => {
  const h = harness({ progress: { findForUpdate: undefined, insertOnly: undefined } });
  await assert.rejects(() => upsertReadingProgress(h.ports,
    h.input('in_progress', 0.25, { concurrency: { expectedEtag: null } })),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'invalid_reading_progress_input'
      && error.message === 'Storage does not support Reading Progress preconditions.');
  assert.equal(h.completed, undefined);
  assert.deepEqual(h.audits, []);
});

test('conceals inaccessible/deleted targets and validates stable account rather than Session identity', async () => {
  const h = harness({ targets: { async resolveAccessible() { return null; } } });
  await assert.rejects(() => upsertReadingProgress(h.ports, h.input()),
    (error: unknown) => error instanceof ReadingProgressError && error.code === 'reading_progress_not_found');
  await assert.rejects(() => upsertReadingProgress(h.ports, h.input('in_progress', 0.5, {
    actor: { principalId: 'principal-1', subjectId: 'subject-1', accountId: '' },
  })), (error: unknown) => error instanceof ReadingProgressError && error.code === 'invalid_reading_progress_input');
});

test('P2B-18 write and hydrate adapters reuse the Publication ancestor access fact', async () => {
  const fragment = buildPublicationTargetAncestorRestrictionSql('n');
  for (const guard of ["visibility in ('private','protected')", 'deleted_at is not null', 'cycle',
    `(depth = ${PUBLICATION_TARGET_ACCESS_MAX_DEPTH} and parent_id is not null)`,
    'parent_id is not null and not exists (']) {
    assert.ok(fragment.includes(guard), `Publication ancestor access fact is missing guard: ${guard}`);
  }
  for (const file of ['reading-progress-postgres.ts', 'reading-progress-read-postgres.ts']) {
    const source = await readFile(new URL(`../../../src/infrastructure/reading-progress/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes("buildPublicationBookmarkPublicAccessSql('n', 'c')"),
      `${file} must delegate bookmark access to the shared Publication fact`);
  }
});
