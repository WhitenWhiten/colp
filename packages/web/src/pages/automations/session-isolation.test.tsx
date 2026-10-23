// @vitest-environment happy-dom
import { act } from 'react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { applySessionView, clearSession } from '../../api/sessionStore'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { deps, fakeApi, rule } from './automations.test-helper'
import { useLoad } from './shared'

vi.mock('../../components/AppToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }) }))
afterEach(() => { cleanup(); clearSession() })
const signIn = (csrfToken: string) => applySessionView({ authenticated: true, csrfToken, idleExpiresAt: '', absoluteExpiresAt: '' })

it('retires private rules and pagination when the session is cleared on the same route', async () => {
  signIn('account-a')
  const api = fakeApi()
  api.listRules.mockResolvedValue({ items: [rule('private-a', 'Account A private rule')], nextCursor: 'private-cursor' })
  renderWithRouter(<Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>, { route: '/automations' })
  await waitForDom(() => document.body.textContent?.includes('Account A private rule') === true)
  api.listRules.mockResolvedValue({ items: [], nextCursor: null })
  await act(async () => clearSession())
  expect(document.body.textContent).not.toContain('Account A private rule')
  expect(document.body.innerHTML).not.toContain('private-cursor')
})

it('discards a late response and a saved replace callback from a retired identity', async () => {
  signIn('a')
  let finish!: (data: string) => void
  let replace!: (data: string) => void
  const load = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  function Harness() {
    const value = useLoad('same-key', load); replace = value.replace
    return <div>{value.state.status === 'ready' ? value.state.data : 'loading'}</div>
  }
  renderWithRouter(<Harness />, { strict: false })
  const oldFinish = finish, oldReplace = replace
  await act(async () => signIn('b'))
  await act(async () => { oldFinish('A private response'); oldReplace('A private mutation') })
  expect(document.body.textContent).not.toContain('A private')
  await act(async () => finish('B response'))
  expect(document.body.textContent).toContain('B response')
})
