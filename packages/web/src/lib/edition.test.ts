import { describe, expect, it } from 'vitest'
import {
  brandedTitle,
  productName,
  parseRegistrationState,
  registrationView,
} from './edition'

describe('product name', () => {
  it('names the product COLP Server in visible text and titles', () => {
    expect(productName()).toBe('COLP Server')
    expect(brandedTitle('Library')).toBe('Library — COLP Server')
    expect(brandedTitle('')).toBe('COLP Server')
  })
})

describe('registration state', () => {
  it('shows sign-up only when open is true', () => {
    expect(registrationView({ open: true, reason: 'first-run' })).toBe('owner')
    expect(registrationView({ open: true, reason: 'invite' })).toBe('invite')
    expect(registrationView({ open: false, reason: 'first-run' })).toBe('closed')
    expect(registrationView({ open: false, reason: 'invite' })).toBe('closed')
    expect(registrationView({ open: false, reason: 'closed' })).toBe('closed')
    expect(registrationView({ open: true, reason: 'closed' })).toBe('closed')
  })

  it('rejects a body that is not the registration-state contract', () => {
    expect(parseRegistrationState({ open: true, reason: 'first-run' })).toEqual({
      open: true,
      reason: 'first-run',
    })
    expect(() => parseRegistrationState({ open: 'yes', reason: 'first-run' })).toThrow(/not understood/)
    expect(() => parseRegistrationState({ open: true, reason: 'public' })).toThrow(/not understood/)
    expect(() => parseRegistrationState(null)).toThrow(/not understood/)
  })
})
