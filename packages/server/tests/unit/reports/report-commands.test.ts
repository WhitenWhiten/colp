import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDigestSeries, ReportsApplicationError } from '../../../src/modules/reports/application/report-commands.js';
import { validateReportOutboxEvent, type ReportTransactionPorts } from '../../../src/modules/reports/application/contracts.js';

function ports(): ReportTransactionPorts {
  const revisions = ['r1', 'r2', 'r3', 'r4', 'r5'];
  const receipts = { claim: async () => ({ kind: 'claimed' as const }), complete: async () => undefined, purgeExpired: async () => 0, deletePrincipalReceipts: async () => 0 };
  return {
    receipts, revision: { next: () => revisions.shift() ?? 'rN', etag: (r: string) => `"${r}"`, matches: (r: string, e: string) => e === `"${r}"` },
    ids: { nextResourceId: (type) => `${type}-1`, nextEventId: () => 'event-1', nextOutboxId: () => 'outbox-1' },
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    series: { insert: async () => undefined, lockById: async () => null, update: async () => { throw new Error('unused'); }, nextEditionOrdinal: async () => 1 },
    editions: { insert: async () => undefined, lockById: async () => null, update: async () => { throw new Error('unused'); } },
    members: { ensureOwner: async () => undefined, get: async () => null }, source: { get: async () => null, getMany: async () => [] },
    audit: { append: async () => undefined }, outbox: { append: async () => undefined },
  };
}

describe('reports application contracts', () => {
  test('create claims receipt and writes owner membership', async () => {
    const p = ports(); let inserted = false; let owner = false;
    p.series.insert = async () => { inserted = true; };
    p.members.ensureOwner = async () => { owner = true; };
    const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(p) };
    const out = await createDigestSeries(uow, { actor: { principalId: 'p', subjectId: 's' }, commandId: '123e4567-e89b-42d3-a456-426614174000', title: 'Digest' });
    assert.equal(out.kind, 'succeeded'); assert.equal(inserted, true); assert.equal(owner, true);
  });

  test('create receipt records the wire status, ETag, and private cache policy', async () => {
    const p = { ...ports(), publicSurfacePurgeEnabled: true } as ReportTransactionPorts;
    let completed: { status: number; stableHeaders: Readonly<Record<string, string>> } | undefined;
    p.receipts.complete = async (_binding, _fingerprint, result) => {
      completed = { status: result.status, stableHeaders: result.stableHeaders };
    };
    const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(p) };
    await createDigestSeries(uow, {
      actor: { principalId: 'p', subjectId: 's' },
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Digest',
    });
    assert.equal(completed?.status, 201);
    assert.equal(completed?.stableHeaders['cache-control'], 'private, no-store');
    assert.equal(completed?.stableHeaders.etag, '"r1"');
  });

  test('public-surface purge is emitted only when a provider is composed', async () => {
    const p = { ...ports(), publicSurfacePurgeEnabled: true } as ReportTransactionPorts;
    const events: unknown[] = [];
    p.outbox.append = async (event) => { events.push(event); };
    const uow = { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(p) };
    await createDigestSeries(uow, {
      actor: { principalId: 'p', subjectId: 's' },
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Public digest', slug: 'public-digest', visibility: 'public',
    });
    assert.equal(events.filter((event) => (event as { eventType?: string }).eventType === 'reports.public_surface_purge.requested@1').length, 1);
  });

  test('closed outbox validator rejects unknown payload fields', () => {
    const event = { outboxId: 'o', eventId: 'e', eventType: 'reports.series.changed@1' as const, eventVersion: 1 as const, handlerName: 'h', handlerMode: 'projection_latest_only' as const, occurredAt: new Date(), payload: { seriesId: 's', resourceRevision: 'r', contentRevision: 'c', policyRevision: 'p', state: 'active', visibility: 'private', secret: 'x' } };
    assert.throws(() => validateReportOutboxEvent(event));
  });

  test('closed outbox validator rejects nested non-JSON values before serialization', () => {
    const event = {
      outboxId: 'o', eventId: 'e', eventType: 'reports.series.changed@1' as const,
      eventVersion: 1 as const, handlerName: 'reports_projection', handlerMode: 'projection_latest_only' as const,
      occurredAt: new Date(), payload: {
        seriesId: 's', resourceRevision: 'r', contentRevision: 'c', policyRevision: 'p',
        state: 'active', visibility: 'private', nested: BigInt(1),
      },
    };
    assert.throws(() => validateReportOutboxEvent(event));
  });

  test('invalid command id fails closed before receipt claim', async () => {
    await assert.rejects(() => createDigestSeries({ execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports()) }, { actor: { principalId: 'p', subjectId: 's' }, commandId: 'bad', title: 'Digest' }), (e: unknown) => e instanceof ReportsApplicationError && e.code === 'invalid_request');
  });

  test('series creation applies the canonical public slug predicate in the application layer', async () => {
    await assert.rejects(
      () => createDigestSeries(
        { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports()) },
        {
          actor: { principalId: 'p', subjectId: 's' },
          commandId: '123e4567-e89b-42d3-a456-426614174000',
          title: 'Digest',
          slug: 'Not-Canonical',
          visibility: 'public',
        },
      ),
      (error: unknown) => error instanceof Error && /invalid|canonical/u.test(error.message),
    );
  });
});
