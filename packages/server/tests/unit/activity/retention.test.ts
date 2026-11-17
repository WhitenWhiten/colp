import { Kysely, PostgresDialect } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import {
  drainActivityRetention,
  purgeActivity,
  scheduleActivityRetention,
} from '../../../src/infrastructure/activity/index.js';
import { up as createActivityRetentionIndexes } from '../../../migrations/202611170100_activity_retention_indexes.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeDb(rowsFor: (sql: string) => readonly unknown[]) {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      async query(sql: string, parameters: readonly unknown[]) {
        statements.push({ sql, parameters });
        const rows = rowsFor(sql);
        return { command: 'SELECT', rowCount: rows.length, rows };
      },
      release() {},
    }),
    end: async () => {},
    options: {},
    Client: class {},
  };
  return {
    db: new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: pool as never }) }),
    statements,
  };
}

describe('activity retention drain', () => {
  it('runs full batches until a pass comes back short', async () => {
    const purge = vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValueOnce(999);
    await expect(drainActivityRetention(purge, 1000)).resolves.toBe(2999);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(purge).toHaveBeenCalledWith(1000);
  });

  it('stops after an empty first batch', async () => {
    const purge = vi.fn().mockResolvedValue(0);
    await expect(drainActivityRetention(purge, 500)).resolves.toBe(0);
    expect(purge).toHaveBeenCalledOnce();
  });
});

describe('activity retention schedule', () => {
  it('runs a draining pass at start and on every tick', async () => {
    vi.useFakeTimers();
    const purge = vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const schedule = scheduleActivityRetention(purge, { intervalMs: 60_000, batchSize: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(purge).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purge).toHaveBeenCalledTimes(4);
    await schedule.stop();
  });

  it('unrefs the interval so retention never holds the process open', async () => {
    const unref = vi.fn();
    const setIntervalMock = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const clearIntervalMock = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const schedule = scheduleActivityRetention(vi.fn().mockResolvedValue(0), { intervalMs: 60_000 });
    expect(unref).toHaveBeenCalledOnce();
    await schedule.stop();
    expect(clearIntervalMock).toHaveBeenCalledWith(setIntervalMock.mock.results[0]!.value);
  });

  it('reports a failed pass and keeps the next tick eligible', async () => {
    vi.useFakeTimers();
    const failure = new Error('database unavailable');
    const onError = vi.fn();
    const purge = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(0);
    const schedule = scheduleActivityRetention(purge, { intervalMs: 60_000, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purge).toHaveBeenCalledTimes(2);
    await schedule.stop();
  });
});

describe('purgeActivity', () => {
  it('issues one bounded indexed delete per retention arm', async () => {
    const { db, statements } = fakeDb(sql => [
      { id: sql.includes("occurred_at<clock_timestamp()-interval '365 days'") ? 'expired' : 'read' },
    ]);
    await expect(purgeActivity(db, 25)).resolves.toBe(2);

    expect(statements).toHaveLength(2);
    const [occurred, read] = statements;
    expect(occurred!.sql).toContain("occurred_at<clock_timestamp()-interval '365 days'");
    expect(occurred!.sql).not.toContain('read_at');
    expect(occurred!.sql).toContain('ORDER BY occurred_at,id');
    expect(occurred!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(occurred!.parameters).toEqual([25]);
    expect(read!.sql).toContain('read_at IS NOT NULL');
    expect(read!.sql).toContain("updated_at<clock_timestamp()-interval '90 days'");
    expect(read!.sql).toContain('ORDER BY updated_at,id');
    expect(read!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(read!.parameters).toEqual([25]);
  });
});

describe('activity retention indexes', () => {
  it('serves the occurred_at arm and the partial read arm', async () => {
    const { db, statements } = fakeDb(() => []);
    await createActivityRetentionIndexes(db as unknown as Kysely<unknown>);

    expect(statements).toHaveLength(2);
    expect(statements[0]!.sql).toContain('activity_items_occurred_retention_idx');
    expect(statements[0]!.sql).toContain('ON activity_items(occurred_at,id)');
    expect(statements[1]!.sql).toContain('activity_items_read_retention_idx');
    expect(statements[1]!.sql).toContain('ON activity_items(updated_at,id) WHERE read_at IS NOT NULL');
  });
});
