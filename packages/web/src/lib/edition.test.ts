import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandedTitle,
  featureFlagsForEdition,
  isSelfHostedPathEnabled,
  productName,
  parseRegistrationState,
  registrationView,
} from './edition'
import { isSettingsSectionAvailable } from './useSettingsDialog'

describe('self-hosted edition paths', () => {
  it('keeps every path when the edition is unset', () => {
    expect(isSelfHostedPathEnabled('/explore')).toBe(true)
    expect(isSelfHostedPathEnabled('/library')).toBe(true)
    expect(isSelfHostedPathEnabled('/notifications')).toBe(true)
  })

  describe('self-hosted', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('hides know-n.com documents and keeps the library', () => {
      vi.stubEnv('VITE_EDITION', 'self-hosted')
      for (const path of ['/privacy', '/contact', '/embed-guide', '/notifications', '/explore']) {
        expect(isSelfHostedPathEnabled(path)).toBe(false)
      }
      expect(isSelfHostedPathEnabled('/library')).toBe(true)
      expect(isSelfHostedPathEnabled('/about')).toBe(true)
    })

    it('hides settings sections for modules the server does not ship', () => {
      vi.stubEnv('VITE_EDITION', 'self-hosted')
      expect(isSettingsSectionAvailable('notifications')).toBe(false)
      expect(isSettingsSectionAvailable('privacy')).toBe(false)
      expect(isSettingsSectionAvailable('favicon')).toBe(false)
      expect(isSettingsSectionAvailable('profile')).toBe(true)
      expect(isSettingsSectionAvailable('security')).toBe(true)
    })

    it('does not mount export jobs, onboarding, or the mailed flows', () => {
      vi.stubEnv('VITE_EDITION', 'self-hosted')
      for (const path of ['/export', '/onboarding', '/reset-password', '/verify-email', '/creator', '/credits']) {
        expect(isSelfHostedPathEnabled(path)).toBe(false)
      }
      expect(isSelfHostedPathEnabled('/login')).toBe(true)
      expect(isSelfHostedPathEnabled('/extension')).toBe(true)
    })

    it('names the product COLP Server in visible text and titles', () => {
      vi.stubEnv('VITE_EDITION', 'self-hosted')
      expect(productName()).toBe('COLP Server')
      expect(brandedTitle('Library')).toBe('Library — COLP Server')
      expect(brandedTitle('')).toBe('COLP Server')
    })
  })

  it('keeps the Know-N name when the edition is unset', () => {
    expect(productName()).toBe('Know-N')
    expect(brandedTitle('Library')).toBe('Library — Know-N')
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
