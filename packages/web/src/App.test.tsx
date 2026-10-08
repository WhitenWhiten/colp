// @vitest-environment happy-dom
/* App shell boundary: the route table.
 *
 * Behaviour — mount the real <App /> at a URL and observe where the router
 * lands and which page element renders. That covers the aliases (/updates,
 * /demo/updates -> the collection notifications filter, /dashboard -> /today),
 * the product routes that must resolve from the app shell, the demo sandboxes
 * that must stay reachable, and the demo boundary itself: a live page must NOT
 * render under /demo, and an unknown /demo URL must land on the 404 page. Every
 * page that could render is stubbed with its own test id, so "this page did not
 * render at this URL" is an observation rather than a source scan.
 *
 * Architecture — claims about the route *table* that no single visit can
 * falsify: which route patterns exist in the product branch, that the demo
 * branch stays mock-only with its own catch-all, and that Landing stays in the
 * main graph while Explore is code-split. A route that no test visits still
 * matches URLs, and a deleted anchor would otherwise silently shrink the text
 * being scanned, so the split is anchored and its two halves are asserted
 * non-empty.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import appSource from './App.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from './test/render'

/* Each page that a URL can reach is stubbed with a distinguishable test id, so
   a route-tree probe can tell "this page rendered" from "something else did".
   The stubs are also what makes the demo-boundary probes meaningful: without
   them a mirrored live page would render its real tree and the probe would be
   asserting on production behaviour instead of route ownership. */
vi.mock('./pages/WriteApprovals', async () => {
  const React = await import('react')
  return {
    WriteApprovals: () => React.createElement('div', { 'data-testid': 'write-approvals-route' }),
  }
})
vi.mock('./pages/Consent', async () => {
  const React = await import('react')
  return {
    Consent: () => React.createElement('div', { 'data-testid': 'consent-route' }),
  }
})
vi.mock('./pages/Notifications', async () => {
  const React = await import('react')
  return {
    Notifications: () => React.createElement('div', { 'data-testid': 'notifications-route' }),
  }
})
vi.mock('./pages/Today', async () => {
  const React = await import('react')
  return { Today: () => React.createElement('div', { 'data-testid': 'live-today' }) }
})
vi.mock('./pages/Explore', async () => {
  const React = await import('react')
  return { Explore: () => React.createElement('div', { 'data-testid': 'live-explore' }) }
})
vi.mock('./pages/Search', async () => {
  const React = await import('react')
  return { Search: () => React.createElement('div', { 'data-testid': 'live-search' }) }
})
vi.mock('./pages/Feed', async () => {
  const React = await import('react')
  return { Feed: () => React.createElement('div', { 'data-testid': 'live-feed' }) }
})
vi.mock('./pages/Sync', async () => {
  const React = await import('react')
  return { Sync: () => React.createElement('div', { 'data-testid': 'live-sync' }) }
})
vi.mock('./pages/Classify', async () => {
  const React = await import('react')
  return { Classify: () => React.createElement('div', { 'data-testid': 'live-classify' }) }
})
vi.mock('./pages/Import', async () => {
  const React = await import('react')
  return { Import: () => React.createElement('div', { 'data-testid': 'live-import' }) }
})
vi.mock('./pages/Onboarding', async () => {
  const React = await import('react')
  return { Onboarding: () => React.createElement('div', { 'data-testid': 'live-onboarding' }) }
})
vi.mock('./pages/Creator', async () => {
  const React = await import('react')
  return { Creator: () => React.createElement('div', { 'data-testid': 'live-creator' }) }
})
vi.mock('./pages/Dashboard', async () => {
  const React = await import('react')
  return { Dashboard: () => React.createElement('div', { 'data-testid': 'live-dashboard' }) }
})
vi.mock('./pages/AiChat', async () => {
  const React = await import('react')
  return { AiChat: () => React.createElement('div', { 'data-testid': 'live-ai-chat' }) }
})
vi.mock('./pages/LibraryEdit', async () => {
  const React = await import('react')
  return { LibraryEdit: () => React.createElement('div', { 'data-testid': 'live-library-edit' }) }
})
vi.mock('./pages/NotFound', async () => {
  const React = await import('react')
  return { NotFound: () => React.createElement('div', { 'data-testid': 'not-found-route' }) }
})
vi.mock('./pages/ResourceDetail', async () => {
  const React = await import('react')
  return { ResourceDetail: () => React.createElement('div', { 'data-testid': 'resource-detail-route' }) }
})
vi.mock('./pages/Reader', async () => {
  const React = await import('react')
  return { Reader: () => React.createElement('div', { 'data-testid': 'reader-route' }) }
})
vi.mock('./components/Layout', async () => {
  const React = await import('react')
  const { Outlet } = await import('react-router-dom')
  return { Layout: () => React.createElement(Outlet) }
})

