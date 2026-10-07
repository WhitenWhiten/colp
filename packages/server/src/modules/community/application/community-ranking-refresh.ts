/**
 * CS-02 community hot ranking: the durable refresh pass.
 *
 * One pass enumerates every currently-eligible target (the same predicate
 * the resolve port re-proves), joins the RETAINED `community_votes` table
 * for current-generation counts and `community_vote_targets` for the first
 * accepted vote instant, scores each row with the frozen `hot-v1` domain
 * formula, sorts by (hot DESC, kind ASC, id ASC) and writes a new snapshot
 * (header + contiguous 1-based entry positions) in one transaction. Old
 * snapshots are pruned once their cursor TTL horizon has passed; the newest
 * snapshot is always retained.
 *
 * The rebuild derives only from the vote tables — never from historical
 * outbox rows — so a fully rebuilt projection matches live vote authority.
 */
import {
  COMMUNITY_HOT_SCORE_VERSION,
  computeCommunityHotScore,
} from '../community-hot-score.js';
import type { CommunityTarget } from './community-target.js';

/** Contract constant: the periodic re-enqueue cadence (seconds). */
export const COMMUNITY_RANK_REFRESH_SECONDS = 60 as const;
/**
 * Snapshot retention horizon: twice the 900s cursor TTL, so an in-flight
 * cursor's snapshot is guaranteed present for its whole validity window.
 */
export const COMMUNITY_RANK_SNAPSHOT_RETENTION_MS = 1_800_000;

/** One eligible target row joined with its current-generation vote facts. */
export interface CommunityRankCandidate {
  readonly target: CommunityTarget;
  readonly title: string;
  readonly href: string;
  readonly tags: readonly string[];
  /** Canonical BCP47 or null (unknown language stays null, never invented). */
  readonly language: string | null;
  readonly up: number;
  readonly down: number;
  readonly firstVoteAt: Date | null;
}

export interface CommunityRankedWriteEntry {
  readonly position: number;
  readonly target: CommunityTarget;
  readonly title: string;
  readonly href: string;
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly up: number;
  readonly down: number;
  readonly firstVoteAt: Date | null;
  readonly hot: number;
}

export interface CommunityRankingRefreshPorts {
  readonly sources: {
    /** Every currently-eligible target with current-generation vote facts. */
    listCandidates(): Promise<readonly CommunityRankCandidate[]>;
  };
  readonly snapshots: {
    /** Production adapters can score bounded batches and sort in durable scratch storage. */
    writeFromCandidates?(input: {
      readonly scoreVersion: string; readonly createdAt: Date;
      readonly score: (candidate: CommunityRankCandidate) => Omit<CommunityRankedWriteEntry, 'position'>;
    }): Promise<{ readonly snapshotId: string; readonly itemCount: number }>;
    /** Persist the new snapshot header + entries atomically; returns its id. */
    writeSnapshot(input: {
      readonly scoreVersion: string;
      readonly createdAt: Date;
      readonly entries: readonly CommunityRankedWriteEntry[];
    }): Promise<string>;
    /** Drop snapshots older than `createdBefore`, always keeping the newest. */
    pruneSnapshots(input: { readonly createdBefore: Date }): Promise<number>;
  };
  readonly clock: { now(): Promise<Date> };
}

export interface CommunityRankingRefreshResult {
  readonly snapshotId: string;
  readonly itemCount: number;
  readonly prunedSnapshots: number;
  readonly scoreVersion: typeof COMMUNITY_HOT_SCORE_VERSION;
}

/**
 * Rebuild the hot ranking projection from live vote authority. Runs inside
 * the caller's unit of work; concurrent passes are serialized by the outbox
 * lease fence on the shared `community_ranking` aggregate.
 */
export async function refreshCommunityRanking(
  ports: CommunityRankingRefreshPorts,
): Promise<CommunityRankingRefreshResult> {
  const now = await ports.clock.now();
  let snapshotId: string;
  let itemCount: number;
  if (ports.snapshots.writeFromCandidates) {
    ({ snapshotId, itemCount } = await ports.snapshots.writeFromCandidates({
      scoreVersion: COMMUNITY_HOT_SCORE_VERSION, createdAt: now,
      score: candidate => scoreCandidate(candidate, now),
    }));
  } else {
    const candidates = await ports.sources.listCandidates();
    const scored = candidates.map(candidate => scoreCandidate(candidate, now));
    scored.sort((left, right) => (right.hot - left.hot)
      || (left.target.kind < right.target.kind ? -1 : left.target.kind > right.target.kind ? 1 : 0)
      || (left.target.id < right.target.id ? -1 : left.target.id > right.target.id ? 1 : 0));
    const entries = scored.map((row, index) => Object.freeze({ ...row, position: index + 1 }));
    snapshotId = await ports.snapshots.writeSnapshot({
      scoreVersion: COMMUNITY_HOT_SCORE_VERSION, createdAt: now, entries,
    });
    itemCount = entries.length;
  }
  const prunedSnapshots = await ports.snapshots.pruneSnapshots({
    createdBefore: new Date(now.getTime() - COMMUNITY_RANK_SNAPSHOT_RETENTION_MS),
  });
  return Object.freeze<CommunityRankingRefreshResult>({
    snapshotId,
    itemCount,
    prunedSnapshots,
    scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
  });
}

function scoreCandidate(candidate: CommunityRankCandidate, now: Date): Omit<CommunityRankedWriteEntry, 'position'> {
  const firstVoteAt = candidate.up + candidate.down > 0 ? candidate.firstVoteAt : null;
  return Object.freeze({ ...candidate, firstVoteAt, hot: computeCommunityHotScore({
    up: candidate.up, down: candidate.down, firstVoteAt, now,
  }) });
}
