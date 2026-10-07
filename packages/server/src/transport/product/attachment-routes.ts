/**
 * P4A-P01/P4A-P03/P4A-P04 production mount for the owner-private Attachment product
 * surface.
 *
 * Every operation in the frozen OpenAPI contract is registered on the real
 * production app composition with its exact route-manifest identity and
 * transport admission config (strict media types, body budget, no query
 * parameters, private no-store).
 *
 * P4A-P03 lands the `issue` and `complete` operations on top of the
 * production use cases (`issueUploadIntentWithAdmissionGate`,
 * `completeUpload`) when the app is composed with `attachmentRoutes` deps:
 *  - session auth (cookie), exact-Origin + CSRF, canonical Known-Command-Id
 *    (the idempotency binding -> use-case idempotencyKey);
 *  - cheap schema/auth/admission checks run BEFORE any expensive database or
 *    R2 work: the durable admission switch is read first, then the use case
 *    validates, authorizes against the transaction-bound access policy, and
 *    only AFTER the ledger commits does it sign the create-only grant;
 *  - the complete route NEVER accepts a physical key: it binds the original
 *    {intentId, generationId, blobId}, re-reads the authoritative ledger,
 *    attests the exact object, and converges idempotently; foreign, absent,
 *    and wrong-principal bindings are concealed as the stable 404;
 *  - stable Problem mapping: 413 payload_too_large (declared size), 422
 *    invalid_document (shape/validation), 409 attachment_state_conflict /
 *    attachment_idempotency_conflict, 403 insufficient_permission, 404
 *    resource_not_found concealment, 503 rate_limit_unavailable for every
 *    transient server-side unavailability (admission stopped, provider
 *    retryable/unknown, signing failure). 503 NEVER carries Retry-After (not
 *    a quota fact). The RL port itself is RL04's task; this file only owns
 *    the stable contract slot.
 *
 * Until the owning tasks land (P04/P06/P07), the remaining operations keep
 * returning the explicit closed state `503 attachments_not_implemented`;
 * P4A-P08 opens the download admission. Framework-level transport rejections
 * (415 media type, 413 body budget, 400 malformed JSON/query) still apply
 * through the shared product admission layer and are emitted in the
 * Attachment envelope by the app error handler.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import {
  ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  RATE_LIMIT_SUBJECT_CONTROL_CHARACTER_PATTERN,
  RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH,
  CompleteUploadInputError,
  CompleteUploadProviderError,
  FinalizeAttachmentInputError,
  UploadIntentAuthorizationError,
  UploadIntentExpiredError,
  UploadIntentIdentityError,
  UploadIntentInputError,
  UploadIntentSigningError,
  RetireAttachmentInputError,
  formatRateLimitPolicyHeader,
  mapRateLimitAdmissionToHttp,
  resolveRouteRatePolicy,
  type AttachmentRateLimitRouteClass,
  type AttachmentRouteRateLimitFacade,
  type AuthorizeOwnerDownloadInput,
  type AuthorizeOwnerDownloadResult,
  type CompleteUploadInput,
  type CompleteUploadResult,
  type IssueReplacementIntentInput,
  type IssueUploadIntentInput,
  type IssueUploadIntentResult,
  type ProductFinalizeInput,
  type ProductFinalizeResult,
  type ProductReplacementResult,
  type ProductRetireInput,
  type ProductRetireResult,
  type RateLimitSubject,
  type ReadAttachmentStatusInput,
  type ReadAttachmentStatusResult,
} from '../../modules/attachments/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  AttachmentHttpError,
  attachmentErrorStatus,
  attachmentNotImplemented,
  type AttachmentFieldError,
} from './attachment-error.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { optionalSessionActor, requireSessionActor } from '../session-auth.js';
import { requireMutationActor as requireProductMutationActor } from '../mutation-actor.js';

const ISSUE = '/api/v1/attachments/issue';
const COMPLETE = '/api/v1/attachments/complete';
const STATUS = '/api/v1/attachments/:blobId';
const FINALIZE = '/api/v1/attachments/:blobId/finalize';
const REPLACEMENT = '/api/v1/attachments/:blobId/replacement';
const RETIRE = '/api/v1/attachments/:blobId/retire';
const DOWNLOAD = '/api/v1/attachments/:blobId/download';

/** Private transport profile shared by every Attachment operation. */
const ATTACHMENT_TRANSPORT = {
  allowedQuery: [],
  queryErrorCode: 'invalid_request',
  duplicateQueryErrorCode: 'invalid_request',
  cacheControl: 'private-no-store',
  bodyLimitBytes: 16_384,
} as const;

/**
 * P4A-P03 production issue/complete composition. The app passes these deps
 * through unchanged; when absent every Attachment route stays closed (the
 * P01 skeleton contract). The closures are the composed production use cases
 * (issue behind the durable admission gate, complete with the ledger/object
 * store/Outbox wiring); the route owns only the HTTP wiring and the stable
 * Problem mapping.
 */
export interface AttachmentRoutesDependencies {
  /** App config: exact allowed Origins for the CSRF/Origin gate. */
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly attachments: AttachmentRoutesPorts;
}