/* Live pages the demo tree deliberately does not mirror. The product map for
   those flows is DemoHub at /demos. */
const notMirroredUnderDemo = [
  { segment: 'explore', testId: 'live-explore' },
  { segment: 'today', testId: 'live-today' },
  { segment: 'search', testId: 'live-search' },
  { segment: 'feed', testId: 'live-feed' },
  { segment: 'notifications', testId: 'notifications-route' },
  { segment: 'sync', testId: 'live-sync' },
  { segment: 'classify', testId: 'live-classify' },
  { segment: 'import', testId: 'live-import' },
  { segment: 'onboarding', testId: 'live-onboarding' },
  { segment: 'creator', testId: 'live-creator' },
] as const

describe('Write approvals app route', () => {

  beforeEach(() => {
    window.history.pushState({}, '', '/approvals/plan-1')
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the Write approvals page from the app route', async () => {
    mountTree(<App />)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="write-approvals-route"]')).not.toBeNull()
  })
})

describe('Consent app route', () => {

  beforeEach(() => {
    window.history.pushState({}, '', '/consent')
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the Consent page from the app route', async () => {
    mountTree(<App />)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="consent-route"]')).not.toBeNull()
  })
})

describe('Updates merge into notifications', () => {

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  async function renderAt(path: string) {
    window.history.pushState({}, '', path)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mountTree(<App />)
    await waitForDom(domFinishedLoading)
    await waitForDom(domFinishedLoading)
  }

  it('replaces /updates with the collection notifications filter', async () => {
    await renderAt('/updates')
    expect(document.querySelector('[data-testid="notifications-route"]')).not.toBeNull()
    expect([...document.querySelectorAll('*')].some((el) => el.classList.contains('updates-page'))).toBe(false)
    expect(`${window.location.pathname}${window.location.search}`).toBe('/notifications?filter=collection')
  })

  it('replaces /demo/updates with the same live notifications filter', async () => {
    await renderAt('/demo/updates')
    expect(document.querySelector('[data-testid="notifications-route"]')).not.toBeNull()
    expect([...document.querySelectorAll('*')].some((el) => el.classList.contains('updates-page'))).toBe(false)
    expect(`${window.location.pathname}${window.location.search}`).toBe('/notifications?filter=collection')
  })
})

