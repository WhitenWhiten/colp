// @vitest-environment happy-dom
/* Trust pages.
 *
 * Three different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour (React) — each trust route renders the *shared* agent-public
 *    markdown through the shared converter: the panel's HTML is compared
 *    byte-for-byte with `splitAgentPublicMarkdown(<the real .md file>)`, so a
 *    hardcoded copy, a swapped document, or a changed converter all fail. This
 *    replaces the old "the page source contains `about.md?raw`" text scan,
 *    which a rename could break and a hardcoded copy could still satisfy.
 *
 * 2. Behaviour (routes) — the routes resolve to the trust pages rather than
 *    NotFound, with the documented contact/link facts on screen.
 *
 * 3. Static generated HTML — `public/*.html` are build artifacts, not source
 *    modules. There is no running code behind them in vitest, so reading them
 *    from disk is the only available probe and is kept as such.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { splitAgentPublicMarkdown } from '../lib/agentPublicMarkdown'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

vi.mock('../components/Layout', async () => {
  const React = await import('react')
  const { Outlet } = await import('react-router-dom')
  return { Layout: () => React.createElement(Outlet) }
})

vi.mock('./NotFound', async () => {
  const React = await import('react')
  return {
    NotFound: () => React.createElement('div', { 'data-testid': 'not-found-route' }),
  }
})

const webRoot = resolve(import.meta.dirname, '../..')
const TRUST_PAGES = ['about', 'contact', 'privacy', 'mcp', 'developers', 'embed-guide', 'extension'] as const
/* The pages whose copy lives in the shared agent-public markdown. */
const MARKDOWN_PAGES = ['about', 'contact', 'privacy', 'mcp', 'developers', 'embed-guide'] as const

function readMarkdown(page: string): string {
  return readFileSync(resolve(webRoot, 'content', 'agent-public', `${page}.md`), 'utf8')
}

function visibleTextFromHtml(html: string): string {
  const withoutScript = html.replace(/<script\b[\s\S]*?<\/script>/giu, '')
  const withoutStyle = withoutScript.replace(/<style\b[\s\S]*?<\/style>/giu, '')
  return withoutStyle.replace(/<[^>]+>/gu, ' ')
}

/** The element carrying a markdown body, located by content rather than by a
 *  class selector — the wrap-owner class is itself under assertion. */
function renderedMarkdownPanels(bodyHtml: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('div')]
    .filter((element) => element.innerHTML === bodyHtml)
}

async function renderAt(path: string) {
  window.history.pushState({}, '', path)
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mountTree(<App />)
  // R15-27: trust routes are lazy chunks now; wait for the page itself.
  await waitForDom(() => document.querySelector('h1, [data-testid="not-found-route"]') !== null)
  await waitForDom(domFinishedLoading)
}

describe('generated trust-page HTML', () => {
  /* Build artifacts (public/*.html) — there is no module or component behind
     them inside vitest, so the file content IS the artifact under test. */
  it.each(TRUST_PAGES)(
    'public/%s.html has an h1 and at least 500 visible characters',
    (page) => {
      const html = readFileSync(resolve(webRoot, 'public', `${page}.html`), 'utf8')
      expect(html.toLowerCase()).toMatch(/<h1[\s>]/)
      const compact = visibleTextFromHtml(html).replace(/\s+/gu, '')
      expect(compact.length, page).toBeGreaterThanOrEqual(500)
    },
  )

  it('keeps MCP HTML naming the Streamable HTTP endpoint and refusing an API-key story', () => {
    const html = readFileSync(resolve(webRoot, 'public', 'mcp.html'), 'utf8')
    const visible = visibleTextFromHtml(html)
    expect(html).toMatch(/<h1[\s>]/)
    expect(visible).toContain('POST https://know-n.com/collections/-/mcp')
    expect(visible).toMatch(/OAuth/i)
    expect(visible).toMatch(/API[- ]key/i)
  })

  it('keeps Contact pointing at help@know-n.com and states there is no public phone or mailing address', () => {
    const html = readFileSync(resolve(webRoot, 'public', 'contact.html'), 'utf8')
    expect(html).toContain('mailto:help@know-n.com')
    expect(html).toContain('help@know-n.com')
    expect(html).not.toContain('github.com/WhitenWhiten/Know-N')
    expect(html).not.toMatch(/GitHub/i)
    const visible = visibleTextFromHtml(html).toLowerCase()
    expect(visible).toMatch(/no public telephone|no public phone|no phone/)
    expect(visible).toMatch(/mailing address/)
  })

  it('keeps the extension landing copy within the shipped Chromium capability boundary', () => {
    const html = readFileSync(resolve(webRoot, 'public', 'extension.html'), 'utf8')
    const visible = visibleTextFromHtml(html)
    expect(visible).toMatch(/Chrome|Chromium/i)
    expect(visible).toMatch(/Edge/i)
    expect(visible).toMatch(/Firefox/i)
    expect(visible).toMatch(/Safari/i)
    expect(visible).toMatch(/active (?:page|tab)/i)
    expect(visible).toMatch(/collections you own/i)
    expect(visible).toMatch(/selected (?:bookmark )?folders/i)
    expect(html).toContain('href="/register"')
    expect(html).toContain('href="/developers"')
    expect(visible).not.toMatch(/Chrome Web Store|Firefox Add-ons|Safari Extensions Gallery/i)
    expect(visible).not.toMatch(/available (?:now|today)|install from the store/i)
  })
})

