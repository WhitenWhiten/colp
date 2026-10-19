import { sha256 } from '@noble/hashes/sha2.js';

export const SUBTREE_OBSERVATION_EXTENSION = 'https://known.example/extensions/sync-subtree-observation-v1';
export interface SubtreeMemberRevision { readonly id: string; readonly revision: string }
/** A server's current view of a `delete_subtree` target, returned with `revision_conflict`. */
export interface SubtreeObservationSummary {
  readonly version: 1;
  readonly count: number;
  readonly digest: string;
  readonly memberIdsDigest: string;
}

const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;

/** Constant-size authority over the exact observed IDs and resource versions. */
export function subtreeDeleteSource(rootId: string, members: readonly SubtreeMemberRevision[]) {
  const ordered = orderedMembers(rootId, members, (row) => [row.id, row.revision]);
  return { extensions: { [SUBTREE_OBSERVATION_EXTENSION]: {
    version: 1, count: members.length, digest: streamDigest(rootId, ordered),
  } } };
}

/**
 * The same canonical shape over the member IDs alone. Two observations with
 * equal member-ID digests name the same nodes; only resource revisions differ.
 */
export function subtreeMemberIdsDigest(rootId: string, memberIds: readonly string[]): string {
  return streamDigest(rootId, orderedMembers(rootId, memberIds.map((id) => ({ id })), (row) => [row.id]));
}

/** Both digests of the current members, as a `revision_conflict` Problem reports them. */
export function subtreeObservationSummary(rootId: string, members: readonly SubtreeMemberRevision[]): SubtreeObservationSummary {
  const observation = subtreeDeleteSource(rootId, members).extensions[SUBTREE_OBSERVATION_EXTENSION]!;
  return { version: 1, count: observation.count, digest: observation.digest,
    memberIdsDigest: subtreeMemberIdsDigest(rootId, members.map((row) => row.id)) };
}

function orderedMembers<T extends { readonly id: string; readonly revision?: string }>(
  rootId: string, members: readonly T[], project: (row: T) => readonly string[],
): readonly (readonly string[])[] {
  if (!OPAQUE.test(rootId) || members.length > 100_000) throw new TypeError('Invalid subtree observation');
  const seen = new Set<string>();
  for (const member of members) {
    if (!OPAQUE.test(member.id) || (member.revision !== undefined && !OPAQUE.test(member.revision))
        || seen.has(member.id)) throw new TypeError('Invalid subtree observation');
    seen.add(member.id);
  }
  if (!seen.has(rootId)) throw new TypeError('Subtree observation root missing');
  return members.map(project).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
}

function streamDigest(rootId: string, ordered: readonly (readonly string[])[]): string {
  // Stream canonical JSON for this closed ASCII shape. The general Operation
  // encoder's 10k-member limit is not the subtree's 100k-node storage budget.
  const hash = sha256.create(); const encoder = new TextEncoder();
  hash.update(encoder.encode('{"members":['));
  ordered.forEach((row, index) => hash.update(encoder.encode(`${index ? ',' : ''}${JSON.stringify(row)}`)));
  hash.update(encoder.encode(`],"rootId":${JSON.stringify(rootId)}}`));
  let binary = ''; for (const byte of hash.digest()) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}
