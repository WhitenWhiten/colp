import { createHash } from 'node:crypto';
import { SUBTREE_OBSERVATION_EXTENSION, subtreeDeleteSource, type SubtreeMemberRevision } from '@know-n/colp/sync';
import type { SyncPushSubtreeSummary } from '../../modules/sync/sync-push.js';

/**
 * The current members of a `delete_subtree` target, as a `revision_conflict`
 * Problem reports them (03 §13.1): the count and digest the precondition
 * expects now, plus the same canonical digest over the member IDs alone so a
 * client can tell changed members from changed revisions.
 *
 * The ID digest mirrors `subtreeMemberIdsDigest()` in `@know-n/colp` 0.2.2;
 * it is computed here so the server can report it with the package it pins.
 */
export function subtreeObservationSummary(rootId: string, members: readonly SubtreeMemberRevision[]): SyncPushSubtreeSummary {
  const observation = subtreeDeleteSource(rootId, members).extensions[SUBTREE_OBSERVATION_EXTENSION]!;
  return Object.freeze({ version: 1, count: observation.count, digest: observation.digest,
    memberIdsDigest: subtreeMemberIdsDigest(rootId, members.map((row) => row.id)) });
}

export function subtreeMemberIdsDigest(rootId: string, memberIds: readonly string[]): string {
  // `subtreeDeleteSource` already validated the IDs and the root membership.
  const ordered = [...memberIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const hash = createHash('sha256');
  hash.update('{"members":[');
  ordered.forEach((id, index) => hash.update(`${index ? ',' : ''}${JSON.stringify([id])}`));
  hash.update(`],"rootId":${JSON.stringify(rootId)}}`);
  return `sha-256=:${hash.digest('base64')}:`;
}
