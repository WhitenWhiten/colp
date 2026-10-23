import type { Problem, SubtreeObservationSummary, SyncPushResult } from '@know-n/colp/types';
import type { JsonObject } from './sync-state-store.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const TERMINAL = new Set(['applied', 'rebased', 'noop', 'conflicted', 'rejected']);
const ALL_STATUSES = new Set([...TERMINAL, 'deferred']);

export interface ParsedPushResult {
  readonly document: SyncPushResult & JsonObject;
  readonly result: SyncPushResult['results'][number] & JsonObject;
  readonly terminal: boolean;
}

export function parseSyncPushResult(value: unknown, binding: { readonly opId: string; readonly sequence: number }): ParsedPushResult {
  const document = responseRecord(value, ['batchId', 'results', 'serverCursor'], 'push_result');
  opaque(document.batchId, 'batchId'); opaque(document.serverCursor, 'serverCursor');
  if (!Array.isArray(document.results) || document.results.length !== 1) {
    throw new Error('push_response_invalid');
  }
  const result = responseRecord(document.results[0], ['opId', 'sequence', 'status', 'targetId', 'revision', 'cursor',
    'conflictId', 'boundCollection', 'transform', 'code', 'retryAfterSeconds', 'warnings'], 'operation_result',
  ['targetId', 'revision', 'cursor', 'conflictId', 'boundCollection', 'transform', 'code', 'retryAfterSeconds']);
  opaque(result.opId, 'opId'); if (result.opId !== binding.opId || result.sequence !== binding.sequence
      || !Number.isSafeInteger(result.sequence) || Number(result.sequence) < 1 || !ALL_STATUSES.has(String(result.status))
      || !Array.isArray(result.warnings) || result.warnings.length > 1_000) throw new Error('push_response_invalid');
  result.warnings = result.warnings.map(validateWarning);
  for (const field of ['targetId', 'revision', 'cursor', 'conflictId'] as const) {
    if (result[field] !== undefined) opaque(result[field], field);
  }
  const status = String(result.status);
  if (result.boundCollection !== undefined) throw new Error('push_response_invalid');
  if (result.transform !== undefined && (!result.transform || typeof result.transform !== 'object'
      || Array.isArray(result.transform))) throw new Error('push_response_invalid');
  if ((status === 'applied' || status === 'rebased') && (result.revision === undefined || result.cursor === undefined)) {
    throw new Error('push_response_invalid');
  }
  if (status === 'conflicted' && (result.cursor === undefined || result.conflictId === undefined)) {
    throw new Error('push_response_invalid');
  }
  if ((status === 'rejected' || status === 'deferred') && (typeof result.code !== 'string' || result.code.length === 0)) {
    throw new Error('push_response_invalid');
  }
  if (status !== 'deferred' && result.retryAfterSeconds !== undefined) throw new Error('push_response_invalid');
  if (result.retryAfterSeconds !== undefined
      && (!Number.isSafeInteger(result.retryAfterSeconds) || Number(result.retryAfterSeconds) < 0)) {
    throw new Error('push_response_invalid');
  }
  if (status === 'noop' && (result.cursor !== undefined || result.conflictId !== undefined || result.transform !== undefined)) {
    throw new Error('push_response_invalid');
  }
  if (status === 'applied' && result.conflictId !== undefined) throw new Error('push_response_invalid');
  if (status === 'rebased' && result.conflictId !== undefined) throw new Error('push_response_invalid');
  if (status === 'conflicted' && (result.revision !== undefined || result.transform !== undefined)) {
    throw new Error('push_response_invalid');
  }
  if (status !== 'rejected' && status !== 'deferred' && result.code !== undefined) throw new Error('push_response_invalid');
  if ((status === 'rejected' || status === 'deferred')
      && [result.revision, result.cursor, result.conflictId, result.transform].some((item) => item !== undefined)) {
    throw new Error('push_response_invalid');
  }
  document.results = [result];
  return { document: document as unknown as SyncPushResult & JsonObject,
    result: result as unknown as SyncPushResult['results'][number] & JsonObject, terminal: TERMINAL.has(status) };
}