export interface AttachmentRoutesPorts {
  /**
   * Production issue use case composed behind the durable admission switch:
   * cheap validation -> membership authorization -> durable ledger commit ->
   * grant signing (grant never precedes the ledger).
   */
  readonly issue: (input: IssueUploadIntentInput) => Promise<
    | { readonly outcome: 'admission_stopped' }
    | { readonly outcome: 'issued'; readonly result: IssueUploadIntentResult }
  >;
  /**
   * Production complete use case (ledger re-read -> provider HEAD attestation
   * -> CAS + verification Outbox in one commit). Never accepts a physical key.
   */
  readonly complete: (input: CompleteUploadInput) => Promise<CompleteUploadResult>;
  /**
   * Production owner-private status read (P4A-P04): resolves the current
   * blob/generation/intent facts and authorizes from PostgreSQL on EVERY
   * read. Every non-owner/foreign/absent/terminal identity is concealed as
   * `not_found`; anonymous requests never touch the database. FIX-L-051:
   * the route admission-limits the AUTHENTICATED principal (stable
   * per-principal `status` budget, KA-P4-AM-16) BEFORE this port is
   * invoked, so exhausted/failed admissions create zero repository work.
   */
  readonly status: (input: ReadAttachmentStatusInput) => Promise<ReadAttachmentStatusResult>;
  /**
   * Production finalize (P4A-P06): the canonical mutation in ONE transaction
   * (Collection lock + authorization + resource IDs + Attachment metadata +
   * blob handoff + Operation/Audit/Outbox + idempotency receipt). The
   * Known-Command-Id is the receipt binding; the route never receives a
   * physical key, generation id or verified fact.
   */
  readonly finalize: (input: ProductFinalizeInput) => Promise<ProductFinalizeResult>;
  /**
   * Production replacement intent (P4A-P07): issues a NEW generation intent
   * for an existing owner-private blob — always a NEW physical key, never a
   * same-key overwrite; the CAS activation of the completed replacement
   * generation is composed into `complete`. Idempotent via Known-Command-Id.
   */
  readonly replacement: (input: IssueReplacementIntentInput) => Promise<ProductReplacementResult>;
  /**
   * Production retire (P4A-P07): the canonical retirement in ONE transaction
   * (Attachment metadata -> retired + generation -> retired + pointer clear
   * + Operation/Audit/Outbox + idempotency receipt). The Known-Command-Id is
   * the receipt binding; the route never receives a physical key or
   * generation id.
   */
  readonly retire: (input: ProductRetireInput) => Promise<ProductRetireResult>;
  /**
   * Production owner download admission (P4A-P08): resolves the CURRENT
   * owner, logical state, generation state and binding from PostgreSQL on
   * EVERY admission (no cached authorization) and issues the short-lived,
   * audience-bound capability for the isolated delivery origin. The route
   * never receives a physical key; the capability token is the only body
   * exit. Anonymous requests are denied by the session gate (401) before any
   * database work; every other non-owner/foreign/revoked identity is
   * concealed as the stable 404.
   */
  readonly download?: (input: AuthorizeOwnerDownloadInput) => Promise<AuthorizeOwnerDownloadResult>;
  /**
   * P4A-RL04 distributed admission limiter facade. When composed, the issue/
   * complete/download/status handlers check it AFTER authentication + cheap
   * body validation and BEFORE any database/R2 work; exhausted (429) and
   * unavailable (503) requests therefore create zero ledger/R2 side effects.
   * `off` mode preserves the bounded local reference behavior (I10 for
   * download), `shadow` runs Redis alongside without denying, `enforce` lets
   * Redis decide with the complete emergency fallback (plan §2.2.4). When
   * absent the routes keep the pre-RL04 behavior unchanged.
   */
  readonly rateLimit?: AttachmentRouteRateLimitFacade;
}

// ---------------------------------------------------------------------------
// Status handler (owner-private read; no Origin/CSRF/command-id surface)
// ---------------------------------------------------------------------------

/**
 * P4A-P04: the owner-private status/metadata read. The session is OPTIONAL on
 * purpose: an anonymous request receives the same concealed 404 as every
 * other non-owner with zero database work (uniform external Problem, no
 * existence side channel). The response carries exactly the frozen
 * AttachmentStatusDto — no digest, key, URL, credential, filename, generation
 * or lease facts. 404 concealment for foreign/absent/terminal identities uses
 * the same stable body/header as every other Attachment 404.
 *
 * FIX-L-051 (KA-P4-AM-16): an AUTHENTICATED principal is admission-limited
 * on the stable per-principal `status` budget BEFORE any repository work
 * (the blobId NEVER enters the admission subject, so polling many blobIds
 * shares ONE budget — a rotatable blobId can never mint a fresh bucket).
 * The exhausted request is the same frozen 429 with the real Retry-After +
 * RateLimit-Policy quota facts as every other Attachment route; a failed
 * admission store fails closed (503 rate_limit_unavailable, no quota
 * headers). The ANONYMOUS path keeps the cheap concealed 404 (zero database
 * work) and never consumes or consults the authenticated budget.
 */
async function handleStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const session = await optionalSessionActor(request, deps.identityUnitOfWork);
  const actor = session === null
    ? null
    : { principalId: session.account.id, subjectId: session.account.subjectId, kind: 'account' as const };
  // FIX-L-051: the authenticated admission gate runs BEFORE the repository
  // (exhausted/unavailable -> zero database work). The subject is the stable
  // principal with the fixed route scope; the client blobId must never enter
  // the rate-limit subject (KA-P4-AM-16: rotating blobIds would mint fresh
  // per-principal buckets).
  if (actor !== null) {
    const limited = await checkRouteRateLimit(deps, 'status', {
      principalId: actor.principalId,
      scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
    });
    if (limited !== null) throw limited;
  }
  const blobId = (request.params as { blobId?: string }).blobId ?? '';
  const result = await deps.attachments.status({ actor, blobId }).catch((error) => {
    throw mapStatusError(error);
  });
  if (result.outcome === 'not_found') {
    throw concealedNotFound();
  }
  const view = result.view;
  return reply.code(200).type('application/json; charset=utf-8').send({
    blobId: view.blobId,
    logicalState: view.logicalState,
    verificationStatus: view.verificationStatus,
    availability: view.availability,
    size: view.size,
    mediaType: view.mediaType,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    allowedActions: view.allowedActions,
  });
}

