import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, test } from 'vitest';
import {
  AnnotationCreateError,
  RelationCreateError,
} from '../../../src/modules/collections/index.js';
import { IdentityError } from '../../../src/modules/identity/index.js';
import {
  hasCode,
  PRODUCT_ERROR_STATUS,
  type CodedError,
  type ProductErrorCode,
} from '../../../src/transport/product-codes.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';

/**
 * R19: the transport error-code union is generated from the frozen
 * openapi/product-v1.yaml ProductErrorCode enum, extended by drifted wire codes
 * (handle_taken, invalid_handle, invalid_display_name, invalid_about, mutation_conflict,
 * not_acceptable) that
 * ADR-0015 keeps out of the schema (enum growth is a breaking change to
 * published /api/v1), so they are centralized in product-codes.ts.
 * This list is the wire contract. Adding a code to the union requires:
 *  - the central PRODUCT_ERROR_STATUS table to satisfy the grown union (typecheck),
 *  - this EXPECTED_CODES list to match (runtime contract test).
 * A code added to the union that is not mirrored here makes this test fail.
 */
const EXPECTED_CODES = [
  'account_link_required',
  'authentication_required',
  'command_id_reused',
  'command_in_progress',
  'command_result_expired',
  'csrf_failed',
  'email_delivery_unavailable',
  'feature_temporarily_unavailable',
  'folder_not_empty',
  'handle_taken',
  'insufficient_permission',
  'internal_error',
  'invalid_credentials',
  'invalid_cursor',
  'invalid_display_name',
  'invalid_document',
  'invalid_about',
  'invalid_handle',
  'invalid_json',
  'invalid_query',
  'invalid_request',
  'method_not_allowed',
  'mutation_conflict',
  'not_acceptable',
  'payload_too_large',
  'position_context_stale',
  'precondition_failed',
  'precondition_required',
  'publication_slug_conflict',
  'rate_limited',
  'resource_not_found',
  'resource_purged',
  'revision_conflict',
  'root_immutable',
  'snapshot_expired',
  'unsupported_media_type',
  'verification_required',
] as const;

// Compile-time structural contract: domain error classes satisfy CodedError<TCode>
// by carrying a typed `code`, without inheriting a shared transport base class.
const annotationCoded: CodedError<AnnotationCreateError['code']> = new AnnotationCreateError('annotation_not_found', 'x');
const relationCoded: CodedError<RelationCreateError['code']> = new RelationCreateError('relation_already_exists', 'x');
const identityCoded: CodedError<IdentityError['code']> = new IdentityError('handle_taken', 'x');
void annotationCoded;
void relationCoded;
void identityCoded;

describe('R19 central ProductErrorCode table', () => {
  test('covers exactly the generated ProductErrorCode union with no extra codes', () => {
    assert.deepEqual([...Object.keys(PRODUCT_ERROR_STATUS)].sort(), [...EXPECTED_CODES].sort());
    for (const code of EXPECTED_CODES) {
      assert.equal(typeof PRODUCT_ERROR_STATUS[code], 'number', `missing status for ${code}`);
    }
  });

  test('maps every code to its exact wire status', () => {
    // Each value is the exact HTTP status emitted by the owning route. These
    // pin the wire contract; asserting only `message` would be a false positive.
    const expected: Readonly<Record<ProductErrorCode, number>> = {
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
    };
    for (const code of EXPECTED_CODES) {
      assert.equal(PRODUCT_ERROR_STATUS[code], expected[code], `status for ${code}`);
    }
  });

  test('hasCode narrows structural CodedError without instanceof coupling', () => {
    const domain = new AnnotationCreateError('annotation_not_found', 'x');
    assert.equal(hasCode(domain, 'annotation_not_found'), true);
    assert.equal(hasCode(domain, 'invalid_document'), false);
    assert.equal(hasCode({ code: 'annotation_not_found' }, 'annotation_not_found'), true);
    assert.equal(hasCode(null, 'annotation_not_found'), false);
    assert.equal(hasCode(undefined, 'annotation_not_found'), false);
    assert.equal(hasCode('plain string', 'annotation_not_found'), false);
    assert.equal(hasCode({ code: 42 }, 'annotation_not_found'), false);
    assert.equal(hasCode({ other: 'x' }, 'annotation_not_found'), false);
    assert.equal(hasCode(42, 'annotation_not_found'), false);
  });

  test('ProductHttpError carries the centralized code as its wire productCode', () => {
    const conflict = new ProductHttpError({ statusCode: 409, code: 'mutation_conflict', message: 'x' });
    assert.equal(conflict.productCode, 'mutation_conflict');
    const missing = new ProductHttpError({ statusCode: 404, code: 'resource_not_found', message: 'x', recovery: 'none' });
    assert.equal(missing.productCode, 'resource_not_found');
    assert.equal(missing.recovery, 'none');
  });

  test('OpenAPI ProductErrorCode stays frozen and documents ADR-0015 drifted wire codes', () => {
    const document = parse(
      readFileSync(join(resolve(import.meta.dirname, '../../..'), 'openapi/product-v1.yaml'), 'utf8'),
    ) as {
      info: { version: string };
      components: {
        schemas: {
          ProductErrorCode: { type: string; description?: string; enum: string[] };
        };
      };
    };
    const schema = document.components.schemas.ProductErrorCode;
    const codes = schema.enum;
    for (const drifted of [
      'invalid_credentials',
      'verification_required',
      'mutation_conflict',
      'not_acceptable',
      'handle_taken',
      'invalid_handle',
      'invalid_display_name',
      'invalid_about',
      'account_link_required',
      'email_delivery_unavailable',
      'resource_purged',
    ] as const) {
      assert.equal(codes.includes(drifted), false, `published enum must not contain ${drifted}`);
    }
    assert.equal(codes.length, 26);
    const description = schema.description ?? '';
    assert.match(description, /ADR-0015/u);
    assert.match(description, /product-codes\.ts/u);
    assert.match(description, /DriftedProductErrorCode/u);
    assert.match(description, /must not treat the generated enum as exhaustive/u);
    for (const drifted of [
      'handle_taken',
      'invalid_handle',
      'invalid_display_name',
      'invalid_about',
      'mutation_conflict',
      'not_acceptable',
      'invalid_credentials',
      'verification_required',
      'account_link_required',
      'email_delivery_unavailable',
      'resource_purged',
    ] as const) {
      assert.match(description, new RegExp(drifted, 'u'));
    }
  });
});