/** The Problem fields Push recovery reads. The code stays an open string: a newer server's code still parses. */
export type ParsedColpProblem = Readonly<Pick<Problem, 'status' | 'expectedSequence' | 'retryAfterSeconds' | 'retryable'
  | 'conflictId' | 'currentRevision' | 'currentSubtree'>> & { readonly code: string };
const SUBTREE_DIGEST = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
export function parseColpProblem(value: unknown): ParsedColpProblem {
  const problem = responseRecord(value, ['type', 'title', 'status', 'detail', 'instance', 'code', 'expectedSequence',
    'currentRevision', 'currentEtag', 'currentSubtree', 'supportedVersions', 'retryAfterSeconds', 'snapshotUrl', 'conflictId',
    'retryable', 'errors', 'links'], 'problem', ['detail', 'instance', 'expectedSequence', 'currentRevision',
    'currentEtag', 'currentSubtree', 'supportedVersions', 'retryAfterSeconds', 'snapshotUrl', 'conflictId', 'retryable', 'errors', 'links']);
  if (typeof problem.type !== 'string' || typeof problem.title !== 'string' || typeof problem.code !== 'string'
      || !Number.isSafeInteger(problem.status)) throw new Error('push_problem_invalid');
  if (problem.retryable !== undefined && typeof problem.retryable !== 'boolean') throw new Error('push_problem_invalid');
  if (problem.retryAfterSeconds !== undefined
      && (!Number.isSafeInteger(problem.retryAfterSeconds) || Number(problem.retryAfterSeconds) < 0)) {
    throw new Error('push_problem_invalid');
  }
  if ((problem.code === 'sequence_gap' || problem.code === 'sequence_blocked')
      && problem.expectedSequence === undefined) throw new Error('push_problem_invalid');
  const currentRevision = typeof problem.currentRevision === 'string' && OPAQUE_ID.test(problem.currentRevision)
    ? problem.currentRevision : undefined;
  return { code: problem.code, status: Number(problem.status),
    ...(problem.expectedSequence === undefined ? {} : { expectedSequence: positiveInteger(problem.expectedSequence) }),
    ...(problem.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Number(problem.retryAfterSeconds) }),
    ...(problem.retryable === undefined ? {} : { retryable: problem.retryable as boolean }),
    ...(typeof problem.conflictId === 'string' ? { conflictId: problem.conflictId } : {}),
    ...(currentRevision === undefined ? {} : { currentRevision }),
    ...(problem.currentSubtree === undefined ? {} : { currentSubtree: parseSubtreeSummary(problem.currentSubtree) }) };
}

function parseSubtreeSummary(value: unknown): SubtreeObservationSummary {
  const summary = responseRecord(value, ['version', 'count', 'digest', 'memberIdsDigest'], 'push_problem');
  if (summary.version !== 1 || !Number.isSafeInteger(summary.count) || Number(summary.count) < 1
      || typeof summary.digest !== 'string' || !SUBTREE_DIGEST.test(summary.digest)
      || typeof summary.memberIdsDigest !== 'string' || !SUBTREE_DIGEST.test(summary.memberIdsDigest)) {
    throw new Error('push_problem_invalid');
  }
  return { version: 1, count: Number(summary.count), digest: summary.digest, memberIdsDigest: summary.memberIdsDigest };
}

function responseRecord(value: unknown, allowed: readonly string[], label: string, optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_invalid`);
  const record = value as Record<string, unknown>;
  if (allowed.some((key) => !optional.includes(key) && !Object.hasOwn(record, key))) throw new Error(`${label}_invalid`);
  // Optional response extensions must not change receipt bytes or enter local storage.
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
}
function opaque(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw new Error(`${label}_invalid`);
}
function positiveInteger(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1) {
  throw new Error('positive_integer_invalid'); } return Number(value); }
function validateWarning(value: unknown) { const warning = responseRecord(value, ['code', 'message', 'nodeId', 'path', 'lossy'],
  'warning', ['nodeId', 'path', 'lossy']);
  if (typeof warning.code !== 'string' || typeof warning.message !== 'string'
      || (warning.nodeId !== undefined && (typeof warning.nodeId !== 'string' || !OPAQUE_ID.test(warning.nodeId)))
      || (warning.path !== undefined && typeof warning.path !== 'string')
      || (warning.lossy !== undefined && typeof warning.lossy !== 'boolean')) throw new Error('warning_invalid');
  return warning;
}
