import { describe, expect, it } from 'vitest'
import {
  featureFlagsForEdition,
  isSelfHostedPathEnabled,
  parseRegistrationState,
  registrationView,
} from './edition'

describe('self-hosted edition paths', () => {
  it('keeps every path when the edition is unset', () => {
    expect(isSelfHostedPathEnabled('/explore')).toBe(true)
    expect(isSelfHostedPathEnabled('/library')).toBe(true)
    expect(isSelfHostedPathEnabled('/notifications')).toBe(true)
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

describe('featureFlagsForEdition', () => {
  it('turns cloud flags off and leaves library flags alone', () => {
    const flags = { follow: true, community: true, sync: true, import: true, writeApprovals: true }
    expect(featureFlagsForEdition(flags, undefined)).toEqual(flags)
    expect(featureFlagsForEdition(flags, 'self-hosted')).toEqual({
      follow: false,
      community: false,
      sync: true,
      import: true,
      writeApprovals: true,
    })
  })
})
