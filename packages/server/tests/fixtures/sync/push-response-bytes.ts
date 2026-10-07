/**
 * SR-17 / A-16 shared fixture: backend-real Push response bytes → plugin parser.
 *
 * Before this module the repository had exactly one place where a live backend
 * Push response body was handed to the extension's `parseSyncPushResult`
 * (`tests/integration/sync/sync-sequence-cross-session-postgres.integration.test.ts`).
 * This module generalises that pattern for the three Push outcomes the extension
 * outbound worker must classify — `rejected`, `conflicted`, `sequence_gap` — and
 * is driven only by *real* response bytes:
 *
 *   const captured = await pushAndCapture(...);            // live Fastify + PostgreSQL
 *   const parsed = parseSyncPushResponseBytes('conflicted', captured, { opId, sequence });
 *
 * No wire shape is invented here. Every status, media type, key set and code
 * literal below is copied from the producer named in `producedBy`, and
 * `tests/integration/sync/sync-push-response-parser-fixture-postgres.integration.test.ts`
 * asserts a live response (status + `content-type` + body) against that shape
 * *before* the same bytes reach the plugin parser, so the fixture cannot drift
 * away from what the backend really emits.
 */
import assert from 'node:assert/strict';
import { createPublicationProblemDescriptor } from '@know-n/colp/server';
import type { Problem, SyncPushResult } from '@know-n/colp/types';
import {
  parseColpProblem,
  parseSyncPushResult,
  type ParsedPushResult,
} from '../../../../Known-Extension/src/sync-push-wire.js';

/** 200 Push result media type (`src/transport/colp-sync/sync-push-routes.ts:182-183`). */
export const PUSH_RESULT_MEDIA_TYPE = 'application/json';
/** `PUBLICATION_PROBLEM_CONTENT_TYPE` (`colp/src/server/publication-problems.ts:9`). */
export const PUSH_PROBLEM_MEDIA_TYPE = 'application/problem+json';
/**
 * Fastify appends `; charset=utf-8` to any JSON media type without an explicit
 * charset (`Known-Backend/node_modules/fastify/lib/reply.js:229`), which is why
 * the live 409 header is longer than the descriptor's bare media type.
 */
export const PUSH_RESULT_CONTENT_TYPE = `${PUSH_RESULT_MEDIA_TYPE}; charset=utf-8`;
export const PUSH_PROBLEM_CONTENT_TYPE = `${PUSH_PROBLEM_MEDIA_TYPE}; charset=utf-8`;

/** COLP core Problem type base (`colp/src/server/publication-problems.ts:11,78`). */
export const PROBLEM_TYPE_BASE = 'https://know-n.com/colp/problems/';

/**
 * Anchored `content-type` pattern for a media type with optional `charset=utf-8`.
 *
 * Every regex metacharacter is escaped: `application/problem+json` must be matched
 * literally, because an unescaped `+` means "one or more `m`" and therefore never
 * matches the real `application/problem+json; charset=utf-8` header.
 */
export function mediaTypePattern(mediaType: string): RegExp {
  return new RegExp(`^${mediaType.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s*;\\s*charset=utf-8)?$`, 'iu');
}

export type PushResponseScenario = 'rejected' | 'conflicted' | 'sequence_gap';

export interface PushResultShape {
  readonly scenario: 'rejected' | 'conflicted';
  readonly kind: 'push_result';
  readonly status: 200;
  readonly mediaType: typeof PUSH_RESULT_MEDIA_TYPE;
  /** Exact key set of the serialized `SyncPushResult` document. */
  readonly documentKeys: readonly string[];
  /** Exact key set of `results[0]`, whose length is always 1. */
  readonly resultKeys: readonly string[];
  readonly resultStatus: 'rejected' | 'conflicted';
  /** Present only for `rejected`: `deferred`/`rejected` results carry a code; others must not. */
  readonly resultCode?: string;
  /** `'sync-unchanged'` literal, or `'result-cursor'` when `serverCursor === results[0].cursor`. */
  readonly serverCursor: 'sync-unchanged' | 'result-cursor';
  readonly producedBy: string;
}

export interface PushProblemShape {
  readonly scenario: 'sequence_gap';
  readonly kind: 'problem';
  readonly status: 409;
  readonly mediaType: typeof PUSH_PROBLEM_MEDIA_TYPE;
  readonly problemKeys: readonly string[];
  readonly code: string;
  readonly title: string;
  readonly type: string;
  readonly retryable: boolean;
  readonly producedBy: string;
}

export type PushResponseShape = PushResultShape | PushProblemShape;

