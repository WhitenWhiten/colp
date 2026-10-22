// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import type { AutomationAgentSetupResult } from '../../api/automationTypes'
import { applySessionView, clearSession } from '../../api/sessionStore'
import { agentSetupSession } from './agentSetupSession'

afterEach(() => { clearSession(); vi.useRealTimers() })

test('the one-use response survives a page remount but expires and cannot cross a session change', () => {
  vi.useFakeTimers()
  applySessionView({ authenticated: true, csrfToken: 'fixture-csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
  const result = { rule: { id: 'draft' }, pairing: { code: 'fixture-code', expiresAt: new Date(Date.now() + 1000).toISOString() } } as AutomationAgentSetupResult
  agentSetupSession.remember(result)
  expect(agentSetupSession.read('draft')).toBe(result)
  vi.advanceTimersByTime(1001)
  expect(agentSetupSession.read('draft')).toBeNull()
  agentSetupSession.remember({ ...result, pairing: null })
  clearSession()
  expect(agentSetupSession.read('draft')).toBeNull()
})
