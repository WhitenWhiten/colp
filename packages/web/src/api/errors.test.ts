/**
 * P1-13: Product error parsing and recovery strategy mapping.
 *
 * Production: src/api/errors.ts
 *   ProductApiError, parseProductErrorEnvelope, recoveryStrategyFor
 *
 * Notes vs server registry (08-phase1-product-api-contract.md):
 * - Server uses recovery restart_from_first_page for snapshot_expired / invalid_cursor.
 * - Client UI should use recoveryStrategyFor (code-based), not only envelope.recovery.
 */
import { describe, expect, it } from 'vitest'
import {
  parseProductErrorEnvelope,
  ProductApiError,
  recoveryStrategyFor,
  isProductApiError,
} from './errors'
import { productErrorBody } from './test-helpers'

function apiError(
  status: number,
  code: string,
  recovery: string,
  extra: Record<string, unknown> = {},
): ProductApiError {
  const envelope = productErrorBody({ code, recovery, ...extra })
  const error = parseProductErrorEnvelope(envelope)
  return new ProductApiError(status, error)
}

describe('parseProductErrorEnvelope', () => {
  it('extracts the Product error object from a valid envelope', () => {
    const error = parseProductErrorEnvelope(
      productErrorBody({
        code: 'invalid_document',
        message: 'title is required',
        requestId: 'req-abc',
        recovery: 'user_action',
        fieldErrors: [{ path: '/title', code: 'required', message: 'required' }],
      }),
    )
    expect(error?.code).toBe('invalid_document')
    expect(error?.message).toContain('title')
    expect(error?.requestId).toBe('req-abc')
    expect(error?.fieldErrors).toHaveLength(1)
  })

  it('returns null for non-envelope bodies', () => {
    expect(parseProductErrorEnvelope(null)).toBeNull()
    expect(parseProductErrorEnvelope({ oops: true })).toBeNull()
    expect(parseProductErrorEnvelope({ error: { code: 1 } })).toBeNull()
  })
})

describe('ProductApiError', () => {
  it('maps precondition_failed (412) fields for refresh UX', () => {
    const e = apiError(412, 'precondition_failed', 'refresh_and_retry', {
      precondition: 'resource',
      currentEtag: '"rev-9"',
    })
    expect(e.code).toBe('precondition_failed')
    expect(e.status).toBe(412)
    expect(e.isPreconditionFailed).toBe(true)
    expect(e.sameRequestRetrySafe).toBe(false)
    expect(e.currentEtag).toBe('"rev-9"')
    expect(e.recoveryHint).toMatch(/refresh/i)
  })

  it('never shows developer text for server failures (R15-23)', () => {
    const plain = 'Know-N is having trouble right now. Try again in a minute.'
    expect(new ProductApiError(503, null).recoveryHint).toBe(plain)
    expect(new ProductApiError(500, null).recoveryHint).toBe(plain)
    expect(new ProductApiError(404, null).recoveryHint).toBe(plain)
    expect(apiError(502, 'internal_error', 'same_request').recoveryHint).toBe(plain)
    expect(apiError(504, 'gateway_timeout', 'same_request').recoveryHint).toBe(plain)
    expect(new ProductApiError(503, null).recoveryHint).not.toMatch(/Product API error/u)
  })

  it('flags snapshot_expired / invalid_cursor as isSnapshotExpired', () => {
    const expired = apiError(409, 'snapshot_expired', 'restart_from_first_page')
    expect(expired.code).toBe('snapshot_expired')
    expect(expired.isSnapshotExpired).toBe(true)
    // Envelope recovery is preserved; strategy layer decides UX.
    expect(expired.recovery).toBe('restart_from_first_page')

    const cursor = apiError(400, 'invalid_cursor', 'restart_from_first_page')
    expect(cursor.isSnapshotExpired).toBe(true)
  })

  it('flags command_result_expired / command_id_reused as non-blind-retry', () => {
    const expired = apiError(410, 'command_result_expired', 'user_action')
    expect(expired.isCommandResultExpired).toBe(true)
    expect(expired.sameRequestRetrySafe).toBe(false)

    const reused = apiError(409, 'command_id_reused', 'user_action')
    expect(reused.isCommandIdReused).toBe(true)
    expect(reused.sameRequestRetrySafe).toBe(false)
  })

  it('surfaces command_in_progress with Retry-After seconds from body', () => {
    const e = apiError(409, 'command_in_progress', 'same_request', {
      sameRequestRetrySafe: true,
      retryAfterSeconds: 2,
    })
    expect(e.isCommandInProgress).toBe(true)
    expect(e.sameRequestRetrySafe).toBe(true)
    expect(e.retryAfterSeconds).toBe(2)
  })

  it('flags authentication_required and csrf_failed for session recovery', () => {
    const auth = apiError(401, 'authentication_required', 'user_action')
    expect(auth.isAuthRequired).toBe(true)

    const csrf = apiError(403, 'csrf_failed', 'user_action')
    expect(csrf.isCsrfFailed).toBe(true)
  })

  it('does not treat verification_required as a signed-out auth-required error', () => {
    const occupancy = apiError(403, 'verification_required', 'user_action')
    expect(occupancy.isAuthRequired).toBe(false)
    expect(occupancy.isVerificationRequired).toBe(true)
    expect(occupancy.status).toBe(403)

    const signedOut = apiError(401, 'authentication_required', 'user_action')
    expect(signedOut.isAuthRequired).toBe(true)
    expect(signedOut.isVerificationRequired).toBe(false)
  })

  it('handles drifted ProductErrorCode values in recovery helpers', () => {
    const credentials = apiError(401, 'invalid_credentials', 'user_action')
    expect(credentials.code).toBe('invalid_credentials')
    expect(recoveryStrategyFor(credentials)).toBe('show_message')

    const conflict = apiError(409, 'mutation_conflict', 'user_action')
    expect(conflict.code).toBe('mutation_conflict')
    expect(recoveryStrategyFor(conflict)).toBe('show_message')
    expect(recoveryStrategyFor(conflict)).not.toBe('refresh_and_retry')

    expect(recoveryStrategyFor(apiError(403, 'verification_required', 'user_action'))).toBe(
      'show_message',
    )
  })

  it('builds a stable error for non-envelope / transport failures', () => {
    const e = new ProductApiError(500, null, 'upstream boom')
    expect(e).toBeInstanceOf(Error)
    expect(isProductApiError(e)).toBe(true)
    expect(e.status).toBe(500)
    expect(e.code).toBe('unknown_error')
    expect(e.sameRequestRetrySafe).toBe(true)

    const net = new ProductApiError(0, null, 'Network error')
    expect(net.code).toBe('transport_error')
    expect(net.sameRequestRetrySafe).toBe(true)
  })
})