describe('Product and demo route tree behaviour', () => {

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  async function renderAt(path: string) {
    window.history.pushState({}, '', path)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mountTree(<App />)
    await waitForDom(domFinishedLoading)
    await waitForDom(domFinishedLoading)
  }

  it('redirects /dashboard to the Today page', async () => {
    await renderAt('/dashboard')
    expect(`${window.location.pathname}${window.location.search}`).toBe('/today')
    expect(document.querySelector('[data-testid="live-today"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="live-dashboard"]')).toBeNull()
  })

  it('redirects legacy Reader URLs to resource details while Reader is off', async () => {
    await renderAt('/read/node-1?collectionId=collection-1&subjectType=node#notes')
    await waitForDom(() => window.location.pathname === '/r/node-1')
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/r/node-1?collectionId=collection-1&subjectType=node#notes')
    expect(document.querySelector('[data-testid="resource-detail-route"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="reader-route"]')).toBeNull()
  })

  it('restores the Reader route when the shared exposure gate is enabled', async () => {
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    await renderAt('/read/node-1?collectionId=collection-1&subjectType=node')
    expect(window.location.pathname).toBe('/read/node-1')
    expect(document.querySelector('[data-testid="reader-route"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="resource-detail-route"]')).toBeNull()
  })

  it('keeps the dashboard sandbox reachable at /demo/dashboard without redirecting', async () => {
    await renderAt('/demo/dashboard')
    expect(window.location.pathname).toBe('/demo/dashboard')
    expect(document.querySelector('[data-testid="live-dashboard"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="live-today"]')).toBeNull()
  })

  it('keeps the demo editor sandbox reachable at /demo/library/:id/edit', async () => {
    await renderAt('/demo/library/col-1/edit')
    expect(document.querySelector('[data-testid="live-library-edit"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
  })

  it('keeps the seed-data chat sandbox reachable at /demo/ai/chat', async () => {
    await renderAt('/demo/ai/chat')
    expect(document.querySelector('[data-testid="live-ai-chat"]')).not.toBeNull()
  })

  it.each(notMirroredUnderDemo)(
    'does not mirror the live $segment page under /demo',
    async ({ segment, testId }) => {
      /* If a mirrored route existed, its live page would render here. The
         structural scan below covers a mirror pointing at some other
         component; this covers the case that actually matters. */
      await renderAt(`/demo/${segment}`)
      expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull()
      expect(document.querySelector('[data-testid="not-found-route"]')).not.toBeNull()
    },
  )

  it('lands unknown /demo URLs on the 404 page instead of an empty Outlet', async () => {
    await renderAt('/demo/not-a-sandbox')
    const host = document.getElementById('root')
    expect(document.querySelector('[data-testid="not-found-route"]')).not.toBeNull()
    /* An unmatched child renders an empty Outlet: the host would be empty. */
    expect(host?.firstElementChild).not.toBeNull()
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  /* The route table is split on its demo branch. Both halves are asserted
     non-empty: an anchor that stops matching would otherwise turn the product
     half into the whole file (loud) or the demo half into an empty string
     (silent, and every `not.toMatch` below would pass vacuously). */
  const demoBranch = /path=["']demo["']/u
  const splitRouteTable = () => {
    expect(appSource).toMatch(demoBranch)
    const parts = appSource.split(demoBranch)
    expect(parts.length).toBe(2)
    return { productTree: parts[0] ?? '', demoTree: parts[1] ?? '' }
  }

  it('keeps the Landing page eager and Explore code-split', () => {
    /* Both forms render identically: a static import and `lazy()` produce the
       same DOM, the difference is only which chunk a first paint waits on. The
       claim is about the module graph, so it is asserted on the import form. */
    expect(appSource).toMatch(/import\s*\{\s*Landing\s*\}\s*from\s*['"]\.\/pages\/Landing['"]/u)
    expect(appSource).not.toMatch(/import\(['"]\.\/pages\/Landing['"]\)/u)
    expect(appSource).toContain("await import('./pages/Explore')")
    expect(appSource).toMatch(/const Explore = lazyWithRetry\(/u)
  })

  it('keeps the mock editor and seed-data chat off the product Route tree', () => {
    const { productTree } = splitRouteTable()
    expect(productTree.length).toBeGreaterThan(0)
    expect(productTree).not.toMatch(/path=["']library\/demo\/:id\/edit["']/u)
    expect(productTree).not.toMatch(/path=["']ai\/chat["']/u)
    expect(productTree).toMatch(/path=["']dashboard["'] element=\{<Navigate to=["']\/today["']/u)
    expect(productTree).not.toMatch(/path=["']dashboard["'] element=\{<Dashboard/u)
  })

  it('keeps the demo tree mock-only with its own 404 catch-all', () => {
    const { demoTree } = splitRouteTable()
    expect(demoTree.length).toBeGreaterThan(0)
    // Live-API pages must not be mirrored under /demo — DemoHub (/demos) is
    // the product map for those flows.
    for (const mirrored of ['explore', 'today', 'search', 'feed', 'notifications', 'sync', 'classify', 'import', 'onboarding', 'creator']) {
      expect(demoTree).not.toMatch(new RegExp(`path=["']${mirrored}["']`, 'u'))
    }
    expect(demoTree).toMatch(/path=["']dashboard["']/u)
    expect(demoTree).not.toMatch(/path=["']library\/:(id|slug)\/(history|collaborators)["']/u)
    expect(demoTree).not.toMatch(/path=["']library\/health["']/u)
    // The mock sandboxes stay.
    expect(demoTree).toMatch(/path=["']library["']/u)
    expect(demoTree).toMatch(/path=["']library\/:id\/edit["']/u)
    expect(demoTree).toMatch(/path=["']ai\/chat["']/u)
    // Unknown /demo URLs land on a 404 instead of an empty Outlet.
    expect(demoTree).toMatch(/path=["']\*["'] element=\{<NotFound/u)
  })

  it('registers the app-level route tree with a demo branch and a product 404', () => {
    const { productTree } = splitRouteTable()
    expect(productTree).toMatch(/path=["']\*["'] element=\{<NotFound/u)
  })
})
