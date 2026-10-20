import { SyncFailureError } from './sync-failure-class.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { QueueOperation } from './sync-state-store.js';

export function encodeRequest(queue: QueueOperation, sessionId: string, batchId: string) {
  return canonicalJson({ sessionId, batchId, atomic: false, operations: [queue.payload] });
}
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SyncFailureError('push_request_invalid'); return encoded; }
export function digestJson(value: unknown) { return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value)))); }
export function digestBytes(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }
