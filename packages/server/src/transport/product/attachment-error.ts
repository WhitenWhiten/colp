/**
 * P4A-P01 transport error contract for the owner-private Attachment product
 * surface.
 *
 * The frozen ProductErrorCode enum (openapi/product-v1.yaml) cannot grow
 * without a superseding ADR, so the Attachment family uses its own stable
 * envelope (AttachmentErrorEnvelope / AttachmentErrorCode) exactly like the
 * Profile settings surface. `ATTACHMENT_ERROR_CODES` is the machine contract:
 * tests/unit/phase4a/phase4a-p01-contract.test.ts pins it byte-for-byte against the
 * OpenAPI enum, and the `satisfies` clause below rejects a status-table entry
 * that drifts from the union.
 *
 * Every response on an /api/v1/attachments path uses this envelope (the app
 * error/not-found handlers branch on isAttachmentUrl), so one client parser
 * covers the whole resource family. The closed state for not-yet-implemented
 * behavior is 503 attachments_not_implemented: an explicit shutdown, never a
 * fake success. 503 rate_limit_unavailable carries NO Retry-After (it is not a
 * quota fact).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export const ATTACHMENT_ERROR_CODES = [
  'invalid_request',
  'invalid_json',
  'invalid_document',
  'unsupported_media_type',
  'payload_too_large',
  'authentication_required',
  'csrf_failed',
  'insufficient_permission',
  'resource_not_found',
  'method_not_allowed',
  'attachment_idempotency_conflict',
  'attachment_state_conflict',
  'rate_limited',
  'rate_limit_unavailable',
  'attachments_not_implemented',
  'internal_error',
] as const;

export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[number];

export type AttachmentRecovery =
  | 'same_request'
  | 'refresh_and_retry'
  | 'restart_from_first_page'
  | 'user_action'
  | 'none';

export interface AttachmentFieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AttachmentErrorEnvelope {
  readonly error: {
    readonly code: AttachmentErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly recovery: AttachmentRecovery;
    readonly sameRequestRetrySafe: boolean;
    readonly precondition: 'resource' | 'content' | null;
    readonly currentEtag: string | null;
    readonly retryAfterSeconds: number | null;
    readonly fieldErrors: readonly AttachmentFieldError[];
  };
}

/**
 * Canonical HTTP status per Attachment transport code. Every
 * AttachmentErrorCode must appear with its exact wire status; the `satisfies`
 * clause rejects a code that is missing, and excess-property checking rejects
 * a code that is not in the union.
 */
export const ATTACHMENT_ERROR_STATUS = {
  invalid_request: 400,
  invalid_json: 400,
  invalid_document: 422,
  unsupported_media_type: 415,
  payload_too_large: 413,
  authentication_required: 401,
  csrf_failed: 403,
  insufficient_permission: 403,
  resource_not_found: 404,
  method_not_allowed: 405,
  attachment_idempotency_conflict: 409,
  attachment_state_conflict: 409,
  rate_limited: 429,
  rate_limit_unavailable: 503,
  attachments_not_implemented: 503,
  internal_error: 500,
} as const satisfies Readonly<Record<AttachmentErrorCode, number>>;

/** Read the canonical status for an Attachment transport code. */
export function attachmentErrorStatus(code: AttachmentErrorCode): number {
  return ATTACHMENT_ERROR_STATUS[code];
}

export interface AttachmentHttpErrorOptions {
  readonly statusCode: number;
  readonly code: AttachmentErrorCode;
  readonly message: string;
  readonly recovery?: AttachmentRecovery;
  readonly sameRequestRetrySafe?: boolean;
  readonly precondition?: 'resource' | 'content' | null;
  readonly currentEtag?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly fieldErrors?: readonly AttachmentFieldError[];
  readonly headers?: Readonly<Record<string, string>>;
}

export class AttachmentHttpError extends Error {
  readonly statusCode: number;
  readonly attachmentCode: AttachmentErrorCode;
  readonly recovery: AttachmentRecovery;
  readonly sameRequestRetrySafe: boolean;
  readonly precondition: 'resource' | 'content' | null;
  readonly currentEtag: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fieldErrors: readonly AttachmentFieldError[];
  readonly headers: Readonly<Record<string, string>>;

  constructor(options: AttachmentHttpErrorOptions) {
    super(options.message);
    this.name = 'AttachmentHttpError';
    this.statusCode = options.statusCode;
    this.attachmentCode = options.code;
    this.recovery = options.recovery ?? 'user_action';
    this.sameRequestRetrySafe = options.sameRequestRetrySafe ?? false;
    this.precondition = options.precondition ?? null;
    this.currentEtag = options.currentEtag ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.fieldErrors = options.fieldErrors ?? [];
    this.headers = options.headers ?? {};
  }
}

/**
 * Sends the stable Attachment Problem envelope. The body never contains a
 * grant, URL, key, credential, digest, or capability field.
 */
export function sendAttachmentError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AttachmentHttpError,
): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  const envelope: AttachmentErrorEnvelope = {
    error: {
      code: error.attachmentCode,
      message: error.message,
      requestId: request.id,
      recovery: error.recovery,
      sameRequestRetrySafe: error.sameRequestRetrySafe,
      precondition: error.precondition,
      currentEtag: error.currentEtag,
      retryAfterSeconds: error.retryAfterSeconds,
      fieldErrors: error.fieldErrors,
    },
  };
  return reply
    .code(error.statusCode)
    .type('application/json; charset=utf-8')
    .send(envelope);
}

/** The exact closed state every not-yet-implemented Attachment behavior returns. */
export function attachmentNotImplemented(): AttachmentHttpError {
  return new AttachmentHttpError({
    statusCode: attachmentErrorStatus('attachments_not_implemented'),
    code: 'attachments_not_implemented',
    message: 'Attachment commands are not implemented yet.',
    recovery: 'none',
    sameRequestRetrySafe: false,
  });
}
