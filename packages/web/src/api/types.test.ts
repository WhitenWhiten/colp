/**
 * C-12: ProductErrorCode is generated OpenAPI enum ∪ drifted wire codes.
 * Production: src/api/types.ts
 *
 * The union membership is a *type-level* contract and TypeScript erases it at
 * runtime, so the strongest enforcement is the `satisfies` below — it fails
 * `npm run typecheck` the moment a drifted code stops being a member, which a
 * text scan of the declaring file cannot guarantee (a literal left behind in
 * a comment would keep such a scan green). What a test *can* prove at runtime
 * is that each drifted code survives the error pipeline and is classified by
 * the app rather than collapsing into `unknown_error`; that half is exercised
 * below against the real parser and recovery strategy.
 */
import { describe, expect, it } from 'vitest'
import { ProductApiError, parseProductError, recoveryStrategyFor } from './errors'
import type { components } from '../generated/product-v1'
import type { ProductErrorCode } from './types'
import typesSource from './types.ts?raw'
import { productErrorBody } from './test-helpers'

type GeneratedProductErrorCode = components['schemas']['ProductErrorCode']

/** ADR-0015: occupancy is a drifted wire code, not in the published OpenAPI enum. */
type OccupancyInGeneratedEnum = 'verification_required' extends GeneratedProductErrorCode ? true : false
const occupancyIsDrifted: OccupancyInGeneratedEnum = false

type InvalidRequestInGeneratedEnum = 'invalid_request' extends GeneratedProductErrorCode ? true : false
const invalidRequestIsGenerated: InvalidRequestInGeneratedEnum = true

const driftedWireCodes = [
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
] as const satisfies readonly ProductErrorCode[]

/* The status each drifted code arrives on over the wire. */
const driftedWireCodeStatus: Record<(typeof driftedWireCodes)[number], number> = {
  handle_taken: 409,
  invalid_handle: 422,
  invalid_display_name: 422,
  invalid_about: 422,
  mutation_conflict: 409,
  not_acceptable: 406,
  invalid_credentials: 401,
  verification_required: 403,
  account_link_required: 409,
  email_delivery_unavailable: 503,
}

describe('ProductErrorCode wire union', () => {
  it('unions generated OpenAPI enum with drifted wire codes (ADR-0015)', () => {
    /* The drifted union is documented with its ADR… */
    expect(typesSource).toContain('ADR-0015')
    /* …and the exported union is composed of the generated enum plus it. */
    expect(typesSource).toMatch(
      /export type ProductErrorCode = Schemas\['ProductErrorCode'\] \| DriftedProductErrorCode/,
    )
    /* Type-level membership (enforced by `npm run typecheck`). */
    const occupancy: ProductErrorCode = 'verification_required'
    expect(occupancy).toBe('verification_required')
    expect(occupancyIsDrifted).toBe(false)
    expect(invalidRequestIsGenerated).toBe(true)
  })

  it('surfaces every drifted wire code through the runtime error pipeline', () => {
    for (const code of driftedWireCodes) {
      const status = driftedWireCodeStatus[code]
      const parsed = parseProductError(status, productErrorBody({ code }))
      expect(parsed.code, code).toBe(code)
      const error = new ProductApiError(parsed)
      expect(error.code, code).toBe(code)
      /* A drifted code reaches the UI as itself, with a recovery strategy —
         never as the generic unknown fallback. */
      expect(error.code, code).not.toBe('unknown_error')
      expect(error.status, code).toBe(status)
      expect(recoveryStrategyFor(error), code).toBeTruthy()
    }
  })

  it('keeps verification_required out of the signed-out auth-required path', () => {
    /* Login toasts this drifted code, so it must not be mistaken for an
       expired session and bounce the user to the sign-in redirect. */
    const occupancy = new ProductApiError(parseProductError(403, productErrorBody({ code: 'verification_required' })))
    expect(occupancy.isAuthRequired).toBe(false)
    expect(occupancy.isVerificationRequired).toBe(true)
    const signedOut = new ProductApiError(parseProductError(401, productErrorBody({ code: 'authentication_required' })))
    expect(signedOut.isAuthRequired).toBe(true)
    expect(signedOut.isVerificationRequired).toBe(false)
  })
})
