import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import {
  appendCommunityRankRefreshOutbox,
  communityRankRefreshPending,
} from './community-rank-refresh-outbox.js';

/**
 * CS-02 periodic refresh producer (COMMUNITY_RANK_REFRESH_SECONDS cadence).
 *
 * The scheduler is a producer only: every interval it durably enqueues ONE
 * `community.rank-refresh` event when no unfinished event exists. The actual
 * rebuild runs on the shared outbox worker route, so worker restart picks up
 * the pending row without any process-local state. Double-start is refused
 * so the same consumer identity can never run twice.
 */
export interface CommunityRankRefreshScheduler {
  /** Enqueue a refresh event when none is pending/leased; returns true when enqueued. */
  runOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createCommunityRankRefreshScheduler(options: {
  readonly db: Kysely<DatabaseSchema>;
  readonly intervalMs: number;
  readonly logger?: { warn(bindings: object, message: string): void };
  readonly metrics?: { increment(name: string, value?: number): void };
}): CommunityRankRefreshScheduler {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1_000) {
    throw new RangeError('community rank refresh interval must be at least 1000ms');
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<boolean> | undefined;

  const runOnce = (): Promise<boolean> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = createUnitOfWork(options.db, { isolationLevel: 'read committed' })
      .execute(async ({ transaction }) => {
        if (await communityRankRefreshPending(transaction)) return false;
        await appendCommunityRankRefreshOutbox(transaction, 'scheduled');
        return true;
      })
      .catch((error: unknown) => {
        options.metrics?.increment('community.rank_refresh.schedule_error');
        options.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Community rank refresh scheduling failed',
        );
        return false;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return Object.freeze<CommunityRankRefreshScheduler>({
    runOnce,
    start() {
      if (timer !== undefined) {
        throw new Error('community rank refresh scheduler is already running');
      }
      timer = setInterval(() => { void runOnce(); }, options.intervalMs);
      timer.unref();
      // Fire the first pass immediately so a fresh deployment does not wait a
      // full interval for its initial snapshot.
      void runOnce();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight;
    },
    isRunning: () => timer !== undefined,
  });
}
