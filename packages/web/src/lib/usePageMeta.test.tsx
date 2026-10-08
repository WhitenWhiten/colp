// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { useDocumentTitle } from './useDocumentTitle'
import { collectionOgImagePath, usePageMeta, type PageMeta } from './usePageMeta'

const BASELINE_HEAD = `
  <meta name="description" content="Home description">
  <link rel="canonical" href="https://know-n.com/">
  <meta property="og:title" content="Home OG title">
  <meta property="og:description" content="Home OG description">
  <meta property="og:url" content="https://know-n.com/">
  <meta property="og:image" content="https://know-n.com/og-cover.png">
  <title>Home title</title>
`

function Page({ title, meta }: { title: string; meta: PageMeta }) {
  useDocumentTitle(title)
  usePageMeta(meta)
  return null
}

function MetaOnly({ meta }: { meta: PageMeta }) {
  usePageMeta(meta)
  return null
}

function content(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute('content') ?? null
}

describe('usePageMeta', () => {
  beforeEach(() => {
    document.head.innerHTML = BASELINE_HEAD
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    cleanup()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  it('sets the route head with the production origin and restores the exact entry DOM', () => {
    const entryHead = document.head.innerHTML
    const view = mountTree(
      <Page
        title="Explore"
        meta={{
          description: 'Explore public collections on Know-N.',
          canonicalPath: '/explore',
        }}
      />,
    )

    expect(document.title).toBe('Explore — Know-N')
    expect(content('meta[name="description"]')).toBe('Explore public collections on Know-N.')
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href'))
      .toBe('https://know-n.com/explore')
    expect(content('meta[property="og:title"]')).toBe('Explore — Know-N')
    expect(content('meta[property="og:description"]')).toBe('Explore public collections on Know-N.')
    expect(content('meta[property="og:url"]')).toBe('https://know-n.com/explore')

    view.unmount()
    expect(document.head.innerHTML).toBe(entryHead)
  })

  it('removes canonical and og:url while active when canonicalPath is null, then restores them', () => {
    const view = mountTree(<Page title="Search" meta={{ canonicalPath: null, robots: 'noindex' }} />)

    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull()

    view.unmount()
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href'))
      .toBe('https://know-n.com/')
    expect(content('meta[property="og:url"]')).toBe('https://know-n.com/')
  })

  it('owns only its robots node and never changes a server-provided noindex', () => {
    const serverRobots = document.createElement('meta')
    serverRobots.name = 'robots'
    serverRobots.content = 'noindex, nofollow'
    serverRobots.dataset.serverInjected = 'true'
    document.head.append(serverRobots)

    const view = mountTree(<MetaOnly meta={{ robots: 'noindex' }} />)
    const robots = [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="robots"]')]
    expect(robots).toHaveLength(2)
    expect(robots.find((node) => node.dataset.serverInjected === 'true')?.content).toBe('noindex, nofollow')
    expect(robots.find((node) => node.dataset.pageMetaOwned === 'true')?.content).toBe('noindex')

    view.unmount()
    expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1)
    expect(serverRobots.isConnected).toBe(true)
    expect(serverRobots.content).toBe('noindex, nofollow')
  })

  it('is idempotent in StrictMode and falls back through overlapping callers', () => {
    function Stack({ includeSecond }: { includeSecond: boolean }) {
      return (
        <StrictMode>
          <MetaOnly meta={{ description: 'First', robots: 'noindex' }} />
          {includeSecond ? <MetaOnly meta={{ description: 'Second', robots: 'noindex' }} /> : null}
        </StrictMode>
      )
    }

    const view = mountTree(<Stack includeSecond />)
    expect(content('meta[name="description"]')).toBe('Second')
    expect(document.head.querySelectorAll('meta[data-page-meta-owned="true"]')).toHaveLength(1)

    view.rerender(<Stack includeSecond />)
    expect(content('meta[name="description"]')).toBe('Second')
    expect(document.head.querySelectorAll('meta[data-page-meta-owned="true"]')).toHaveLength(1)

    view.rerender(<Stack includeSecond={false} />)
    expect(content('meta[name="description"]')).toBe('First')
    expect(document.head.querySelectorAll('meta[data-page-meta-owned="true"]')).toHaveLength(1)

    view.unmount()
    expect(content('meta[name="description"]')).toBe('Home description')
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull()
  })

  it('points og:image at the per-collection card and restores the baseline on unmount', () => {
    const entryHead = document.head.innerHTML
    const view = mountTree(
      <MetaOnly meta={{ ogImagePath: collectionOgImagePath('llm-path', '2026-08-29T04:19:21.427Z') }} />,
    )

    expect(content('meta[property="og:image"]'))
      .toBe(`https://know-n.com/og/collections/llm-path.png?v=${Date.parse('2026-08-29T04:19:21.427Z')}`)

    view.unmount()
    expect(document.head.innerHTML).toBe(entryHead)
    expect(content('meta[property="og:image"]')).toBe('https://know-n.com/og-cover.png')
  })

  it('leaves the server-stamped og:image alone when no entry sets ogImagePath', () => {
    const view = mountTree(<MetaOnly meta={{ description: 'No image override' }} />)

    expect(content('meta[property="og:image"]')).toBe('https://know-n.com/og-cover.png')
    view.unmount()
  })

  it('falls back through overlapping ogImagePath callers', () => {
    function Stack({ includeSecond }: { includeSecond: boolean }) {
      return (
        <>
          <MetaOnly meta={{ ogImagePath: '/og/collections/first.png?v=1' }} />
          {includeSecond ? <MetaOnly meta={{ ogImagePath: '/og/collections/second.png?v=2' }} /> : null}
        </>
      )
    }

    const view = mountTree(<Stack includeSecond />)
    expect(content('meta[property="og:image"]')).toBe('https://know-n.com/og/collections/second.png?v=2')

    view.rerender(<Stack includeSecond={false} />)
    expect(content('meta[property="og:image"]')).toBe('https://know-n.com/og/collections/first.png?v=1')
  })

  it('collectionOgImagePath versions by updatedAt and mirrors the backend URL', () => {
    const epoch = Date.parse('2026-08-01T12:00:00.000Z')
    expect(collectionOgImagePath('engineering-notes', '2026-08-01T12:00:00.000Z'))
      .toBe(`/og/collections/engineering-notes.png?v=${epoch}`)
    expect(collectionOgImagePath('engineering-notes', 'garbage'))
      .toBe('/og/collections/engineering-notes.png')
  })
})
