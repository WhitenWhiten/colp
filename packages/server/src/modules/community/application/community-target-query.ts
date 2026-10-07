import { createHmac } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type { CommunityCommentSettingsRecord } from './community-comment.js';
import {
  CommunityTargetError,
  communityTargetIdentity,
  type CommunityCommentDeniedReason,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type CommunityTargetQuery,
  type CommunityTargetView,
  type CommunityVoteValue,
} from './community-target.js';

/**
 * The resolved authority row for a live, community-eligible target.
 * `ownerSubjectId` is the account subject that owns the target (the series
 * owner for digest editions, the collection owner for bookmarks) and drives
 * the self-vote rejection and curation hints.
 */
export interface ResolvedCommunityTarget {
  readonly target: CommunityTarget;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly href: string;
}

export interface CommunityVoteCounts {
  readonly up: number;
  readonly down: number;
  /** The viewer's own vote (0 = none). Null for anonymous viewers. */
  readonly myVote: CommunityVoteValue | null;
}

/** Read ports for resolveCommunityTarget. No locks: counts are point-in-time. */
export interface CommunityTargetQueryPorts {
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /** Batch form, positionally aligned; see `CommunityRankingQueryPorts`. */
    resolveMany?(queries: readonly CommunityTargetQuery[]):
      Promise<readonly (ResolvedCommunityTarget | null)[]>;
  };
  readonly votes: {
    readCounts(
      identity: CommunityTargetIdentity,
      generation: string,
      viewerAccountId: string | null,
    ): Promise<CommunityVoteCounts>;
  };
  /**
   * CS-04: target owner OR active owner/editor member of the governing
   * collection/series — drives `canCurateComments` and the curation/
   * settings authority checks.
   */
  readonly curators: {
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  /**
   * CS-04: per-target comment-area settings (generation-independent, with
   * the active official lock overlay already applied). A locked area denies
   * `canComment` for a signed-in viewer and sets `commentDeniedReason`.
   */
  readonly settings: {
    find(identity: CommunityTargetIdentity): Promise<CommunityCommentSettingsRecord | null>;
  };
}

export interface CommunityTargetViewer {
  readonly accountId: string | null;
  readonly subjectId: string | null;
}

export const COMMUNITY_TARGET_CONCEALED_MESSAGE = 'The community target was not found.';

/**
 * Resolve a live, community-interactable target for the current viewer.
 * Missing, non-public, withdrawn, or otherwise concealed targets all produce
 * the same resource_not_found — nothing about the target's real state leaks.
 */
export async function resolveCommunityTargetView(
  ports: CommunityTargetQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly query: CommunityTargetQuery;
  },
): Promise<CommunityTargetView> {
  const resolved = await ports.targets.resolve(input.query);
  if (resolved === null) {
    throw new CommunityTargetError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
  }
  const identity = communityTargetIdentity(resolved.target);
  const counts = await ports.votes.readCounts(
    identity,
    resolved.target.generation,
    input.viewer.accountId,
  );
  const authenticated = input.viewer.accountId !== null && input.viewer.subjectId !== null;
  const isOwner = authenticated && input.viewer.subjectId === resolved.ownerSubjectId;
  /* CS-04: the area lock applies to every new write, curators included, so a
     signed-in denial carries the same reason the write path would reject
     with. Anonymous viewers are denied regardless — skip the settings read
     entirely rather than pay for a row their verdict ignores. */
  const areaLocked = authenticated
    && (await ports.settings.find(identity))?.locked === true;
  const commentDeniedReason: CommunityCommentDeniedReason | null = !authenticated
    ? 'anonymous' : areaLocked ? 'locked' : null;
  // CS-04: curators are the owner plus owner/editor members of the
  // governing collection/series — a superset of owner-only.
  const canCurate = authenticated
    && await ports.curators.canCurate(identity, input.viewer.subjectId!);
  const votes = Object.freeze({
    target: resolved.target,
    up: counts.up,
    down: counts.down,
    myVote: counts.myVote,
  });
  return Object.freeze<CommunityTargetView>({
    target: resolved.target,
    title: resolved.title,
    href: resolved.href,
    canVote: authenticated && !isOwner,
    canComment: authenticated && !areaLocked,
    commentDeniedReason,
    canCurateComments: canCurate,
    votes,
  });
}

/**
 * Strong opaque ETag for the resolved TargetView. The configured community
 * HMAC key makes the tag unforgeable so clients can only echo it back.
 */
export function communityTargetViewEtag(view: CommunityTargetView, hmacKey: Buffer): string {
  const digest = createHmac('sha256', hmacKey)
    .update(canonicalJson(view), 'utf8')
    .digest('base64url');
  return `"community-target:${digest.slice(0, 32)}"`;
}