function mapStatusError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  // A status read has no client-input error classes; any failure is a
  // server-side internal error in the stable Attachment envelope.
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('internal_error'),
    code: 'internal_error',
    message: 'The Attachment status could not be read.',
    recovery: 'none',
  });
}

// ---------------------------------------------------------------------------
// Download admission handler (owner-private; session + Origin + CSRF gate)
// ---------------------------------------------------------------------------

/**
 * P4A-P08: admit one owner-private download. The session + Origin + CSRF gate
 * runs first (anonymous -> 401, zero database work); the production use case
 * then re-reads the CURRENT owner/generation/binding from PostgreSQL on
 * EVERY admission and signs the short-lived audience-bound capability for
 * the isolated delivery origin. The frozen contract has NO request body: an
 * empty body/object is accepted, anything else is the stable 422
 * invalid_document before any database work. Stable Problem mapping:
 * 200 with the frozen AttachmentDownloadAdmission (downloadUrl is a secret,
 * non-loggable field), 404 resource_not_found concealment for every
 * foreign/absent/revoked/terminal identity, 429 rate_limited with the real
 * Retry-After quota fact, 503 rate_limit_unavailable (NO Retry-After) for
 * retryable server-side unavailability. The capability audience is the
 * configured isolated delivery origin, so the token can never be consumed on
 * the Known application origin.
 */
async function handleDownload(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  if (deps.attachments.download === undefined) throw attachmentNotImplemented();
  const actor = await requireMutationActor(request, deps);
  if (request.body !== undefined && request.body !== null) {
    if (!isRecord(request.body) || Object.keys(request.body).length > 0) {
      throw invalidDocument('The Attachment download request must not carry a body.', []);
    }
  }
  // P4A-RL04: distributed admission BEFORE the current-owner/generation
  // re-read (exhausted/unavailable -> zero database work). The Collection
  // scope is a database fact resolved inside the use case, so the
  // pre-database key uses the fixed route scope token (plan §2.3).
  const limited = await checkRouteRateLimit(deps, 'download', {
    principalId: actor.principalId,
    scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  });
  if (limited !== null) throw limited;
  const blobId = (request.params as { blobId?: string }).blobId ?? '';
  const result = await deps.attachments.download({ actor, blobId }).catch((error) => {
    throw mapDownloadError(error);
  });
  switch (result.outcome) {
    case 'granted': {
      const claims = result.capability.claims;
      return reply.code(200).type('application/json; charset=utf-8').send({
        kind: 'granted',
        blobId: result.blobId,
        generationId: result.generationId,
        method: 'GET',
        deliveryOrigin: claims.audience,
        downloadUrl: `${claims.audience}/d/${encodeURIComponent(result.capability.token)}`,
        issuedAt: new Date(result.issuedAtEpochMs).toISOString(),
        expiresAt: new Date(result.expiresAtEpochMs).toISOString(),
      });
    }
    case 'denied':
      // Concealment: identical stable Problem for foreign, absent, revoked,
      // and terminal identities (zero body variation, no redirect).
      throw concealedNotFound();
    case 'rate_limited': {
      // Pre-RL04 composition path (no route facade): the I10 local limiter
      // inside the use case denied. The frozen P01 contract emits BOTH the
      // real Retry-After quota fact and the fixed RateLimit-Policy; 503 never
      // carries either (not a quota fact).
      const policy = deps.config.attachmentsRateLimit.routes.download;
      throw new AttachmentHttpError({
        statusCode: attachmentErrorStatus('rate_limited'),
        code: 'rate_limited',
        message: 'Too many download admission attempts. Retry later.',
        recovery: 'refresh_and_retry',
        sameRequestRetrySafe: true,
        retryAfterSeconds: result.retryAfterSeconds,
        headers: {
          'Retry-After': String(result.retryAfterSeconds),
          'RateLimit-Policy': formatRateLimitPolicyHeader('download', policy.rateMax, policy.rateWindowMs),
        },
      });
    }
  }
}