/**
 * The only in-band terminal rejection this backend emits.
 *
 * Producer: `src/infrastructure/sync/postgres/sync-push-repository-postgres.ts:70-83`
 * (`terminalNodeIdRejection`) reached from
 * `src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts:104` when the
 * `resource_id_ledger` reservation for the client-supplied Node id conflicts with an
 * existing row. `resource_id_unavailable` is a *result* code, not a registered COLP
 * Problem code, so it can only arrive inside a 200 `SyncPushResult` — which is exactly
 * why the plugin parses it with `parseSyncPushResult`.
 *
 * `invalid_document` / `resource_not_found` are the other semantic refusals, but the
 * backend emits those as `application/problem+json` denials (no `results` array), not as
 * a `rejected` operation result; see `PUSH_PROBLEM_MEDIA_TYPE` handling below.
 */
export const REJECTED_PUSH_RESPONSE: PushResultShape = Object.freeze({
  scenario: 'rejected',
  kind: 'push_result',
  status: 200,
  mediaType: PUSH_RESULT_MEDIA_TYPE,
  documentKeys: ['batchId', 'results', 'serverCursor'],
  resultKeys: ['code', 'opId', 'sequence', 'status', 'warnings'],
  resultStatus: 'rejected',
  resultCode: 'resource_id_unavailable',
  serverCursor: 'sync-unchanged',
  producedBy: 'src/infrastructure/sync/postgres/sync-push-repository-postgres.ts:70-83',
});

/**
 * Persisted open Conflict delivered in-band on a 200 Push result.
 *
 * Producer: `src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts:262-278`
 * after `appendOpenSyncConflict` persists the Conflict row; the same `cursor` becomes
 * `serverCursor`. `sync-push-routes.ts` never emits `revision_conflict` with a
 * `conflictId` for Push (`SyncPushHttpError` carries only code/retryAfterSeconds/
 * expectedSequence), so the worker's `conflicted` branch — not its
 * `revision_conflict` problem branch — is the reachable one.
 */
export const CONFLICTED_PUSH_RESPONSE: PushResultShape = Object.freeze({
  scenario: 'conflicted',
  kind: 'push_result',
  status: 200,
  mediaType: PUSH_RESULT_MEDIA_TYPE,
  documentKeys: ['batchId', 'results', 'serverCursor'],
  resultKeys: ['conflictId', 'cursor', 'opId', 'sequence', 'status', 'targetId', 'warnings'],
  resultStatus: 'conflicted',
  serverCursor: 'result-cursor',
  producedBy: 'src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts:262-278',
});

/**
 * Sequence continuity refusal for a Push whose `sequence` is ahead of the lane.
 *
 * Producer: `colp/src/sync/sequence.ts:391-395` (`kind: 'sequence_gap'`) →
 * `src/infrastructure/sync/postgres/sync-push-admission-postgres.ts:99`
 * (`SyncPushHttpError('sequence_gap', undefined, expectedSequence)`) →
 * `src/transport/colp-sync/sync-push-routes.ts:284-297` (`sendProblem` →
 * `createPublicationProblemDescriptor`). The document therefore carries the registry
 * `status`/`retryable` plus the `expectedSequence` recovery field, and the plugin
 * reads it with `parseColpProblem` in its Problem branch).
 */
export const SEQUENCE_GAP_PUSH_RESPONSE: PushProblemShape = Object.freeze({
  scenario: 'sequence_gap',
  kind: 'problem',
  status: 409,
  mediaType: PUSH_PROBLEM_MEDIA_TYPE,
  problemKeys: ['code', 'expectedSequence', 'retryable', 'status', 'title', 'type'],
  code: 'sequence_gap',
  title: 'sequence_gap',
  type: `${PROBLEM_TYPE_BASE}sequence-gap`,
  retryable: true,
  producedBy: 'colp/src/sync/sequence.ts:391-395 → sync-push-admission-postgres.ts:99 → sync-push-routes.ts:284-297',
});

export function pushResponseShape(scenario: PushResponseScenario): PushResponseShape {
  switch (scenario) {
    case 'rejected': return REJECTED_PUSH_RESPONSE;
    case 'conflicted': return CONFLICTED_PUSH_RESPONSE;
    case 'sequence_gap': return SEQUENCE_GAP_PUSH_RESPONSE;
  }
}

/** `parseSyncPushResult` binding plus the request facts the response must echo. */
export interface PushRequestIdentity {
  readonly opId: string;
  readonly sequence: number;
  /** Optional: when present the response `targetId` must echo it. */
  readonly targetId?: string;
}

