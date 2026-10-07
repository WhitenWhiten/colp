import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  canonicalRRule,
  catchUpOccurrences,
  normalizeSchedule,
  occurrences,
} from '../../../src/modules/reports/application/schedule.js';
import {
  createDigestScheduler,
  type DigestSchedulerStore,
} from '../../../src/modules/reports/application/scheduler.js';
import { composeReportsScheduler } from '../../../src/modules/reports/application/composition.js';
import type { DigestRun, DigestSchedule } from '../../../src/modules/reports/domain/types.js';

function schedule(overrides: Partial<DigestSchedule> = {}): DigestSchedule {
  return {
    id: 'schedule-1',
    seriesId: 'series-1',
    enabled: true,
    rrule: 'FREQ=DAILY',
    dtstart: '2026-09-03T09:00:00.000Z',
    timeZone: 'UTC',
    catchUpPolicy: 'skip',
    maxCatchUp: 0,
    nextRunAt: null,
    resourceRevision: 'revision-1',
    ...overrides,
  };
}

function memoryStore(inputSchedule: DigestSchedule) {
  const runs = new Map<string, DigestRun>();
  let sequence = 0;
  const store: DigestSchedulerStore = {
    async listDue() { return [inputSchedule]; },
    async getSchedule(id) { return id === inputSchedule.id ? inputSchedule : null; },
    async listDueRuns(now, limit) {
      return [...runs.values()].filter((run) => run.scheduledFor <= now.toISOString()
        && ((run.state === 'pending' || run.state === 'retryable')
          && (run.nextAttemptAt === null || run.nextAttemptAt <= now.toISOString())
          || run.state === 'leased' && run.leaseUntil !== null && run.leaseUntil <= now.toISOString()))
        .slice(0, limit);
    },
    async upsertRun(value) {
      assert.equal(value.scheduleRevision, inputSchedule.resourceRevision);
      const current = runs.get(value.occurrenceKey);
      if (current) return current;
      const created: DigestRun = {
        id: `run-${++sequence}`,
        ...value,
        leaseGeneration: 0,
      };
      runs.set(value.occurrenceKey, created);
      return created;
    },
    async claimRun(id, owner, leaseMs, now, expectedGeneration) {
      for (const run of runs.values()) {
        if (run.id !== id) continue;
        if (run.state !== 'pending' && run.state !== 'retryable'
          && !(run.state === 'leased' && run.leaseUntil !== null && run.leaseUntil <= now.toISOString())) return null;
        if (expectedGeneration !== undefined && expectedGeneration !== run.leaseGeneration) return null;
        const claimed: DigestRun = {
          ...run,
          state: 'leased',
          leaseOwner: owner,
          leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
          leaseGeneration: run.leaseGeneration + 1,
          attemptCount: run.attemptCount + 1,
        };
        runs.set(run.occurrenceKey, claimed);
        return claimed;
      }
      return null;
    },
    async completeRun(id, owner, generation) {
      for (const [key, run] of runs) {
        if (run.id === id && run.leaseOwner === owner && (generation === undefined || run.leaseGeneration === generation)) {
          runs.set(key, { ...run, state: 'succeeded', leaseOwner: null, leaseUntil: null });
          return true;
        }
      }
      return false;
    },
    async retryRun(id, owner, errorClass, nextAttemptAt, generation) {
      for (const [key, run] of runs) {
        if (run.id === id && run.leaseOwner === owner && (generation === undefined || run.leaseGeneration === generation)) {
          runs.set(key, { ...run, state: 'retryable', leaseOwner: null, leaseUntil: null, lastErrorClass: errorClass, nextAttemptAt: nextAttemptAt.toISOString() });
          return true;
        }
      }
      return false;
    },
    async failRun(id, owner, errorClass, generation) {
      for (const [key, run] of runs) {
        if (run.id === id && run.leaseOwner === owner && (generation === undefined || run.leaseGeneration === generation)) {
          runs.set(key, { ...run, state: 'failed', leaseOwner: null, leaseUntil: null, lastErrorClass: errorClass, nextAttemptAt: null });
          return true;
        }
      }
      return false;
    },
    async advanceSchedule() {},
  };
  return { store, runs };
}