function mapDownloadError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  // The download admission has no client-input error classes; a transient
  // server-side unavailability is the stable 503 rate_limit_unavailable
  // (no Retry-After: it is not a quota fact) and the identical request may
  // be retried safely.
  return attachmentUnavailable('The download could not be admitted right now. Retry the same request.');
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps?: AttachmentRoutesDependencies,
): void {
  app.post(ISSUE, {
    config: {
      ...productRouteMetadata('POST', ISSUE),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleIssue(request, reply, deps);
  });

  app.post(COMPLETE, {
    config: {
      ...productRouteMetadata('POST', COMPLETE),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleComplete(request, reply, deps);
  });

  app.get(STATUS, {
    config: {
      ...productRouteMetadata('GET', STATUS),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: [] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleStatus(request, reply, deps);
  });

  app.post(FINALIZE, {
    config: {
      ...productRouteMetadata('POST', FINALIZE),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleFinalize(request, reply, deps);
  });

  app.post(REPLACEMENT, {
    config: {
      ...productRouteMetadata('POST', REPLACEMENT),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleReplacement(request, reply, deps);
  });

  app.post(RETIRE, {
    config: {
      ...productRouteMetadata('POST', RETIRE),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleRetire(request, reply, deps);
  });

  app.post(DOWNLOAD, {
    config: {
      ...productRouteMetadata('POST', DOWNLOAD),
      productTransport: { ...ATTACHMENT_TRANSPORT, acceptedMediaTypes: ['application/json'] },
    },
  }, async (request, reply) => {
    if (!deps) throw attachmentNotImplemented();
    return handleDownload(request, reply, deps);
  });
}

// ---------------------------------------------------------------------------
// Finalize handler
// ---------------------------------------------------------------------------

/**
 * P4A-P06: finalize one owner-private Attachment through the production use
 * case. The session + Origin + CSRF + Known-Command-Id gate runs first (no
 * database work); the use case owns the canonical mutation transaction and
 * the idempotency receipt. Stable Problem mapping: 200 with the frozen
 * AttachmentFinalizeResult, 404 resource_not_found concealment for every
 * foreign/absent/revoked/terminal identity, 409 attachment_state_conflict
 * for inadmissible states and different bindings, 409
 * attachment_idempotency_conflict for a reused command id with a different
 * binding, 503 rate_limit_unavailable (no Retry-After) for every retryable
 * server-side outcome, 500 internal_error for inconsistency.
 */
async function handleFinalize(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const actor = await requireMutationActor(request, deps);
  const idempotencyKey = readKnownCommandId(request);
  const blobId = (request.params as { blobId?: string }).blobId ?? '';
  const result = await deps.attachments.finalize({ actor, blobId, idempotencyKey }).catch((error) => {
    throw mapFinalizeError(error);
  });
  switch (result.outcome) {
    case 'finalized':
    case 'already_finalized':
      return reply.code(200).type('application/json; charset=utf-8').send({
        kind: result.kind,
        blobId: result.receipt.blobId,
        logicalState: result.receipt.logicalState,
      });
    case 'not_found':
      throw concealedNotFound();
    case 'state_conflict':
      throw stateConflict('The Attachment cannot be finalized in its current state.');
    case 'idempotency_conflict':
      throw idempotencyConflict();
    case 'retryable':
      // A retryable database outcome (deadlock/serialization/lock wait) or a
      // rolled-back commit-unknown: the identical request may be retried
      // safely; 503 never fabricates a quota fact (no Retry-After).
      throw attachmentUnavailable('The Attachment could not be finalized right now. Retry the same request.');
    case 'inconsistent':
      throw new AttachmentHttpError({
        statusCode: attachmentErrorStatus('internal_error'),
        code: 'internal_error',
        message: 'The Attachment could not be finalized.',
        recovery: 'none',
      });
  }
}

function idempotencyConflict(): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('attachment_idempotency_conflict'),
    code: 'attachment_idempotency_conflict',
    message: 'The idempotency key was reused with different finalize facts.',
    recovery: 'user_action',
  });
}

function mapFinalizeError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  if (error instanceof FinalizeAttachmentInputError) {
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: 'The Attachment finalize request is invalid.',
      recovery: 'user_action',
    });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Replacement handler (P4A-P07: issue a NEW generation intent for an existing
// owner-private blob)
// ---------------------------------------------------------------------------

/**
 * P4A-P07: the replacement intent. The session + Origin + CSRF + command-id
 * gate runs first (no database work); the use case resolves the blob from
 * PostgreSQL in the same transaction, conceals every foreign/absent/revoked/
 * terminal identity as the stable 404, maps inadmissible states to 409 and
 * allocates a NEW generation + NEW physical key on the SAME blob (same-key
 * overwrite is impossible). The one-time grant appears ONLY here (the same
 * frozen UploadGrantDto as issue). The completed replacement generation is
 * CAS-activated inside the complete route's canonical transaction.
 */
const REPLACEMENT_FIELDS = ['declaredSize', 'declaredSha256', 'mediaHint', 'expectedPolicyRevision'] as const;

async function handleReplacement(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const actor = await requireMutationActor(request, deps);
  const idempotencyKey = readKnownCommandId(request);
  const blobId = (request.params as { blobId?: string }).blobId ?? '';
  const body = assertReplacementBody(request.body);
  const result = await deps.attachments.replacement({
    actor,
    blobId,
    idempotencyKey,
    declaredSize: body.declaredSize,
    declaredSha256: body.declaredSha256,
    mediaHint: body.mediaHint,
    expectedPolicyRevision: body.expectedPolicyRevision,
  }).catch((error) => {
    throw mapReplacementError(error);
  });
  switch (result.outcome) {
    case 'issued':
    case 'recovered':
      // The one-time grant appears ONLY here (OpenAPI x-known-secret); the
      // response carries exactly the frozen UploadGrantDto fields.
      return reply.code(201).type('application/json; charset=utf-8').send({
        kind: result.kind,
        receipt: {
          blobId: result.result.blobId,
          intentId: result.result.receipt.intentId,
          generationId: result.result.receipt.generationId,
        },
        grant: {
          url: result.result.grant.url,
          method: result.result.grant.method,
          contentType: result.result.grant.contentType,
          contentLength: result.result.grant.contentLength,
          expiresAt: result.result.grant.expiresAtIso,
          ttlSeconds: result.result.grant.ttlSeconds,
        },
      });
    case 'not_found':
      throw concealedNotFound();
    case 'state_conflict':
      throw stateConflict('The Attachment cannot be replaced in its current state.');
    case 'idempotency_conflict':
      throw idempotencyConflict();
    case 'retryable':
      // A retryable database outcome or a rolled-back commit-unknown: the
      // identical request may be retried safely; 503 never fabricates a quota
      // fact (no Retry-After).
      throw attachmentUnavailable('The replacement intent could not be issued right now. Retry the same request.');
    case 'inconsistent':
      throw new AttachmentHttpError({
        statusCode: attachmentErrorStatus('internal_error'),
        code: 'internal_error',
        message: 'The replacement intent could not be issued.',
        recovery: 'none',
      });
  }
}

function assertReplacementBody(value: unknown): {
  readonly declaredSize: number;
  readonly declaredSha256: string | null;
  readonly mediaHint: string | null;
  readonly expectedPolicyRevision: string | null;
} {
  const errors: AttachmentFieldError[] = [];
  if (!isRecord(value)) {
    throw invalidDocument('The Attachment replacement body must be a JSON object.');
  }
  errors.push(...assertNoUnknownFields(value, REPLACEMENT_FIELDS));
  if (value.declaredSize === undefined) errors.push(requiredField('declaredSize'));
  else if (typeof value.declaredSize !== 'number' || !Number.isSafeInteger(value.declaredSize)) {
    errors.push(typeMismatch('declaredSize'));
  }
  for (const key of ['declaredSha256', 'mediaHint', 'expectedPolicyRevision'] as const) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
      errors.push(typeMismatch(key));
    }
  }
  if (errors.length > 0) throw invalidDocument('The Attachment replacement request is invalid.', errors);
  return {
    declaredSize: value.declaredSize as number,
    declaredSha256: (value.declaredSha256 as string | null | undefined) ?? null,
    mediaHint: (value.mediaHint as string | null | undefined) ?? null,
    expectedPolicyRevision: (value.expectedPolicyRevision as string | null | undefined) ?? null,
  };
}

function mapReplacementError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  if (error instanceof UploadIntentInputError) {
    if (error.code === 'size_out_of_range') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('payload_too_large'),
        code: 'payload_too_large',
        message: 'The declared upload size exceeds the deployment ceiling.',
        recovery: 'user_action',
      });
    }
    return invalidInputDocument(error.code, fieldPathForIssue(error.code));
  }
  if (error instanceof UploadIntentExpiredError) {
    return stateConflict('The upload intent has expired; issue a new intent.');
  }
  if (error instanceof UploadIntentIdentityError) {
    if (error.code === 'request_facts_mismatch') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('attachment_idempotency_conflict'),
        code: 'attachment_idempotency_conflict',
        message: 'The idempotency key was reused with different replacement facts.',
        recovery: 'user_action',
      });
    }
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('internal_error'),
      code: 'internal_error',
      message: 'The replacement intent could not be resolved.',
      recovery: 'none',
    });
  }
  if (error instanceof UploadIntentSigningError) {
    // The ledger committed; the same unexpired binding can be re-signed on a
    // retry of the identical request (never a new generation).
    return attachmentUnavailable('The upload grant could not be signed. Retry the same request.');
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Retire handler (P4A-P07: retire one owner-private Attachment into retention)
// ---------------------------------------------------------------------------

/**
 * P4A-P07: the retire command. The session + Origin + CSRF + command-id gate
 * runs first; the use case resolves the blob from PostgreSQL in the same
 * transaction, conceals every foreign/absent/revoked/tombstoned identity as
 * the stable 404, maps inadmissible states to 409 and commits the canonical
 * retirement (metadata -> retired + generation -> retired + pointer clear +
 * Operation/Audit/Outbox). Replays converge to `already_retired` with the
 * ORIGINAL receipt.
 */
async function handleRetire(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const actor = await requireMutationActor(request, deps);
  const idempotencyKey = readKnownCommandId(request);
  const blobId = (request.params as { blobId?: string }).blobId ?? '';
  // The frozen retire contract has NO request body: an empty body/object is
  // accepted (the harness and the contract client send `{}`), anything else
  // is the stable 422 invalid_document before any database work.
  if (request.body !== undefined && request.body !== null) {
    if (!isRecord(request.body) || Object.keys(request.body).length > 0) {
      throw invalidDocument('The Attachment retire request must not carry a body.', []);
    }
  }
  const result = await deps.attachments.retire({ actor, blobId, idempotencyKey }).catch((error) => {
    throw mapRetireError(error);
  });
  switch (result.outcome) {
    case 'retired':
    case 'already_retired':
      return reply.code(200).type('application/json; charset=utf-8').send({
        kind: result.kind,
        blobId: result.receipt.blobId,
        logicalState: 'retired',
      });
    case 'not_found':
      throw concealedNotFound();
    case 'state_conflict':
      throw stateConflict('The Attachment cannot be retired in its current state.');
    case 'idempotency_conflict':
      throw idempotencyConflict();
    case 'retryable':
      throw attachmentUnavailable('The Attachment could not be retired right now. Retry the same request.');
    case 'inconsistent':
      throw new AttachmentHttpError({
        statusCode: attachmentErrorStatus('internal_error'),
        code: 'internal_error',
        message: 'The Attachment could not be retired.',
        recovery: 'none',
      });
  }
}

function mapRetireError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  if (error instanceof RetireAttachmentInputError) {
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: 'The Attachment retire request is invalid.',
      recovery: 'user_action',
    });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Shared auth/CSRF/command-id gate (cheap; runs before any database/R2 work)
