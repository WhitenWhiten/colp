// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi, listAgents } from '../../api/agentsClient'
import type { OwnedCollectionListItem } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { GetStarted, getStartedHidden, type GetStartedProbes } from './GetStarted'

function owned(visibility: 'private' | 'unlisted' | 'public', bookmarkCount: number): OwnedCollectionListItem {
  return { collection: { id: `c-${visibility}`, visibility }, bookmarkCount } as unknown as OwnedCollectionListItem
}

const none: GetStartedProbes = { hasBrowser: async () => false, hasAgent: async () => false }

describe('GetStarted', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  async function render(collections: OwnedCollectionListItem[], probes: GetStartedProbes = none) {
    await act(async () => {
      mountTree(
        <MemoryRouter>
          <GetStarted collections={collections} shareTo="/library/c-private?collection=edit" probes={probes} />
        </MemoryRouter>,
      )
    })
  }

  const doneSteps = () => [...document.querySelectorAll('[data-testid="get-started"] li[data-done] h3')].map((h) => h.textContent)

  it('ticks steps from the collections and the browser and agent probes', async () => {
    await render([owned('private', 3)], { hasBrowser: async () => true, hasAgent: async () => false })
    await waitForDom(() => doneSteps().includes('Connect a browser'))
    expect(doneSteps()).toEqual(['Create a collection', 'Bring in your bookmarks', 'Connect a browser'])
    expect(document.body.textContent).toContain('3 of 5')
    expect(document.querySelector('a[href="/agents"]')?.textContent).toBe('Connect')
    expect(document.querySelector('a[href="/library/c-private?collection=edit"]')?.textContent).toBe('Share')
  })

  it('recognizes a connected Codex CIMD client through the default agent probe', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({
      agents: [{ id: 'https://chatgpt.com/oauth/codex/client.json', name: 'Codex', kind: 'oauth_client',
        scopes: ['nodes:read'], createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: null, policy: 'manual' }],
    })))
    vi.spyOn(agentsApi, 'listAgents').mockImplementation((signal) => listAgents({ signal, fetch }))
    await act(async () => {
      mountTree(<MemoryRouter><GetStarted collections={[]} shareTo={null} /></MemoryRouter>)
    })
    await waitForDom(() => doneSteps().includes('Connect an AI agent'))
    expect(document.querySelector('a[href="/agents"]')).toBeNull()
    expect(fetch).toHaveBeenCalled()
  })

  it('refreshes external connections on focus and ignores the older pending response', async () => {
    const pending: ((value: boolean) => void)[] = []
    const hasAgent = vi.fn<GetStartedProbes['hasAgent']>(() => new Promise((resolve) => { pending.push(resolve) }))
    await render([], { hasBrowser: async () => false, hasAgent })
    expect(doneSteps()).not.toContain('Connect an AI agent')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { pending.at(-1)!(true) })
    await waitForDom(() => doneSteps().includes('Connect an AI agent'))
    await act(async () => { pending.slice(0, -1).forEach((finish) => finish(false)) })
    expect(doneSteps()).toContain('Connect an AI agent')
    expect(hasAgent.mock.calls[0]?.[0].aborted).toBe(true)
    const latestSignal = hasAgent.mock.calls.at(-1)![0]
    const callsBeforeUnmount = hasAgent.mock.calls.length
    cleanup()
    expect(latestSignal.aborted).toBe(true)
    window.dispatchEvent(new Event('focus'))
    expect(hasAgent).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('refreshes when returning to a visible tab', async () => {
    let connected = false
    const hasAgent = vi.fn<GetStartedProbes['hasAgent']>(async () => connected)
    await render([], { hasBrowser: async () => false, hasAgent })
    const callsBeforeReturn = hasAgent.mock.calls.length
    connected = true
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(hasAgent).toHaveBeenCalledTimes(callsBeforeReturn)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitForDom(() => doneSteps().includes('Connect an AI agent'))
    expect(hasAgent).toHaveBeenCalledTimes(callsBeforeReturn + 1)
  })

  it('counts a published collection as shared and remembers a finished checklist', async () => {
    await render([owned('public', 1)], { hasBrowser: async () => true, hasAgent: async () => true })
    await waitForDom(() => document.body.textContent?.includes('5 of 5') === true)
    expect(document.querySelector('#get-started-title')?.textContent).toBe('COLP Server is ready')
    expect(getStartedHidden()).toBe(true)
  })

  it('hides for good when dismissed', async () => {
    await render([])
    expect(getStartedHidden()).toBe(false)
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Hide the setup checklist"]')!.click())
    expect(document.querySelector('[data-testid="get-started"]')).toBeNull()
    expect(getStartedHidden()).toBe(true)
  })
})
