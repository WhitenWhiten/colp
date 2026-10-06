import { sha256 } from '@noble/hashes/sha2.js';

export const SUBTREE_OBSERVATION_EXTENSION = 'https://known.example/extensions/sync-subtree-observation-v1';
export interface SubtreeMemberRevision { readonly id: string; readonly revision: string }

/** Constant-size authority over the exact observed IDs and resource versions. */
export function subtreeDeleteSource(rootId: string, members: readonly SubtreeMemberRevision[]) {
  const opaque = /^[A-Za-z0-9._~-]{1,128}$/u;
  if (!opaque.test(rootId) || members.length > 100_000) throw new TypeError('Invalid subtree observation');
  const seen = new Set<string>();
  for (const member of members) {
    if (!opaque.test(member.id) || !opaque.test(member.revision) || seen.has(member.id)) throw new TypeError('Invalid subtree observation');
    seen.add(member.id);
  }
  if (!seen.has(rootId)) throw new TypeError('Subtree observation root missing');
  const ordered = members.map(row => [row.id, row.revision])
    .sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  // Stream canonical JSON for this closed ASCII shape. The general Operation
  // encoder's 10k-member limit is not the subtree's 100k-node storage budget.
  const hash = sha256.create(); const encoder = new TextEncoder();
  hash.update(encoder.encode('{"members":['));
  ordered.forEach((row, index) => hash.update(encoder.encode(`${index ? ',' : ''}${JSON.stringify(row)}`)));
  hash.update(encoder.encode(`],"rootId":${JSON.stringify(rootId)}}`));
  let binary = ''; for (const byte of hash.digest()) binary += String.fromCharCode(byte);
  return { extensions: { [SUBTREE_OBSERVATION_EXTENSION]: {
    version: 1, count: members.length, digest: `sha-256=:${btoa(binary)}:`,
  } } };
}
