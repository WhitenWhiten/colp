import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CollaborationError } from '../../../src/modules/access-policy/index.js';
import {
  AnnotationCreateError,
  AnnotationDeleteError,
  AnnotationProductReadError,
  AnnotationUpdateError,
  RelationCreateError,
  RelationProductReadError,
  RelationUpdateError,
} from '../../../src/modules/collections/index.js';
import { IdentityError } from '../../../src/modules/identity/index.js';
import {
  NotificationPreferenceCommandError,
  NotificationReadCommandError,
} from '../../../src/modules/notifications/index.js';
import {
  ReadingProgressError,
  ReadingProgressQueryError,
  SavedResourceError,
  SavedResourceQueryError,
} from '../../../src/modules/reading-progress/index.js';
import { SearchQueryError } from '../../../src/modules/search/index.js';
import { FollowCommandError } from '../../../src/modules/social/index.js';
import { mapAnnotationError } from '../../../src/transport/product/annotation-routes.js';
import { mapProfileSettingsError } from '../../../src/transport/auth/browser-auth-routes.js';
import { mapFollowError } from '../../../src/transport/product/follow-routes.js';
import { mapNotificationError } from '../../../src/transport/product/notification-routes.js';
import { mapCollaborationHttpError } from '../../../src/transport/product/product-collaboration-routes.js';
import { mapRelationError } from '../../../src/transport/product/relation-routes.js';
import { mapReadingProgressError } from '../../../src/transport/product/reading-progress-routes.js';
import { mapSavedResourceError } from '../../../src/transport/product/saved-resource-routes.js';
import { mapSearchError } from '../../../src/transport/product/search-routes.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';

function asProductError(value: unknown, label: string): ProductHttpError {
  assert.ok(value instanceof ProductHttpError, `${label}: expected ProductHttpError`);
  return value;
}

function assertWire(error: ProductHttpError, productCode: string, statusCode: number, recovery?: string): void {
  assert.equal(error.productCode, productCode);
  assert.equal(error.statusCode, statusCode);
  if (recovery !== undefined) assert.equal(error.recovery, recovery);
}

