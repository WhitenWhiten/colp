// @vitest-environment happy-dom
import { act, lazy, useEffect, type ComponentType } from 'react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from './Layout'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { useDocumentTitle } from '../lib/useDocumentTitle'

vi.mock('../auth/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: null,
    isLoggedIn: false,
    logout: async () => {},
  }),
}))

describe('Layout internal link interceptor', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('lets React onClick on an internal Link run', async () => {
    const onClick = vi.fn()
    mountTree(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Layout />}>
              <Route
                index
                element={(
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the test subject is a react-router Link (native anchor); Enter fires onClick natively
                  <Link to="/library" data-testid="internal-link" onClick={onClick}>
                    Go
                  </Link>
                )}
              />
              <Route path="library" element={<div>Library</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )

    const link = document.querySelector<HTMLAnchorElement>('[data-testid="internal-link"]')!
    await act(async () => {
      link.click()
      await Promise.resolve()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Layout share embed mode', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  function renderAt(path: string) {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="share/:slug" element={<div>Share page</div>} />
              <Route path="reports/:slug" element={<div>Digest page</div>} />
              <Route path="reports/:slug/issues/:editionId" element={<div>Issue page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
  }

  it('hides the topnav, footer, and skip link for /share/:slug?embed=1', () => {
    renderAt('/share/llm-learning-path?embed=1')

    expect(document.querySelector('header')).toBeNull()
    expect(document.querySelector('footer')).toBeNull()
    expect(document.querySelector('a[href="#main"]')).toBeNull()
    expect(document.querySelector('[aria-label="Mobile primary"]')).toBeNull()
    expect(document.querySelector('#main')?.closest('.app-shell')?.classList.contains('app-shell--tabs')).toBe(false)
    expect(document.querySelector('#main')?.textContent).toContain('Share page')
  })

  it.each(['/reports/weekly?embed=1', '/reports/weekly/issues/issue-1?embed=1'])('strips chrome for %s', path => {
    renderAt(path)
    expect(document.querySelector('header')).toBeNull()
    expect(document.querySelector('footer')).toBeNull()
    expect(document.querySelector('a[href="#main"]')).toBeNull()
  })

  it('keeps the chrome on the normal share page', () => {
    renderAt('/share/llm-learning-path')

    expect(document.querySelector('header')).not.toBeNull()
    expect(document.querySelector('footer')).not.toBeNull()
    expect(document.querySelector('[aria-label="Mobile primary"]')).not.toBeNull()
    expect(document.querySelector('#main')?.closest('.app-shell')?.classList.contains('app-shell--tabs')).toBe(true)
  })
})

describe('Layout mobile tab bar gating', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  function renderAt(path: string) {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>Home</div>} />
              <Route path="login" element={<div>Login</div>} />
              <Route path="explore" element={<div>Explore</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
  }

  it('does not mount the tab bar or tabs padding on auth routes', () => {
    renderAt('/login')
    expect(document.querySelector('[aria-label="Mobile primary"]')).toBeNull()
    expect(document.querySelector('#main')?.closest('.app-shell')?.classList.contains('app-shell--tabs')).toBe(false)
  })

  it('mounts a guest tab bar without workbench channels', () => {
    renderAt('/explore')
    const tabs = document.querySelector('[aria-label="Mobile primary"]')
    expect(tabs).not.toBeNull()
    expect(tabs?.querySelector('a[href="/explore"]')).not.toBeNull()
    expect(tabs?.querySelector('a[href^="/login"]')).not.toBeNull()
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(document.querySelector('a[href="/library"]')).toBeNull()
    expect(document.querySelector('a[href="/notifications"]')).toBeNull()
  })
})

describe('Layout route focus and announcement', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    document.title = 'Know-N'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('moves focus to main and announces the new title after a route change', async () => {
    function Page({ title }: { title: string }) {
      useDocumentTitle(title)
      return (
        <div>
          <p>{title}</p>
          <Link to="/library" data-testid="to-library">
            Library
          </Link>
        </div>
      )
    }

    mountTree(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Page title="Home" />} />
              <Route path="library" element={<Page title="Library" />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )

    const main = document.querySelector('#main')!
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).not.toBe(main)

    await act(async () => {
      document.querySelector<HTMLAnchorElement>('[data-testid="to-library"]')!.click()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(document.querySelector('#main'))
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Library')
  })

  it('announces a lazy route by its own title, not the stale one restored on the way out (R15-37)', async () => {
    function Page({ title, to }: { title: string; to?: string }) {
      useDocumentTitle(title)
      return <div><p>{title}</p>{to ? <Link to={to} data-testid="go">go</Link> : null}</div>
    }
    let resolveExplore!: (module: { default: ComponentType }) => void
    const LazyExplore = lazy(() => new Promise<{ default: ComponentType }>((resolve) => { resolveExplore = resolve }))

    mountTree(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Page title="Home" to="/explore" />} />
              <Route path="explore" element={<LazyExplore />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )

    await act(async () => {
      document.querySelector<HTMLAnchorElement>('[data-testid="go"]')!.click()
      await Promise.resolve()
    })
    // The chunk is still loading: Home's cleanup restored an older title,
    // which must not be announced.
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('')
    await act(async () => {
      resolveExplore({ default: () => <Page title="Explore" /> })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => document.querySelector('[aria-live="polite"]')?.textContent === 'Explore')
  })

  it('focuses main without scrolling when returning to the landing page', async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')

    function Page({ title, to, testId }: { title: string; to: string; testId: string }) {
      useDocumentTitle(title)
      return (
        <div>
          <p>{title}</p>
          <Link to={to} data-testid={testId}>
            {to}
          </Link>
        </div>
      )
    }

    try {
      mountTree(
          <MemoryRouter initialEntries={['/explore']}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Page title="Home" to="/explore" testId="to-explore" />} />
                <Route path="explore" element={<Page title="Explore" to="/" testId="to-home" />} />
              </Route>
            </Routes>
          </MemoryRouter>,
        )

      focusSpy.mockClear()

      await act(async () => {
        document.querySelector<HTMLAnchorElement>('[data-testid="to-home"]')!.click()
        await Promise.resolve()
      })

      expect(document.activeElement).toBe(document.querySelector('#main'))
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
    } finally {
      focusSpy.mockRestore()
    }
  })
})
