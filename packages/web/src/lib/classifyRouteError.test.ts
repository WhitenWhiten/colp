import { describe, expect, it } from 'vitest'
import { ProductApiError } from '../api/errors'
import { classifyRouteError } from './classifyRouteError'

describe('classifyRouteError', () => {
  it('maps 401 to auth', () => {
    expect(classifyRouteError(new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in',
    }))).toBe('auth')
  })

  it('maps 403 and insufficient_permission to forbidden', () => {
    expect(classifyRouteError(new ProductApiError({
      status: 403,
      code: 'forbidden',
      message: 'No access',
    }))).toBe('forbidden')
    expect(classifyRouteError(new ProductApiError({
      status: 409,
      code: 'insufficient_permission',
      message: 'Role too low',
    }))).toBe('forbidden')
  })

  it('maps feature 404 to unavailable', () => {
    expect(classifyRouteError(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'Not found',
    }))).toBe('unavailable')
  })

  it('maps other failures to error', () => {
    expect(classifyRouteError(new Error('network'))).toBe('error')
    expect(classifyRouteError(new ProductApiError({
      status: 500,
      code: 'internal_error',
      message: 'Broken',
    }))).toBe('error')
  })
})
