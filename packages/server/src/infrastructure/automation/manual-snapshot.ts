import { automationDigest } from '@know-n/colp/automation';
import type { ManualSnapshot } from './manual-preview-store.js';

const MAX_SNAPSHOT_BYTES = 4_194_304;

/** Hash individually bounded members, then their ordered identities. A valid
 * 1,000-member selection need not fit one predicate's structural traversal cap. */
export function boundManualSnapshot(input: ManualSnapshot) {
  const { members, ...metadata } = input;
  let bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  const digests: string[] = [];
  for (const member of members) {
    bytes += Buffer.byteLength(JSON.stringify(member), 'utf8') + 1;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      const snapshot = { ...metadata, members: [], capacityExceeded: true };
      return { snapshot, digest: automationDigest({ version: 'manual-preview/v2', snapshot }), bounded: false };
    }
    digests.push(automationDigest(member));
  }
  return { snapshot: input, digest: automationDigest({ version: 'manual-preview/v2', metadata, members: digests }), bounded: true };
}