/** A real HTTP response: `status` and `content-type` as received, body as bytes or object. */
export interface RealPushResponse {
  readonly status: number;
  readonly contentType: string;
  /** Raw response text (`await response.text()`), or the already-parsed document. */
  readonly body: string | Record<string, unknown>;
}

export interface ParsedRealPushResponse {
  readonly scenario: PushResponseScenario;
  readonly status: number;
  readonly mediaType: string;
  /** Exact bytes when `body` was passed as a string, otherwise a re-serialization. */
  readonly rawBody: string;
  readonly document: Record<string, unknown>;
  /** Present for 200 `SyncPushResult` bodies: the plugin's `parseSyncPushResult` view. */
  readonly pushResult?: ParsedPushResult;
  /** Present for `application/problem+json` bodies: the plugin's `parseColpProblem` view. */
  readonly problem?: ReturnType<typeof parseColpProblem>;
}

export interface PushResponseExpectations {
  /** Required when the response must prove the lane's next Sequence. */
  readonly expectedSequence?: number;
}

/**
 * Canonical bytes of the `sequence_gap` Problem, built with the very function the
 * route uses (`createPublicationProblemDescriptor`), so the live 409 body can be
 * compared field-for-field instead of against a hand-copied literal.
 */
export function sequenceGapProblemResponse(expectedSequence = 1): RealPushResponse {
  const descriptor = createPublicationProblemDescriptor({
    code: 'sequence_gap',
    recovery: { expectedSequence },
  });
  return Object.freeze({
    status: descriptor.status,
    contentType: PUSH_PROBLEM_CONTENT_TYPE,
    body: JSON.stringify(descriptor.problem),
  });
}

/**
 * Feeds real backend response bytes to the plugin parser the same way
 * `Known-Extension/src/outbound-push-worker.ts` does, asserts the HTTP layer
 * (status + `content-type`), asserts the scenario semantics the acceptance
 * criteria name (`terminal`, `result.status`, `conflictId`, `expectedSequence`),
 * and returns the parsed view.
 *
 * Throws when the live response does not match `scenario`.
 */
export function parseSyncPushResponseBytes(
  scenario: PushResponseScenario,
  response: RealPushResponse,
  identity: PushRequestIdentity,
  expectations: PushResponseExpectations = {},
): ParsedRealPushResponse {
  const shape = pushResponseShape(scenario);
  const { document, rawBody } = readBody(response, scenario);
  assert.equal(response.status, shape.status,
    `${scenario}: live push response status must be ${shape.status}`);
  const mediaType = assertMediaType(response.contentType, shape.mediaType, scenario);
  // Dispatch exactly like the worker: 200 + `application/json` → Push result,
  // problem media type → Problem. Selecting the shape through the scenario
  // literal keeps both branches typed without casting.
  if (scenario === 'sequence_gap') {
    return parseProblemBody(SEQUENCE_GAP_PUSH_RESPONSE, scenario, { document, rawBody, mediaType }, expectations);
  }
  return parsePushResultBody(
    scenario === 'rejected' ? REJECTED_PUSH_RESPONSE : CONFLICTED_PUSH_RESPONSE,
    scenario, { document, rawBody, mediaType }, identity,
  );
}