// ---------------------------------------------------------------------------

interface RouteActor {
  readonly principalId: string;
  readonly subjectId: string;
  readonly kind: 'account';
}

async function requireMutationActor(
  request: FastifyRequest,
  deps: AttachmentRoutesDependencies,
): Promise<RouteActor> {
  const { account } = await requireProductMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
  return { principalId: account.id, subjectId: account.subjectId, kind: 'account' };
}

// ---------------------------------------------------------------------------
// P4A-RL04 route admission gate (after auth + cheap validation, before any
// database/R2 work). The frozen P01/RL02 header mapping decides the wire
// shape: 429 carries the REAL quota fact (Retry-After + RateLimit-Policy),
// 503 carries NO quota headers (rate_limit_unavailable is not a quota fact).
// ---------------------------------------------------------------------------

/**
 * Runs the distributed admission check for one route. Returns the stable
 * AttachmentHttpError when the request must stop (429 exhausted / 503
 * unavailable), or null when the request proceeds (allowed, or the bounded
 * complete emergency fallback). EVERY route uses the fixed route token as
 * the scope segment: the tenant/Collection fact is a database read inside
 * the use case for `complete`/`download`, the `issue` route must never use
 * the client-supplied collectionId as a scope (rotating nonexistent
 * collections would mint fresh per-principal buckets; KA-P4-AM-02), and the
 * `status` route must never use the client-supplied blobId as a scope
 * (rotating blobIds would mint fresh buckets per polled blob; KA-P4-AM-16).
 * A future per-collection sub-budget must use the authoritative collection
 * ID loaded and authorized from the database (plan §2.3 low-cardinality
 * keys).
 */