// Each mapper under test is imported directly (no server, no harness) so the
// exact code + status + recovery wire contract is asserted without mirroring
// the production mapping algorithm.
describe('R19 transport mapper wire contract', () => {
  test('drift code handle_taken maps to 409 with user_action recovery', () => {
    assertWire(asProductError(mapProfileSettingsError(new IdentityError('handle_taken', 'x')), 'handle_taken'),
      'handle_taken', 409, 'user_action');
  });

  test('drift code invalid_handle maps to 422 with /handle field error', () => {
    const error = asProductError(mapProfileSettingsError(new IdentityError('invalid_handle', 'bad handle')), 'invalid_handle');
    assertWire(error, 'invalid_handle', 422, 'user_action');
    assert.deepEqual(error.fieldErrors.map(({ path }) => path), ['/handle']);
  });

  test('drift code invalid_display_name maps to 422 with /displayName field error', () => {
    const error = asProductError(mapProfileSettingsError(new IdentityError('invalid_display_name', 'bad name')), 'invalid_display_name');
    assertWire(error, 'invalid_display_name', 422, 'user_action');
    assert.deepEqual(error.fieldErrors.map(({ path }) => path), ['/displayName']);
  });

  test('drift code invalid_about maps to 422 with /about field error', () => {
    const error = asProductError(mapProfileSettingsError(new IdentityError('invalid_about', 'bad about')), 'invalid_about');
    assertWire(error, 'invalid_about', 422, 'user_action');
    assert.deepEqual(error.fieldErrors.map(({ path }) => path), ['/about']);
  });

  test('drift code mutation_conflict maps to 409 (relation_already_exists)', () => {
    assertWire(asProductError(mapRelationError(new RelationCreateError('relation_already_exists', 'x')), 'mutation_conflict'),
      'mutation_conflict', 409);
  });

  test('collaboration conflict family maps to 409 mutation_conflict; true 400s stay invalid_request', () => {
    for (const code of [
      'already_member',
      'invite_already_pending',
      'invite_expired',
      'invite_not_pending',
      'owner_immutable',
      'self_invite',
      'member_limit',
      'pending_invite_limit',
    ] as const) {
      assertWire(
        asProductError(mapCollaborationHttpError(new CollaborationError(code, `${code} message`)), code),
        'mutation_conflict',
        409,
        'user_action',
      );
    }
    for (const code of ['invalid_email', 'invalid_role'] as const) {
      assertWire(
        asProductError(mapCollaborationHttpError(new CollaborationError(code, `${code} message`)), code),
        'invalid_request',
        400,
      );
    }
  });

  test('Profile settings mapper maps account lifecycle to authentication_required 401', () => {
    for (const code of ['account_not_found', 'account_disabled', 'account_deleted'] as const) {
      const error = asProductError(mapProfileSettingsError(new IdentityError(code, 'x')), code);
      assertWire(error, 'authentication_required', 401, 'user_action');
    }
  });

  test('annotation mapper: not found, precondition, payload, invalid document spread', () => {
    assertWire(asProductError(mapAnnotationError(new AnnotationCreateError('annotation_not_found', 'x')), 'annotation_not_found'),
      'resource_not_found', 404, 'none');

    const preconditionFailed = asProductError(
      mapAnnotationError(new AnnotationUpdateError('annotation_precondition_failed', 'x', '"etag"')),
      'annotation_precondition_failed');
    assertWire(preconditionFailed, 'precondition_failed', 412, 'refresh_and_retry');
    assert.equal(preconditionFailed.precondition, 'resource');
    assert.equal(preconditionFailed.currentEtag, '"etag"');

    const preconditionRequired = asProductError(
      mapAnnotationError(new AnnotationDeleteError('annotation_precondition_required', 'x')),
      'annotation_precondition_required');
    assertWire(preconditionRequired, 'precondition_required', 428, 'refresh_and_retry');

    const tooLarge = asProductError(mapAnnotationError(new AnnotationCreateError('annotation_value_too_large', 'x')), 'too_large');
    assertWire(tooLarge, 'payload_too_large', 413);

    const invalidPrecondition = asProductError(
      mapAnnotationError(new AnnotationDeleteError('invalid_annotation_precondition', 'x')), 'invalid_annotation_precondition');
    assertWire(invalidPrecondition, 'invalid_request', 400);

    const broadVisibility = asProductError(
      mapAnnotationError(new AnnotationUpdateError('annotation_visibility_too_broad', 'x')), 'annotation_visibility_too_broad');
    assertWire(broadVisibility, 'invalid_document', 422);

    const subjectLimit = asProductError(
      mapAnnotationError(new AnnotationCreateError('annotation_subject_limit_reached', 'x')), 'annotation_subject_limit_reached');
    assertWire(subjectLimit, 'invalid_document', 422);

    const readCursor = asProductError(mapAnnotationError(new AnnotationProductReadError('invalid_cursor')), 'read invalid_cursor');
    assertWire(readCursor, 'invalid_cursor', 400, 'restart_from_first_page');
  });

  test('relation mapper: not found, precondition, precondition-required, invalid document', () => {
    assertWire(asProductError(mapRelationError(new RelationCreateError('relation_not_found', 'x')), 'relation_not_found'),
      'resource_not_found', 404, 'none');

    const preconditionFailed = asProductError(
      mapRelationError(new RelationUpdateError('relation_precondition_failed', 'x', '"etag"')),
      'relation_precondition_failed');
    assertWire(preconditionFailed, 'precondition_failed', 412, 'refresh_and_retry');
    assert.equal(preconditionFailed.precondition, 'resource');
    assert.equal(preconditionFailed.currentEtag, '"etag"');

    const readCursor = asProductError(mapRelationError(new RelationProductReadError('invalid_cursor')), 'read invalid_cursor');
    assertWire(readCursor, 'invalid_cursor', 400, 'restart_from_first_page');

    const invalidDocument = asProductError(
      mapRelationError(new RelationCreateError('invalid_relation_document', 'x')), 'invalid_relation_document');
    assertWire(invalidDocument, 'invalid_document', 422);
  });

  test('follow mapper: command errors and unknown fail-closed to 500 internal_error', () => {
    assertWire(asProductError(mapFollowError(new FollowCommandError('resource_not_found', 'x')), 'resource_not_found'),
      'resource_not_found', 404, 'none');
    assertWire(asProductError(mapFollowError(new FollowCommandError('invalid_request', 'x')), 'invalid_request'),
      'invalid_request', 400);

    const unknown = asProductError(mapFollowError(new Error('boom')), 'unknown follow error');
    assertWire(unknown, 'internal_error', 500, 'same_request');
  });

  test('notification mapper: stale revisions/state and unknown fail-closed', () => {
    const preference = asProductError(
      mapNotificationError(new NotificationPreferenceCommandError('stale_revision', 'x')), 'stale_revision');
    assertWire(preference, 'precondition_failed', 412, 'refresh_and_retry');
    assert.equal(preference.precondition, 'resource');

    const read = asProductError(mapNotificationError(new NotificationReadCommandError('stale_state', 'x')), 'stale_state');
    assertWire(read, 'precondition_failed', 412);

    const invalidRequest = asProductError(mapNotificationError(new NotificationReadCommandError('invalid_request', 'x')), 'invalid_request');
    assertWire(invalidRequest, 'invalid_document', 422);

    const unknown = asProductError(mapNotificationError(new Error('boom')), 'unknown notification error');
    assertWire(unknown, 'internal_error', 500, 'same_request');
  });

  test('reading-progress mapper: query and mutation error codes', () => {
    assertWire(asProductError(mapReadingProgressError(new ReadingProgressQueryError('invalid_cursor')), 'invalid_cursor'),
      'invalid_cursor', 400, 'restart_from_first_page');
    assertWire(asProductError(mapReadingProgressError(new ReadingProgressQueryError('invalid_reading_progress_query')), 'query'),
      'invalid_query', 400);
    assertWire(asProductError(mapReadingProgressError(new ReadingProgressError('reading_progress_not_found', 'x')), 'not_found'),
      'resource_not_found', 404, 'none');

    const preconditionFailed = asProductError(
      mapReadingProgressError(new ReadingProgressError('reading_progress_precondition_failed', 'x', '"etag"')), 'precondition_failed');
    assertWire(preconditionFailed, 'precondition_failed', 412, 'refresh_and_retry');
    assert.equal(preconditionFailed.currentEtag, '"etag"');

    assertWire(asProductError(mapReadingProgressError(new ReadingProgressError('invalid_reading_progress_input', 'x')), 'invalid_input'),
      'invalid_document', 422);
  });

  test('saved-resource mapper: query and mutation error codes', () => {
    assertWire(asProductError(mapSavedResourceError(new SavedResourceQueryError('invalid_cursor')), 'invalid_cursor'),
      'invalid_cursor', 400, 'restart_from_first_page');
    assertWire(asProductError(mapSavedResourceError(new SavedResourceQueryError('invalid_saved_resource_query')), 'query'),
      'invalid_query', 400);
    assertWire(asProductError(mapSavedResourceError(new SavedResourceError('saved_resource_not_found', 'x')), 'not_found'),
      'resource_not_found', 404, 'none');
    assertWire(asProductError(mapSavedResourceError(new SavedResourceError('invalid_saved_resource_input', 'x')), 'invalid_input'),
      'invalid_document', 422);
  });

  test('search mapper: query errors, timeout/abort, unknown fail-closed', () => {
    const signal = new AbortController().signal;
    assertWire(asProductError(mapSearchError(new SearchQueryError('invalid_cursor'), signal), 'invalid_cursor'),
      'invalid_cursor', 400, 'restart_from_first_page');
    assertWire(asProductError(mapSearchError(new SearchQueryError('invalid_search_query'), signal), 'invalid_search_query'),
      'invalid_query', 400);
    for (const code of ['search_timeout', 'search_aborted'] as const) {
      const unavailable = asProductError(mapSearchError(new SearchQueryError(code), signal), code);
      assertWire(unavailable, 'feature_temporarily_unavailable', 503, 'same_request');
    }
    const unknown = asProductError(mapSearchError(new Error('boom'), signal), 'unknown search error');
    assertWire(unknown, 'internal_error', 500, 'same_request');
  });
});