function parsePushResultBody(
  shape: PushResultShape,
  scenario: 'rejected' | 'conflicted',
  body: { document: Record<string, unknown>; rawBody: string; mediaType: string },
  identity: PushRequestIdentity,
): ParsedRealPushResponse {
  assert.deepEqual(Object.keys(body.document).sort(), [...shape.documentKeys].sort(),
    `${scenario}: SyncPushResult document keys must match the backend shape`);
  const results = body.document.results;
  assert.ok(Array.isArray(results) && results.length === 1,
    `${scenario}: a Push result document carries exactly one operation result`);
  const result = asRecord(results[0], `${scenario}: results[0]`);
  assert.deepEqual(Object.keys(result).sort(), [...shape.resultKeys].sort(),
    `${scenario}: results[0] keys must match the backend shape`);

  // The plugin's only 200-response entry point (the worker's `parseSyncPushResult` branch).
  const parsed = parseSyncPushResult(body.document, { opId: identity.opId, sequence: identity.sequence });
  assert.equal(parsed.terminal, true, `${scenario}: a ${shape.resultStatus} result is terminal`);
  assert.equal(parsed.result.status, shape.resultStatus,
    `${scenario}: results[0].status must stay ${shape.resultStatus}`);
  assert.equal(parsed.result.code, shape.resultCode,
    `${scenario}: results[0].code must stay ${String(shape.resultCode)}`);
  if (identity.targetId !== undefined) {
    assert.equal(parsed.result.targetId, identity.targetId, `${scenario}: targetId must echo the request`);
  }
  if (shape.serverCursor === 'sync-unchanged') {
    assert.equal(body.document.serverCursor, 'sync-unchanged',
      `${scenario}: a rejected row cannot advance the server cursor`);
  } else {
    assert.equal(body.document.serverCursor, parsed.result.cursor,
      `${scenario}: serverCursor must equal the Conflict cursor`);
    assert.equal(typeof parsed.result.conflictId, 'string',
      `${scenario}: a conflicted result must expose conflictId`);
    assert.ok((parsed.result.conflictId as string).length > 0, `${scenario}: conflictId must not be empty`);
    assert.equal(parsed.result.revision, undefined, `${scenario}: a conflicted result carries no revision`);
  }
  assert.deepEqual(parsed.result.warnings, [], `${scenario}: the backend reports no warnings here`);
  // A Problem body and a Push result body are disjoint: the worker must dispatch on
  // `content-type`, and neither parser may silently accept the other's document.
  assert.throws(() => parseColpProblem(body.document), /problem_invalid/u,
    `${scenario}: the Problem parser must reject a SyncPushResult body`);
  return Object.freeze({
    scenario,
    status: shape.status,
    mediaType: body.mediaType,
    rawBody: body.rawBody,
    document: body.document,
    pushResult: parsed,
  });
}

function parseProblemBody(
  shape: PushProblemShape,
  scenario: 'sequence_gap',
  body: { document: Record<string, unknown>; rawBody: string; mediaType: string },
  expectations: PushResponseExpectations,
): ParsedRealPushResponse {
  assert.deepEqual(Object.keys(body.document).sort(), [...shape.problemKeys].sort(),
    `${scenario}: Problem keys must match the backend shape`);
  assert.equal('results' in body.document, false, `${scenario}: a Problem carries no operation results`);

  // The plugin's denial entry point (the worker's `parseColpProblem` branch).
  const problem = parseColpProblem(body.document);
  assert.equal(problem.code, shape.code, `${scenario}: problem code must stay ${shape.code}`);
  assert.equal(problem.status, shape.status, `${scenario}: problem status must stay ${shape.status}`);
  assert.equal(body.document.title, shape.title, `${scenario}: problem title must stay ${shape.title}`);
  assert.equal(body.document.type, shape.type, `${scenario}: problem type must stay ${shape.type}`);
  assert.equal(problem.retryable, shape.retryable,
    `${scenario}: problem retryable must stay ${String(shape.retryable)}`);
  assert.ok(Number.isSafeInteger(problem.expectedSequence) && (problem.expectedSequence ?? 0) >= 1,
    `${scenario}: the lane must advertise the expected Sequence`);
  if (expectations.expectedSequence !== undefined) {
    assert.equal(problem.expectedSequence, expectations.expectedSequence,
      `${scenario}: expectedSequence must be the lane's next Sequence`);
  }
  assert.throws(() => parseSyncPushResult(body.document, { opId: 'unused', sequence: 1 }),
    /push_result_invalid/u, `${scenario}: the Push result parser must reject a Problem body`);
  return Object.freeze({
    scenario,
    status: shape.status,
    mediaType: body.mediaType,
    rawBody: body.rawBody,
    document: body.document,
    problem,
  });
}

function readBody(
  response: RealPushResponse,
  scenario: PushResponseScenario,
): { document: Record<string, unknown>; rawBody: string } {
  if (typeof response.body === 'string') {
    assert.ok(response.body.length > 0, `${scenario}: the captured response body must not be empty`);
    return { document: asRecord(JSON.parse(response.body), `${scenario}: response body`), rawBody: response.body };
  }
  return {
    document: asRecord(response.body, `${scenario}: response body`),
    rawBody: JSON.stringify(response.body),
  };
}

function assertMediaType(actual: string, expected: string, label: string): string {
  const separator = actual.indexOf(';');
  const mediaType = (separator === -1 ? actual : actual.slice(0, separator)).trim().toLowerCase();
  assert.equal(mediaType, expected, `${label}: expected content-type ${expected}, received ${actual}`);
  if (separator !== -1) {
    assert.match(actual.slice(separator), /^;\s*charset=utf-8$/iu,
      `${label}: only the utf-8 charset parameter is expected, received ${actual}`);
  }
  return mediaType;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Convenience re-exports so callers assert against the same parser the plugin ships. */
export { parseColpProblem, parseSyncPushResult };
export type { ParsedPushResult, Problem, SyncPushResult };