async function checkRouteRateLimit(
  deps: AttachmentRoutesDependencies,
  routeClass: AttachmentRateLimitRouteClass,
  subject: RateLimitSubject,
): Promise<AttachmentHttpError | null> {
  const facade = deps.attachments.rateLimit;
  if (facade === undefined) return null;
  const outcome = await facade.checkAdmission({ routeClass, subject });
  const mapping = mapRateLimitAdmissionToHttp(outcome, resolveRouteRatePolicy(facade.config, routeClass));
  if (mapping.status === 429) {
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('rate_limited'),
      code: 'rate_limited',
      message: 'Too many attempts. Retry later.',
      recovery: 'refresh_and_retry',
      sameRequestRetrySafe: true,
      retryAfterSeconds: outcome.kind === 'denied' ? outcome.decision.retryAfterSeconds : null,
      headers: mapping.headers,
    });
  }
  if (mapping.status === 503) {
    // Redis unavailable for issue/download (fail closed): a retryable
    // server-side unavailability with NO fabricated quota fact.
    return attachmentUnavailable('Attachment admission is temporarily unavailable. Please retry later.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue handler
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['collectionId', 'declaredSize', 'declaredSha256', 'mediaHint', 'expectedPolicyRevision'] as const;

interface IssueBodyShape {
  readonly collectionId: string;
  readonly declaredSize: number;
  readonly declaredSha256: string | null;
  readonly mediaHint: string | null;
  readonly expectedPolicyRevision: string | null;
}

async function handleIssue(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const actor = await requireMutationActor(request, deps);
  const idempotencyKey = readKnownCommandId(request);
  const body = assertIssueBody(request.body);
  // P4A-RL04: distributed admission AFTER auth + cheap validation, BEFORE
  // any database/R2 work (exhausted/unavailable -> zero ledger side effects).
  // The Collection fact is loaded and authorized inside the use case, so the
  // pre-database key uses the fixed route scope token: the client
  // collectionId must never enter the rate-limit subject (KA-P4-AM-02).
  const limited = await checkRouteRateLimit(deps, 'issue', {
    principalId: actor.principalId,
    scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  });
  if (limited !== null) throw limited;
  const outcome = await deps.attachments.issue({
    actor,
    collectionId: body.collectionId,
    idempotencyKey,
    declaredSize: body.declaredSize,
    declaredSha256: body.declaredSha256,
    mediaHint: body.mediaHint,
    expectedPolicyRevision: body.expectedPolicyRevision,
  }).catch((error) => {
    throw mapIssueError(error);
  });
  if (outcome.outcome === 'admission_stopped') {
    throw attachmentUnavailable('Attachment admission is temporarily unavailable. Please retry later.');
  }
  const result = outcome.result;
  // The one-time grant appears ONLY here (OpenAPI x-known-secret); the
  // response carries exactly the frozen UploadGrantDto fields.
  return reply.code(201).type('application/json; charset=utf-8').send({
    kind: result.recovered ? 'recovered' : 'issued',
    receipt: {
      blobId: result.blobId,
      intentId: result.receipt.intentId,
      generationId: result.receipt.generationId,
    },
    grant: {
      url: result.grant.url,
      method: result.grant.method,
      contentType: result.grant.contentType,
      contentLength: result.grant.contentLength,
      expiresAt: result.grant.expiresAtIso,
      ttlSeconds: result.grant.ttlSeconds,
    },
  });
}

// ---------------------------------------------------------------------------
// Complete handler
// ---------------------------------------------------------------------------

const COMPLETE_BINDING_FIELDS = ['intentId', 'generationId', 'blobId'] as const;
const COMPLETE_DECLARED_FIELDS = ['size', 'sha256', 'mediaType', 'etag'] as const;

interface CompleteBodyShape {
  readonly binding: { intentId: string; generationId: string; blobId: string };
  readonly declared: { size: number; sha256: string; mediaType: string; etag: string };
}

async function handleComplete(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AttachmentRoutesDependencies,
): Promise<FastifyReply> {
  const actor = await requireMutationActor(request, deps);
  // Known-Command-Id is validated (contract) but is never a physical input;
  // complete idempotency is the durable {intentId, generationId, blobId}.
  readKnownCommandId(request);
  const body = assertCompleteBody(request.body);
  // P4A-RL04: distributed admission BEFORE the ledger re-read and the
  // provider HEAD (exhausted/unavailable -> zero provider/database work). The
  // tenant/Collection scope is a database fact resolved inside the use case,
  // so the pre-database key uses the fixed route scope token (plan §2.3).
  const limited = await checkRouteRateLimit(deps, 'complete', {
    principalId: actor.principalId,
    scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  });
  if (limited !== null) throw limited;
  const result = await deps.attachments.complete({
    actor,
    binding: body.binding,
    declared: body.declared,
  }).catch((error) => {
    throw mapCompleteError(error);
  });
  return sendCompleteResult(reply, result, body.binding.blobId);
}

function sendCompleteResult(
  reply: FastifyReply,
  result: CompleteUploadResult,
  blobId: string,
): FastifyReply {
  switch (result.outcome) {
    case 'completed':
    case 'idempotent':
    case 'already_verified':
      return reply.code(200).type('application/json; charset=utf-8').send({
        kind: result.outcome,
        receipt: {
          blobId,
          intentId: result.receipt.intentId,
          generationId: result.receipt.generationId,
        },
      });
    case 'missing':
    case 'identity_mismatch':
    case 'principal_mismatch':
    case 'not_found':
      // Concealment: identical stable Problem for foreign, absent, and
      // wrong-principal bindings (zero body variation, no redirect).
      throw concealedNotFound();
    case 'etag_mismatch':
      throw stateConflict('The uploaded object does not match the declared ETag.');
    case 'size_mismatch':
      throw stateConflict('The uploaded object size does not match the declaration.');
    case 'metadata_not_allowed':
      throw stateConflict('The uploaded object carries metadata outside the fixed allowlist.');
    case 'declared_facts_mismatch':
      throw stateConflict('The declared facts do not match the committed upload intent.');
    case 'late_rejected':
      throw stateConflict('The upload intent has expired or is no longer completable.');
    default: {
      const exhaustive: never = result;
      void exhaustive;
      throw stateConflict('The upload cannot be completed in its current state.');
    }
  }
}

// ---------------------------------------------------------------------------
// Cheap body-shape validation (before any expensive work)
// ---------------------------------------------------------------------------

function invalidDocument(
  message: string,
  fieldErrors: readonly AttachmentFieldError[] = [],
): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('invalid_document'),
    code: 'invalid_document',
    message,
    recovery: 'user_action',
    fieldErrors,
  });
}