describe('reports scheduler and RRULE bounds', () => {
  test.each([
    { rrule: 'FREQ=MONTHLY', dtstart: '2026-01-31T09:00:00Z',
      from: '2026-03-01T00:00:00Z', until: '2026-04-30T23:59:59Z',
      expected: ['2026-03-31T09:00:00.000Z'] },
    { rrule: 'FREQ=YEARLY', dtstart: '2024-02-29T09:00:00Z',
      from: '2027-01-01T00:00:00Z', until: '2028-12-31T23:59:59Z',
      expected: ['2028-02-29T09:00:00.000Z'] },
  ])('REVIEW: bounded scanning preserves the original calendar anchor for $rrule', input => {
    const values = occurrences(schedule(input), new Date(input.from), new Date(input.until), 10);
    assert.deepEqual(values.map(value => value.toISOString()), input.expected);
  });

  test('canonicalises rules and handles DST gap/fold through IANA tzdata', () => {
    assert.equal(canonicalRRule('byday=SU;freq=weekly'), 'BYDAY=SU;FREQ=WEEKLY');
    assert.throws(() => canonicalRRule('FREQ=DAILY;;INTERVAL=1'), /invalid rrule/u);
    const daily = normalizeSchedule({
      rrule: 'FREQ=DAILY;COUNT=4',
      dtstart: '2024-03-09T09:00:00Z',
      timeZone: 'America/New_York',
    });
    const values = occurrences(
      { ...daily, id: 's', seriesId: 'x', enabled: true, nextRunAt: null, resourceRevision: 'r' },
      new Date('2024-03-09T00:00:00Z'),
      new Date('2024-03-13T00:00:00Z'),
    );
    assert.deepEqual(values.map((value) => value.toISOString()), [
      '2024-03-09T09:00:00.000Z',
      '2024-03-10T08:00:00.000Z',
      '2024-03-11T08:00:00.000Z',
      '2024-03-12T08:00:00.000Z',
    ]);
    const folded = normalizeSchedule({
      rrule: 'FREQ=DAILY;COUNT=3',
      dtstart: '2024-11-02T05:30:00Z',
      timeZone: 'America/New_York',
    });
    assert.deepEqual(occurrences({
      ...folded, id: 'fold', seriesId: 'x', enabled: true,
      nextRunAt: null, resourceRevision: 'r',
    }, new Date('2024-11-02T00:00:00Z'), new Date('2024-11-05T00:00:00Z'), 10)
      .map((value) => value.toISOString()), [
      '2024-11-02T05:30:00.000Z',
      '2024-11-03T05:30:00.000Z',
      '2024-11-03T06:30:00.000Z',
      '2024-11-04T06:30:00.000Z',
    ]);
    assert.throws(() => normalizeSchedule({
      rrule: 'FREQ=SECONDLY', dtstart: '2026-09-03T09:00:00Z', timeZone: 'UTC',
    }), /COUNT or UNTIL/u);
  });

  test('long-lived daily schedules use an aligned bounded scan origin', () => {
    const normalized = normalizeSchedule({
      rrule: 'FREQ=DAILY',
      dtstart: '2010-01-01T09:00:00Z',
      timeZone: 'UTC',
    });
    const values = occurrences({
      ...normalized, id: 'schedule-1', seriesId: 'series-1', enabled: true,
      nextRunAt: null, resourceRevision: 'r1',
    }, new Date('2026-09-03T00:00:00Z'), new Date('2026-09-04T23:00:00Z'), 2);
    assert.deepEqual(values.map((value) => value.toISOString()), [
      '2026-09-03T09:00:00.000Z', '2026-09-04T09:00:00.000Z',
    ]);
  });

  test('bounded catch-up retains the occurrence at the current instant', () => {
    const normalized = normalizeSchedule({
      rrule: 'FREQ=DAILY',
      dtstart: '2010-01-01T09:00:00Z',
      timeZone: 'UTC',
      catchUpPolicy: 'one',
      maxCatchUp: 2,
    });
    const values = catchUpOccurrences({
      ...normalized, id: 'schedule-1', seriesId: 'series-1', enabled: true,
      nextRunAt: null, resourceRevision: 'r1',
    }, new Date('2026-09-04T10:00:00Z'));
    assert.deepEqual(values.map((value) => value.toISOString()), [
      '2026-09-03T09:00:00.000Z', '2026-09-04T09:00:00.000Z',
    ]);
  });

  test('submits a deterministic occurrence once and fences completion by generation', async () => {
    const fixture = memoryStore(schedule());
    let submitted = 0;
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      connector: { submit: async (run) => { submitted += 1; return { issueKey: run.issueKey!, commandId: run.commandId! }; } },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(await scheduler.runOnce(), 0);
    assert.equal(submitted, 1);
    assert.equal([...fixture.runs.values()][0]?.state, 'succeeded');
  });

  test('catch-up policy with a zero quota never schedules an occurrence', async () => {
    const fixture = memoryStore(schedule({ catchUpPolicy: 'one', maxCatchUp: 0 }));
    let submitted = 0;
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      connector: { submit: async (run) => { submitted += 1; return { issueKey: run.issueKey!, commandId: run.commandId! }; } },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(await scheduler.runOnce(), 0);
    assert.equal(submitted, 0);
  });

  test('deployment catch-up cap limits expansion and supports an explicit zero', async () => {
    const capped = memoryStore(schedule({
      dtstart: '2026-09-01T09:00:00.000Z',
      catchUpPolicy: 'one',
      maxCatchUp: 10,
    }));
    let submitted = 0;
    const scheduler = createDigestScheduler({
      store: capped.store,
      ownerId: 'worker-1',
      maxCatchUp: 2,
      connector: { submit: async (run) => {
        submitted += 1;
        return { issueKey: run.issueKey!, commandId: run.commandId! };
      } },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(await scheduler.runOnce(), 2);
    assert.equal(submitted, 2);

    const disabled = memoryStore(schedule({ catchUpPolicy: 'one', maxCatchUp: 10 }));
    let disabledSubmissions = 0;
    const disabledScheduler = createDigestScheduler({
      store: disabled.store,
      ownerId: 'worker-1',
      maxCatchUp: 0,
      connector: { submit: async (run) => {
        disabledSubmissions += 1;
        return { issueKey: run.issueKey!, commandId: run.commandId! };
      } },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(await disabledScheduler.runOnce(), 0);
    assert.equal(disabledSubmissions, 0);
  });

  test('deployment catch-up cap is bounded by the hard safety ceiling', () => {
    const fixture = memoryStore(schedule());
    assert.throws(() => createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      maxCatchUp: 101,
    }), /maxCatchUp is out of range/u);
    assert.throws(() => createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      maxCatchUp: -1,
    }), /maxCatchUp is out of range/u);
  });

  test('scheduler composition forwards the deployment catch-up cap', async () => {
    const fixture = memoryStore(schedule({ catchUpPolicy: 'one', maxCatchUp: 10 }));
    let submitted = 0;
    const composed = composeReportsScheduler({
      enabled: true,
      store: fixture.store,
      maxCatchUp: 0,
      connector: { submit: async (run) => {
        submitted += 1;
        return { issueKey: run.issueKey!, commandId: run.commandId! };
      } },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(composed.readiness(), 'ready');
    assert.equal(await composed.scheduler.runOnce(), 0);
    assert.equal(submitted, 0);
  });

  test('keeps the schedule pointer parked while a retry backoff is pending', async () => {
    const fixture = memoryStore(schedule());
    const claim = fixture.store.claimRun;
    let advanceCalls = 0;
    fixture.store.claimRun = async (runId, owner, leaseMs, at, generation) => {
      const run = [...fixture.runs.values()].find((candidate) => candidate.id === runId);
      if (run?.state === 'retryable' && run.nextAttemptAt !== null
        && Date.parse(run.nextAttemptAt) > at.getTime()) return null;
      return claim(runId, owner, leaseMs, at, generation);
    };
    fixture.store.advanceSchedule = async () => { advanceCalls += 1; };
    let clock = new Date('2026-09-04T10:00:00.000Z');
    let submissions = 0;
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      connector: { submit: async (run) => {
        submissions += 1;
        if (submissions === 1) throw new Error('temporary connector failure');
        return { issueKey: run.issueKey!, commandId: run.commandId! };
      } },
      now: () => clock,
    });
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(advanceCalls, 0);
    clock = new Date(clock.getTime() + 500);
    assert.equal(await scheduler.runOnce(), 0);
    assert.equal(advanceCalls, 0);
    clock = new Date(clock.getTime() + 2_000);
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(advanceCalls, 1);
    assert.equal(submissions, 2);
  });

  test('identity mismatch retries and max attempts reaches failed, never succeeds', async () => {
    const fixture = memoryStore(schedule());
    const errors: unknown[] = [];
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      maxAttempts: 1,
      connector: { submit: async () => ({ issueKey: 'forged', commandId: 'forged' }) },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
      onError: (error) => errors.push(error),
    });
    assert.equal(await scheduler.runOnce(), 1);
    const run = [...fixture.runs.values()][0]!;
    assert.equal(run.state, 'failed');
    assert.equal(run.lastErrorClass, 'identity_mismatch');
    assert.equal(errors.length, 1);
  });

  test('aborts a slow connector before lease expiry and keeps its retry fenced', async () => {
    const fixture = memoryStore(schedule());
    let aborted = false;
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      leaseMs: 1_000,
      handlerTimeoutMs: 100,
      connector: {
        submit: async (_run, _seriesId, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ issueKey: 'late', commandId: 'late' });
          }, { once: true });
        }),
      },
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(aborted, true);
    const run = [...fixture.runs.values()][0]!;
    assert.equal(run.state, 'retryable');
    assert.equal(await fixture.store.completeRun(run.id, 'worker-1', 1), false);
  });

  test('start/stop owns one bounded timer and is idempotent', async () => {
    const fixture = memoryStore(schedule({ dtstart: '2099-01-01T00:00:00.000Z' }));
    const scheduler = createDigestScheduler({
      store: fixture.store,
      ownerId: 'worker-1',
      connector: { submit: async (run) => ({ issueKey: run.issueKey!, commandId: run.commandId! }) },
      pollIntervalMs: 100,
      now: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    scheduler.start();
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);
    await scheduler.stop();
    await scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
  });
});
