// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomNav } from './BottomNav'
import { TopNav } from './TopNav'
import { cleanup, mountTree } from '../test/render'
import { publishAutomationPause, publishAutomationUnavailable, resetAutomationStatus } from '../lib/automationStatus'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Dev User', handle: 'dev', email: 'dev@example.test', initials: 'DU', accountId: 'account-1', profileId: 'profile-1' },
    isLoggedIn: true,
    logout: vi.fn().mockResolvedValue('signed-out'),
  }),
}))
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('./SearchPalette', () => ({ SearchPalette: () => null }))

const pause = (paused: boolean) => ({ paused, pausedAt: paused ? '2026-10-12T09:00:00.000Z' : null, pausedBy: paused ? 'owner' as const : null, revision: '2', heldJobs: 0 })

function primaryLabels(): string[] {
  return [...document.querySelectorAll('nav[aria-label="Primary"] a')].map((link) => link.textContent ?? '')
}

describe('Automations navigation', () => {
  beforeEach(() => {
    resetAutomationStatus()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    resetAutomationStatus()
  })

  it('stays out of the nav until the server says it has automations', () => {
    mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
    expect(primaryLabels()).toEqual(['Library', 'Sync', 'Agents', 'Approvals'])
    act(() => publishAutomationUnavailable())
    expect(primaryLabels()).toEqual(['Library', 'Sync', 'Agents', 'Approvals'])
  })

  it('sits next to Agents and shows Paused on every page while everything is paused (AC-44)', () => {
    mountTree(<MemoryRouter><TopNav /><BottomNav /></MemoryRouter>)
    act(() => publishAutomationPause(pause(false)))
    expect(primaryLabels()).toEqual(['Library', 'Sync', 'Automations', 'Agents', 'Approvals'])
    expect(document.querySelector('[data-testid="automations-paused-flag"]')).toBeNull()

    act(() => publishAutomationPause(pause(true)))
    expect(primaryLabels()).toContain('AutomationsPaused')
    const tab = document.querySelector<HTMLAnchorElement>('nav[aria-label="Mobile primary"] a[href="/automations"]')
    expect(tab?.textContent).toContain('paused')

    act(() => publishAutomationPause(pause(false)))
    expect(document.querySelector('[data-testid="automations-paused-flag"]')).toBeNull()
  })
})