function unknownField(path: string): AttachmentFieldError {
  return { path, code: 'unknown_field', message: 'Unknown field.' };
}

function typeMismatch(path: string): AttachmentFieldError {
  return { path, code: 'type_mismatch', message: 'The field has the wrong type.' };
}

function requiredField(path: string): AttachmentFieldError {
  return { path, code: 'required_field', message: 'The field is required.' };
}

function invalidFieldValue(path: string, code: string): AttachmentFieldError {
  return { path, code: 'invalid_value', message: `The value fails validation (${code}).` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoUnknownFields(record: Record<string, unknown>, allowed: readonly string[]): AttachmentFieldError[] {
  const errors: AttachmentFieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) errors.push(unknownField(key));
  }
  return errors;
}

function assertIssueBody(value: unknown): IssueBodyShape {
  const errors: AttachmentFieldError[] = [];
  if (!isRecord(value)) {
    throw invalidDocument('The Attachment issue body must be a JSON object.');
  }
  errors.push(...assertNoUnknownFields(value, ISSUE_FIELDS));
  if (value.collectionId === undefined) errors.push(requiredField('collectionId'));
  else if (typeof value.collectionId !== 'string') errors.push(typeMismatch('collectionId'));
  else {
    // Unified collectionId contract (KA-P4-AM-02): the transport schema and
    // the rate-limit codec share one ceiling (RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH)
    // and one control-character pattern, so 257/512-char and control-char
    // collectionIds are rejected as a stable 422 BEFORE any Redis/DB work
    // (never a fail-closed 503 from the codec boundary).
    const collectionId = value.collectionId.trim();
    if (collectionId.length === 0) {
      errors.push(invalidFieldValue('collectionId', 'collection_id_required'));
    } else if (collectionId.length > RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH) {
      errors.push(invalidFieldValue('collectionId', 'collection_id_too_long'));
    } else if (RATE_LIMIT_SUBJECT_CONTROL_CHARACTER_PATTERN.test(collectionId)) {
      errors.push(invalidFieldValue('collectionId', 'collection_id_invalid'));
    }
  }
  if (value.declaredSize === undefined) errors.push(requiredField('declaredSize'));
  else if (typeof value.declaredSize !== 'number' || !Number.isSafeInteger(value.declaredSize)) {
    errors.push(typeMismatch('declaredSize'));
  }
  for (const key of ['declaredSha256', 'mediaHint', 'expectedPolicyRevision'] as const) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
      errors.push(typeMismatch(key));
    }
  }
  if (errors.length > 0) throw invalidDocument('The Attachment issue request is invalid.', errors);
  return {
    // Trimmed exactly like the use case, so the validated contract is the
    // value that travels onward.
    collectionId: (value.collectionId as string).trim(),
    declaredSize: value.declaredSize as number,
    declaredSha256: (value.declaredSha256 as string | null | undefined) ?? null,
    mediaHint: (value.mediaHint as string | null | undefined) ?? null,
    expectedPolicyRevision: (value.expectedPolicyRevision as string | null | undefined) ?? null,
  };
}

function assertCompleteBody(value: unknown): CompleteBodyShape {
  const errors: AttachmentFieldError[] = [];
  if (!isRecord(value)) {
    throw invalidDocument('The Attachment complete body must be a JSON object.');
  }
  errors.push(...assertNoUnknownFields(value, ['binding', 'declared']));
  if (value.binding === undefined) errors.push(requiredField('binding'));
  else if (!isRecord(value.binding)) errors.push(typeMismatch('binding'));
  if (value.declared === undefined) errors.push(requiredField('declared'));
  else if (!isRecord(value.declared)) errors.push(typeMismatch('declared'));
  if (errors.length > 0) throw invalidDocument('The Attachment complete request is invalid.', errors);

  const binding = value.binding as Record<string, unknown>;
  const declared = value.declared as Record<string, unknown>;
  const nested: AttachmentFieldError[] = [];
  nested.push(...assertNoUnknownFields(binding, COMPLETE_BINDING_FIELDS));
  nested.push(...assertNoUnknownFields(declared, COMPLETE_DECLARED_FIELDS));
  for (const key of COMPLETE_BINDING_FIELDS) {
    const candidate = binding[key];
    if (candidate === undefined) nested.push(requiredField(`binding.${key}`));
    else if (typeof candidate !== 'string') nested.push(typeMismatch(`binding.${key}`));
  }
  if (declared.size === undefined) nested.push(requiredField('declared.size'));
  else if (typeof declared.size !== 'number' || !Number.isSafeInteger(declared.size)) {
    nested.push(typeMismatch('declared.size'));
  }
  for (const key of ['sha256', 'mediaType', 'etag'] as const) {
    const candidate = declared[key];
    if (candidate === undefined) nested.push(requiredField(`declared.${key}`));
    else if (typeof candidate !== 'string') nested.push(typeMismatch(`declared.${key}`));
  }
  if (nested.length > 0) throw invalidDocument('The Attachment complete request is invalid.', nested);
  return {
    binding: {
      intentId: binding.intentId as string,
      generationId: binding.generationId as string,
      blobId: binding.blobId as string,
    },
    declared: {
      size: declared.size as number,
      sha256: declared.sha256 as string,
      mediaType: declared.mediaType as string,
      etag: declared.etag as string,
    },
  };
}