describe('trust page markdown rendering behaviour', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it.each(MARKDOWN_PAGES)('renders /%s from the shared agent-public markdown file', async (page) => {
    const markdown = readMarkdown(page)
    const { title, lede, bodyHtml } = splitAgentPublicMarkdown(markdown)
    /* Non-vacuity: the document really did parse into a title and a body, so
       the comparisons below cannot pass on an empty expectation. */
    expect(title.length).toBeGreaterThan(0)
    expect(bodyHtml.length).toBeGreaterThan(200)

    await renderAt(`/${page}`)
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toContain(title)
    if (lede) expect(document.body.textContent).toContain(lede)
    /* Byte-for-byte: the body appears exactly once, in the element that also
       carries the wrap owner. A hardcoded copy, a swapped document, or a
       converter change fails here, and no rename of a symbol can. */
    const panels = renderedMarkdownPanels(bodyHtml)
    expect(panels).toHaveLength(1)
    expect(panels[0]?.classList.contains('trust-doc')).toBe(true)
  })

  it('gives trust markdown a wrap owner so long inline URLs cannot escape the panel', async () => {
    /* The wrap owner is a class contract on the element that carries the
       markdown body: a long inline URL has no break opportunity, so the text
       has to be wrapped by the panel it lands in. Asserted on the rendered
       element rather than on the component's source string, and coupled to the
       body actually landing there so an empty panel cannot satisfy it. */
    await renderAt('/contact')
    const panels = renderedMarkdownPanels(splitAgentPublicMarkdown(readMarkdown('contact')).bodyHtml)
    expect(panels).toHaveLength(1)
    expect(panels[0]?.classList.contains('trust-doc')).toBe(true)
    expect((panels[0]?.textContent ?? '').length).toBeGreaterThan(200)
  })

  it('points Contact at help@know-n.com instead of a GitHub repository', async () => {
    /* Both halves of the claim: the copy that renders, and the shared markdown
       it comes from — a GitHub pointer reintroduced in the document would not
       be caught by the rendered route alone if it sat behind an unrendered
       heading, and the document is the single source of the page's copy. */
    expect(readMarkdown('contact')).not.toMatch(/GitHub|github\.com/i)
    await renderAt('/contact')
    expect(document.querySelector('a[href="mailto:help@know-n.com"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/help@know-n\.com/)
    expect(document.body.textContent).not.toMatch(/GitHub/i)
    expect(document.body.textContent).not.toContain('github.com/WhitenWhiten/Know-N')
  })
})

describe('trust page app routes', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders /about from the product layout tree instead of NotFound', async () => {
    await renderAt('/about')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toMatch(/About Know-N/)
    expect(document.querySelector('h1 + p')).not.toBeNull()
    expect(document.body.textContent).toMatch(/online bookmark library/)
  })

  it('renders /contact instead of NotFound', async () => {
    await renderAt('/contact')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toMatch(/Contact Know-N/)
    expect(document.querySelector('a[href="mailto:help@know-n.com"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/help@know-n\.com/)
    expect(document.body.textContent).not.toMatch(/GitHub/i)
  })

  it('renders /privacy instead of NotFound', async () => {
    await renderAt('/privacy')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toMatch(/Privacy on Know-N/)
  })

  it('renders /mcp instead of NotFound', async () => {
    await renderAt('/mcp')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toMatch(/MCP on Know-N/)
    expect(document.body.textContent).toContain('/collections/-/mcp')
    expect(document.body.textContent).toMatch(/API[- ]key/i)
    expect(document.body.textContent).toMatch(/\/consent/)
  })

  it('renders the canonical embed guide with its Markdown alternative', async () => {
    await renderAt('/embed-guide')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toBe('Customize Know-N embedded cards with an agent')
    expect(document.querySelector('a[href="/embed-guide.md"]')?.textContent).toBe('Read as Markdown')
    expect(document.body.textContent).toContain('Troubleshooting and limits')
    expect(document.body.textContent).toContain('sitemap entry')
  })

  it('renders /developers instead of NotFound', async () => {
    await renderAt('/developers')
    expect(document.querySelector('[data-testid="not-found-route"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toMatch(/Developers on Know-N/)
    expect(document.body.textContent).toContain('/.well-known/collection-protocol')
    expect(document.body.textContent).toContain('/mcp')
    expect(document.body.textContent).toMatch(/text\/markdown/)
  })
})
