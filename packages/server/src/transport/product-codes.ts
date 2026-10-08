import type { components } from '../../generated/openapi/product-v1.js';

/**
 * Central transport error-code union.
 *
 * The base comes from the frozen OpenAPI ProductErrorCode enum (openapi/product-v1.yaml).
 * Codes that are already emitted on the wire but kept out of the schema are
 * pinned here instead of being added to the published enum: ADR-0015 and the
 * phase1 Product API contract treat adding enum/error-code branches to the
 * published /api/v1 contract as breaking, so they cannot enter the frozen
 * ProductErrorCode enum without a superseding ADR and a new major version.
 * R19 therefore "集中定义" these drifted codes at the transport boundary, and
 * Task A4 adds the unified Better Auth auth-error codes the same way
 * (invalid_credentials / verification_required / account_link_required /
 * email_delivery_unavailable — plan §7 A4 step 5, G1 §10).
 *
 * Every `satisfies Readonly<Record<ProductErrorCode, ...>>` site fails typecheck
 * until a new code is mapped (anti-false-negative guard), and
 * tests/unit/product/product-error-codes.test.ts pins the exact runtime list.
 */
type GeneratedProductErrorCode = components['schemas']['ProductErrorCode'];

/** Wire codes frozen out of the OpenAPI enum by ADR-0015 (see above). */
type DriftedProductErrorCode =
  | 'handle_taken'
  | 'invalid_handle'
  | 'invalid_display_name'
  | 'invalid_about'
  | 'mutation_conflict'
  | 'not_acceptable'
  // Task A4 unified Better Auth error classification.
  | 'invalid_credentials'
  | 'verification_required'
  | 'account_link_required'
  | 'email_delivery_unavailable'
  | 'resource_purged';

export type ProductErrorCode = GeneratedProductErrorCode | DriftedProductErrorCode;

/**
 * Structural domain error contract. Any domain error carrying a typed `code`
 * satisfies CodedError<TCode> without inheriting a shared transport base class,
 * so Collections, Publication and COLP Sync keep their own error hierarchies.
 */
export interface CodedError<TCode extends string = string> {
  readonly code: TCode;
}

/** Narrow any unknown to a structural CodedError without instanceof coupling. */
export function hasCode<TCode extends string>(
  error: unknown,
  code: TCode,
): error is CodedError<TCode> {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

/**
 * Canonical HTTP status per transport code. Every ProductErrorCode must appear
 * with its exact wire status; the `satisfies` clause rejects a code that is
 * missing, and excess-property checking rejects a code that is not in the union.
 */
export const PRODUCT_ERROR_STATUS = {
  invalid_request: 400,
  invalid_json: 400,
  invalid_query: 400,
  invalid_cursor: 400,
  authentication_required: 401,
  invalid_credentials: 401,
  csrf_failed: 403,
  verification_required: 403,
  account_link_required: 403,
  insufficient_permission: 403,
  resource_not_found: 404,
  method_not_allowed: 405,
  not_acceptable: 406,
  command_id_reused: 409,
  command_in_progress: 409,
  publication_slug_conflict: 409,
  position_context_stale: 409,
  folder_not_empty: 409,
  root_immutable: 409,
  revision_conflict: 409,
  snapshot_expired: 409,
  command_result_expired: 410,
  resource_purged: 410,
  handle_taken: 409,
  invalid_handle: 422,
  invalid_display_name: 422,
  invalid_about: 422,
  mutation_conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_document: 422,
  precondition_required: 428,
  rate_limited: 429,
  internal_error: 500,
  email_delivery_unavailable: 503,
  feature_temporarily_unavailable: 503,
} as const satisfies Readonly<Record<ProductErrorCode, number>>;

/** Read the canonical status for a transport code. */
export function productErrorStatus(code: ProductErrorCode): number {
  return PRODUCT_ERROR_STATUS[code];
}
