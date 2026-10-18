import { SyncFailureError } from './sync-failure-class.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readBoundedJson } from './json-response.js';
import type { JsonObject } from './sync-state-store.js';

const PAGE_LIMIT = 50;
const PRIVATE_KEYS = new Set(['base', 'server', 'incoming']);

export interface SnapshotOpenConflict {
  readonly id: string;
  readonly collectionId: string;
  readonly targetId: string;
  readonly type: string;
  readonly field?: string;
  readonly incomingOpId?: string;
  readonly createdAt: string;
  readonly status: 'open';
  readonly allowedResolutions: readonly string[];
  readonly revision: string;
}

/** Same byte string the server hashes for the Snapshot cut. */
export function snapshotOpenConflictDigest(rows: readonly { readonly id: string; readonly revision: string }[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(rows.map((row) => `${row.id}\t${row.revision}`).join('\n'))));
}

/**
 * Read the cut's open conflicts and persist every one before confirming.
 * Confirmation is what allows bootstrap Ack; an empty cut confirms nothing.
 */
export async function persistSnapshotOpenConflicts(input: {
  readonly snapshotUrl: string;
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly maxBytes: number;
  readonly timeoutMilliseconds?: number;
  readonly persist: (conflict: SnapshotOpenConflict) => Promise<void>;
}): Promise<{ readonly conflictCount: number; readonly conflictDigest: string }> {
  const conflicts: SnapshotOpenConflict[] = [];
  let offset = 0;
  let conflictCount = 0;
  for (let page = 0; page < 10_000; page += 1) {
    const url = new URL(input.snapshotUrl);
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/conflicts`;
    url.searchParams.set('sessionId', input.sessionId);
    url.searchParams.set('snapshotId', input.snapshotId);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    const response = await input.fetch(url.toString(), {
      method: 'GET', redirect: 'error', cache: 'no-store', headers: conflictHeaders(input.headers),
    });
    if (response.status !== 200) throw new Error(await problemCode(response, 'snapshot_conflict_page_invalid'));
    const body = await readBoundedJson(response, input.maxBytes, 'snapshot_conflict_page_invalid',
      input.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: input.timeoutMilliseconds });
    const parsed = parsePage(body, input.snapshotId, offset);
    conflictCount = parsed.conflictCount;
    for (const conflict of parsed.conflicts) {
      if (conflicts.some((prior) => prior.id === conflict.id)) throw new SyncFailureError('snapshot_conflict_page_invalid');
      conflicts.push(conflict);
      await input.persist(conflict);
    }
    if (parsed.nextOffset === null) break;
    if (parsed.nextOffset <= offset) throw new SyncFailureError('snapshot_conflict_page_invalid');
    offset = parsed.nextOffset;
  }
  if (conflicts.length !== conflictCount) throw new SyncFailureError('snapshot_conflict_page_invalid');
  const conflictDigest = snapshotOpenConflictDigest(conflicts);
  if (conflictCount > 0) {
    const url = new URL(input.snapshotUrl);
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/conflicts`;
    url.searchParams.set('sessionId', input.sessionId);
    url.searchParams.set('snapshotId', input.snapshotId);
    const response = await input.fetch(url.toString(), {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { ...conflictHeaders(input.headers), 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: input.snapshotId, conflictDigest }),
    });
    if (response.status !== 200) throw new Error(await problemCode(response, 'snapshot_conflict_confirm_invalid'));
    const body = await readBoundedJson(response, input.maxBytes, 'snapshot_conflict_confirm_invalid',
      input.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: input.timeoutMilliseconds });
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body as { readonly confirmed?: unknown }).confirmed !== true) {
      throw new SyncFailureError('snapshot_conflict_confirm_invalid');
    }
  }
  return { conflictCount, conflictDigest };
}

export function snapshotOpenConflictDetails(snapshotId: string, conflict: SnapshotOpenConflict): JsonObject {
  return { snapshotId, conflict: { ...conflict, allowedResolutions: [...conflict.allowedResolutions] } };
}

function conflictHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return { ...headers, Accept: 'application/json', 'Known-Sync-Conflict-Recovery': '1' };
}

function parsePage(value: unknown, snapshotId: string, offset: number): {
  readonly conflictCount: number; readonly conflicts: readonly SnapshotOpenConflict[]; readonly nextOffset: number | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncFailureError('snapshot_conflict_page_invalid');
  const page = value as Record<string, unknown>;
  if (page.snapshotId !== snapshotId || page.offset !== offset || !Array.isArray(page.conflicts)
      || typeof page.conflictCount !== 'number' || !Number.isSafeInteger(page.conflictCount) || page.conflictCount < 0) {
    throw new SyncFailureError('snapshot_conflict_page_invalid');
  }
  const nextOffset = page.nextOffset === null ? null : page.nextOffset;
  if (nextOffset !== null && (typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset))) {
    throw new SyncFailureError('snapshot_conflict_page_invalid');
  }
  return { conflictCount: page.conflictCount, conflicts: page.conflicts.map(parseConflict), nextOffset };
}

function parseConflict(value: unknown): SnapshotOpenConflict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncFailureError('snapshot_conflict_page_invalid');
  const conflict = value as Record<string, unknown>;
  if (Object.keys(conflict).some((key) => PRIVATE_KEYS.has(key) || ![
    'id', 'collectionId', 'targetId', 'type', 'field', 'incomingOpId', 'createdAt', 'status',
    'allowedResolutions', 'revision',
  ].includes(key))) throw new SyncFailureError('snapshot_conflict_page_invalid');
  if (typeof conflict.id !== 'string' || typeof conflict.collectionId !== 'string'
      || typeof conflict.targetId !== 'string' || typeof conflict.type !== 'string'
      || typeof conflict.createdAt !== 'string' || conflict.status !== 'open'
      || typeof conflict.revision !== 'string' || !Array.isArray(conflict.allowedResolutions)
      || conflict.allowedResolutions.length < 1
      || conflict.allowedResolutions.some((item) => typeof item !== 'string')) {
    throw new SyncFailureError('snapshot_conflict_page_invalid');
  }
  return {
    id: conflict.id, collectionId: conflict.collectionId, targetId: conflict.targetId, type: conflict.type,
    ...(typeof conflict.field === 'string' ? { field: conflict.field } : {}),
    ...(typeof conflict.incomingOpId === 'string' ? { incomingOpId: conflict.incomingOpId } : {}),
    createdAt: conflict.createdAt, status: 'open',
    allowedResolutions: conflict.allowedResolutions as string[], revision: conflict.revision,
  };
}

async function problemCode(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { readonly code?: unknown };
    return typeof body.code === 'string' ? body.code : fallback;
  } catch {
    return fallback;
  }
}
