// @vitest-environment happy-dom
/* App shell boundary: the route table.
 *
 * Behaviour — mount the real <App /> at a URL and observe where the router
 * lands and which page element renders. That covers the aliases (/dashboard ->
 * /library, /mcp -> /agents, /settings -> the settings dialog), the routes that
 * must resolve from the app shell, and the hosted-service URLs this server does
 * not serve, which must land on the 404 page. Every page that could render is
 * stubbed with its own test id, so "this page did not render at this URL" is
 * an observation rather than a source scan.
 *
 * Architecture — the one claim no visit can falsify: Landing stays in the main
 * graph while the routed pages are code-split.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import appSource from './App.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from './test/render'

vi.mock('./pages/WriteApprovals', async () => {
  const React = await import('react')
  return { WriteApprovals: () => React.createElement('div', { 'data-testid': 'write-approvals-route' }) }
})
vi.mock('./pages/Consent', async () => {
  const React = await import('react')
  return { Consent: () => React.createElement('div', { 'data-testid': 'consent-route' }) }
})
vi.mock('./pages/Library', async () => {
  const React = await import('react')
  return { Library: () => React.createElement('div', { 'data-testid': 'library-route' }) }
})
vi.mock('./pages/Agents', async () => {
  const React = await import('react')
  return { Agents: () => React.createElement('div', { 'data-testid': 'agents-route' }) }
})
vi.mock('./pages/NotFound', async () => {
  const React = await import('react')
  return { NotFound: () => React.createElement('div', { 'data-testid': 'not-found-route' }) }
})
vi.mock('./components/Layout', async () => {
  const React = await import('react')
  const { Outlet } = await import('react-router-dom')
  return { Layout: () => React.createElement(Outlet) }
})

/* Hosted-service routes this server does not serve. */
const notServed = [
  '/explore',
  '/today',
  '/feed',
  '/notifications',
  '/updates',
  '/classify',
  '/onboarding',
  '/creator',
  '/credits',
  '/u/ada',
  '/read/node-1',
  '/share/llm-path',
  '/reports/weekly',
  '/demo/dashboard',
  '/demos',
] as const

describe('App route table', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  async function renderAt(path: string) {
    window.history.pushState({}, '', path)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mountTree(<App />)
    await waitForDom(domFinishedLoading)
    await waitForDom(domFinishedLoading)
  }

  function currentUrl() {
    return `${window.location.pathname}${window.location.search}`
  }

  it('renders the Write approvals page for a plan link', async () => {
    await renderAt('/approvals/plan-1')
    expect(document.querySelector('[data-testid="write-approvals-route"]')).not.toBeNull()
  })

  it('renders the Consent page', async () => {
    await renderAt('/consent')
    expect(document.querySelector('[data-testid="consent-route"]')).not.toBeNull()
  })

  it('redirects /dashboard to the library', async () => {
    await renderAt('/dashboard')
    expect(currentUrl()).toBe('/library')
    expect(document.querySelector('[data-testid="library-route"]')).not.toBeNull()
  })

  it('redirects /mcp to the agents page', async () => {
    await renderAt('/mcp')
    expect(currentUrl()).toBe('/agents')
    expect(document.querySelector('[data-testid="agents-route"]')).not.toBeNull()
  })

  it('opens the collection for an old Collaborators link while sharing waits for multi-user', async () => {
    await renderAt('/library/col-1/collaborators')
    expect(currentUrl()).toBe('/library/col-1')
    expect(document.querySelector('[data-testid="library-route"]')).not.toBeNull()
  })

  it('turns /settings#section into the library with that settings section open', async () => {
    await renderAt('/settings#security')
    expect(currentUrl()).toBe('/library?settings=security')
    expect(document.querySelector('[data-testid="library-route"]')).not.toBeNull()
  })

  it.each(notServed)('lands %s on the 404 page', async (path) => {
    await renderAt(path)
    expect(document.querySelector('[data-testid="not-found-route"]')).not.toBeNull()
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps the Landing page eager and the routed pages code-split', () => {
    /* A static import and `lazy()` produce the same DOM; the difference is only
       which chunk a first paint waits on, so the claim is asserted on the
       import form. */
    expect(appSource).toMatch(/import\s*\{\s*Landing\s*\}\s*from\s*['"]\.\/pages\/Landing['"]/u)
    expect(appSource).not.toMatch(/import\(['"]\.\/pages\/Landing['"]\)/u)
    expect(appSource).not.toMatch(/^import .* from ['"]\.\/pages\/(?!Landing['"])/mu)
    expect(appSource).toMatch(/const Library = lazyWithRetry\(/u)
  })
})