describe('recoveryStrategyFor', () => {
  it('maps precondition_failed to refresh_and_retry', () => {
    expect(recoveryStrategyFor(apiError(412, 'precondition_failed', 'refresh_and_retry'))).toBe(
      'refresh_and_retry',
    )
  })

  it('maps snapshot_expired / invalid_cursor to restart_editor_from_first_page', () => {
    expect(recoveryStrategyFor(apiError(409, 'snapshot_expired', 'restart_from_first_page'))).toBe(
      'restart_editor_from_first_page',
    )
    expect(recoveryStrategyFor(apiError(400, 'invalid_cursor', 'restart_from_first_page'))).toBe(
      'restart_editor_from_first_page',
    )
  })

  it('maps command_in_progress to retry_same_command', () => {
    expect(
      recoveryStrategyFor(
        apiError(409, 'command_in_progress', 'same_request', { sameRequestRetrySafe: true }),
      ),
    ).toBe('retry_same_command')
  })

  it('maps command_result_expired / command_id_reused to new_user_intent', () => {
    expect(recoveryStrategyFor(apiError(410, 'command_result_expired', 'user_action'))).toBe(
      'new_user_intent',
    )
    expect(recoveryStrategyFor(apiError(409, 'command_id_reused', 'user_action'))).toBe(
      'new_user_intent',
    )
  })

  it('maps authentication_required to require_login and csrf_failed to rebootstrap_session', () => {
    expect(recoveryStrategyFor(apiError(401, 'authentication_required', 'user_action'))).toBe(
      'require_login',
    )
    expect(recoveryStrategyFor(apiError(403, 'csrf_failed', 'user_action'))).toBe(
      'rebootstrap_session',
    )
  })

  it('maps folder_not_empty to user_confirm_recursive', () => {
    expect(recoveryStrategyFor(apiError(409, 'folder_not_empty', 'user_action'))).toBe(
      'user_confirm_recursive',
    )
  })

  it('prefers code-based strategy over a mismatched envelope recovery field', () => {
    // Malformed/stale clients may send wrong recovery; code wins for known codes.
    expect(recoveryStrategyFor(apiError(409, 'command_id_reused', 'same_request'))).toBe(
      'new_user_intent',
    )
  })
})
