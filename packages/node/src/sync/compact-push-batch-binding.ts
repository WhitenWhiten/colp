import { createHash } from 'node:crypto';

/** Fixed-size fallback for opaque Session and local IDs whose b1 framing cannot fit. */
export interface CompactSyncPushBatchBinding {
  readonly version: 2;
  readonly sessionDigest: string;
  readonly suffixDigest: string;
  readonly sessionId?: never;
  readonly suffix?: never;
}

function digest(kind: 'session' | 'suffix', value: string): string {
  return createHash('sha256').update(`colp.sync.push.batch.v2.${kind}\0`, 'ascii')
    .update(value, 'ascii').digest('base64url');
}

export function bindCompactSyncPushBatchId(sessionId: string, suffix: string): string {
  return `b2.${digest('session', sessionId)}.${digest('suffix', suffix)}`;
}

export function readCompactSyncPushBatchBinding(batchId: string): CompactSyncPushBatchBinding | undefined {
  const match = /^b2\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(batchId);
  if (!match) return undefined;
  const sessionDigest = match[1]!;
  const suffixDigest = match[2]!;
  // Reject alternate encodings of the final base64 sextet's unused bits.
  if ([sessionDigest, suffixDigest].some(value => Buffer.from(value, 'base64url').toString('base64url') !== value)) {
    return undefined;
  }
  return Object.freeze({ version: 2, sessionDigest, suffixDigest });
}

export function compactSyncPushBatchMatchesSession(binding: CompactSyncPushBatchBinding, sessionId: string): boolean {
  return binding.sessionDigest === digest('session', sessionId);
}