// ---------------------------------------------------------------------------
// Stable Problem mapping (frozen AttachmentErrorCode enum only)
// ---------------------------------------------------------------------------

function attachmentUnavailable(message: string): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('rate_limit_unavailable'),
    code: 'rate_limit_unavailable',
    message,
    recovery: 'refresh_and_retry',
    sameRequestRetrySafe: true,
  });
}

function stateConflict(message: string): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('attachment_state_conflict'),
    code: 'attachment_state_conflict',
    message,
    recovery: 'user_action',
  });
}

function concealedNotFound(): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('resource_not_found'),
    code: 'resource_not_found',
    message: 'The requested Attachment resource was not found.',
    recovery: 'none',
  });
}

function fieldPathForIssue(code: UploadIntentInputError['code']): string {
  if (code.startsWith('collection_id')) return 'collectionId';
  if (code === 'idempotency_key_required' || code === 'idempotency_key_too_long') return 'Known-Command-Id';
  if (code.startsWith('size')) return 'declaredSize';
  if (code === 'digest_invalid') return 'declaredSha256';
  if (code === 'media_not_allowed') return 'mediaHint';
  if (code === 'policy_revision_invalid') return 'expectedPolicyRevision';
  return 'body';
}

function fieldPathForComplete(code: CompleteUploadInputError['code']): string {
  if (code.startsWith('intent_id')) return 'binding.intentId';
  if (code.startsWith('generation_id')) return 'binding.generationId';
  if (code.startsWith('blob_id')) return 'binding.blobId';
  if (code === 'identifier_too_long') return 'binding';
  if (code === 'size_required' || code === 'size_out_of_range') return 'declared.size';
  if (code === 'digest_invalid') return 'declared.sha256';
  if (code === 'media_not_allowed') return 'declared.mediaType';
  if (code === 'etag_required' || code === 'etag_too_long') return 'declared.etag';
  return 'body';
}

function invalidInputDocument(
  code: string,
  path: string,
): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('invalid_document'),
    code: 'invalid_document',
    message: `The Attachment request is invalid: ${code}.`,
    recovery: 'user_action',
    fieldErrors: [{ path, code: 'invalid_value', message: `The value fails validation (${code}).` }],
  });
}

function mapIssueError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  if (error instanceof UploadIntentInputError) {
    if (error.code === 'size_out_of_range') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('payload_too_large'),
        code: 'payload_too_large',
        message: 'The declared upload size exceeds the deployment ceiling.',
        recovery: 'user_action',
      });
    }
    return invalidInputDocument(error.code, fieldPathForIssue(error.code));
  }
  if (error instanceof UploadIntentAuthorizationError) {
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('insufficient_permission'),
      code: 'insufficient_permission',
      message: 'You do not have permission to upload into this Collection.',
      recovery: 'user_action',
    });
  }
  if (error instanceof UploadIntentExpiredError) {
    return stateConflict('The upload intent has expired; issue a new intent.');
  }
  if (error instanceof UploadIntentIdentityError) {
    if (error.code === 'request_facts_mismatch') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('attachment_idempotency_conflict'),
        code: 'attachment_idempotency_conflict',
        message: 'The idempotency key was reused with different declared facts.',
        recovery: 'user_action',
      });
    }
    return new AttachmentHttpError({
      statusCode: attachmentErrorStatus('internal_error'),
      code: 'internal_error',
      message: 'The upload intent could not be resolved.',
      recovery: 'none',
    });
  }
  if (error instanceof UploadIntentSigningError) {
    // The ledger committed; the same unexpired binding can be re-signed on a
    // retry of the identical request (never a new generation).
    return attachmentUnavailable('The upload grant could not be signed. Retry the same request.');
  }
  throw error;
}

function mapCompleteError(error: unknown): AttachmentHttpError {
  if (error instanceof AttachmentHttpError) return error;
  if (error instanceof CompleteUploadInputError) {
    if (error.code === 'size_out_of_range') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('payload_too_large'),
        code: 'payload_too_large',
        message: 'The declared upload size exceeds the deployment ceiling.',
        recovery: 'user_action',
      });
    }
    return invalidInputDocument(error.code, fieldPathForComplete(error.code));
  }
  if (error instanceof CompleteUploadProviderError) {
    if (error.providerClass === 'denied') {
      return new AttachmentHttpError({
        statusCode: attachmentErrorStatus('internal_error'),
        code: 'internal_error',
        message: 'The upload could not be attested.',
        recovery: 'none',
      });
    }
    // retryable/unknown provider HEAD: a retryable server-side unavailability
    // with no quota fact; the identical request may be retried safely.
    return attachmentUnavailable('The upload could not be attested right now. Retry the same request.');
  }
  throw error;
}
