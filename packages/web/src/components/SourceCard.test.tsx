// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CardLayout, Resource, ResourceBase, SourceType } from '../types/catalog'
import { SourceCard } from './SourceCard'
import { cleanup, mountTree } from '../test/render'

/**
 * C03 SourceCard contract: the generic card shell is always present and
 * never re-decided by the body; each body family (GitHub / video /
 * Wikipedia / widget) and the unknown fallback render through the same
 * shell. Body branches only own body content + limited source accent
 * (language dot custom property).
 */

const layout: CardLayout = { x: 20, y: 40, w: 320, h: 240, z: 3 }

function makeResource(
  overrides: Partial<ResourceBase> & {
    type: SourceType
    meta?: Record<string, string | number>
  },
): Resource {
  return {
    id: 'r-card',
    title: 'Sample title',
    url: 'https://example.com/item',
    summary: 'A short summary of the sample resource.',
    host: 'example.com',
    layout,
    ...overrides,
  } as Resource
}

describe('SourceCard', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render(
    resource: Resource,
    props: Partial<Parameters<typeof SourceCard>[0]> = {},
  ) {
    mountTree(
        <MemoryRouter>
          <SourceCard resource={resource} layout={resource.layout} {...props} />
        </MemoryRouter>,
      )
    return document.querySelector('article.tile')!
  }

  function unmount() {
    act(() => {
      cleanup()
          })
  }

  it('renders the generic shell for every body family', () => {
    const resources: Resource[] = [
      makeResource({ type: 'github', meta: { owner: 'known', stars: 12800 } }),
      makeResource({ type: 'youtube', meta: { duration: '12:30' } }),
      makeResource({ type: 'wikipedia', meta: { read: '120k', langs: '42 langs' } }),
      makeResource({ type: 'todo', title: 'Today' }),
      makeResource({ type: 'mystery' as SourceType }),
    ]

    for (const resource of resources) {
      const article = render(resource)
      // Generic shell classes are always present, whatever the source type.
      expect(article.classList.contains('tile'), resource.type).toBe(true)
      expect(article.classList.contains(`tile-${resource.type}`), resource.type).toBe(true)
      expect(article.querySelector('[data-testid="card-shell"]'), resource.type).not.toBeNull()
      expect(article.querySelector('[data-testid="tile-content"]'), resource.type).not.toBeNull()
      expect(article.getAttribute('role')).toBe('listitem')
      expect(article.getAttribute('data-id')).toBe(resource.id)
      unmount()
    }
  })

  it('never lets the body override the shell surface / radius / padding', () => {
    const resources: Resource[] = [
      makeResource({ type: 'github', meta: { owner: 'known', stars: 12800 } }),
      makeResource({ type: 'youtube', meta: { duration: '12:30' } }),
      makeResource({ type: 'wikipedia', meta: { read: '120k', langs: '42 langs' } }),
      makeResource({ type: 'todo', title: 'Today' }),
      makeResource({ type: 'mystery' as SourceType }),
    ]

    for (const resource of resources) {
      const article = render(resource)
      const shellStyle = article.getAttribute('style') ?? ''
      // The tile style only carries dynamic board geometry custom
      // properties (+ z-index); surface, radius and padding come from
      // cards.css / cards-ui.css classes, never from the body.
      expect(shellStyle, resource.type).toContain('--x: 20px')
      expect(shellStyle, resource.type).toContain('--card-chrome-h')
      expect(shellStyle, resource.type).not.toMatch(/border-radius|background|padding|border:/)
      const content = article.querySelector<HTMLElement>('[data-testid="tile-content"]')!
      expect(content.getAttribute('style'), resource.type).toBeNull()
      const cardShell = article.querySelector<HTMLElement>('[data-testid="card-shell"]')!
      expect(cardShell.getAttribute('style'), resource.type).toBeNull()
      unmount()
    }
  })

  it('renders the GitHub body with meta and language accent', () => {
    const article = render(
      makeResource({
        type: 'github',
        meta: {
          owner: 'known',
          stars: 12800,
          forks: 340,
          lang: 'TypeScript',
          langColor: 'rgb(49 120 198)',
          commit: 'fix: shell',
          commitAge: '2d',
          commitHash: 'a1b2c3d',
        },
      }),
    )

    const repo = article.querySelector<HTMLElement>('[data-testid="repo-name"]')!
    expect(repo.querySelector('a')?.textContent).toBe('Sample title')
    expect(article.querySelector('[data-testid="summary"]')?.textContent).toContain('short summary')
    const meta = article.querySelector('[data-testid="card-meta"]')!
    expect(meta.querySelector('[data-icon="star"]')).not.toBeNull()
    expect(meta.textContent).toContain('12800')
    expect(meta.querySelector('[data-icon="fork"]')).not.toBeNull()
    expect(meta.textContent).toContain('340')
    expect(meta.textContent).toContain('TypeScript')
    expect(meta.textContent).toContain('MIT')
    const lang = article.querySelector<HTMLElement>('[style*="--lang-color"]')!
    expect(lang.getAttribute('style')).toContain('--lang-color')
    expect(article.querySelector('[data-testid="commit"]')).not.toBeNull()
  })

  it('renders the video body with media placeholder, play action and duration', () => {
    const article = render(
      makeResource({
        type: 'youtube',
        url: 'https://youtube.com/watch?v=abc',
        meta: { duration: '12:30', views: '1.2M', likes: 8900, age: '3d' },
      }),
    )

    expect(article.querySelector('[data-testid="video-layout"]')).not.toBeNull()
    expect(article.querySelector('[data-testid="video-media"]')).not.toBeNull()
    const play = article.querySelector<HTMLAnchorElement>('a[aria-label="Play Sample title"]')!
    expect(play.getAttribute('aria-label')).toBe('Play Sample title')
    expect(play.getAttribute('href')).toBe('https://youtube.com/watch?v=abc')
    expect(article.querySelector('[data-testid="duration"]')?.textContent).toBe('12:30')
    const titleLink = article.querySelector<HTMLAnchorElement>('h2 a')!
    expect(titleLink.textContent).toBe('Sample title')
    expect(article.querySelector('[data-testid="card-meta"]')?.textContent).toContain('1.2M')
  })

  it('renders the Wikipedia body with the wiki mark', () => {
    const article = render(
      makeResource({
        type: 'wikipedia',
        meta: { read: '120k', langs: '42 languages', index: 'Introduction · History' },
      }),
    )

    expect(article.querySelector('[data-testid="wiki-mark"]')?.textContent).toBe('W')
    const title = article.querySelector<HTMLAnchorElement>('h2 a')!
    expect(title.textContent).toBe('Sample title')
    expect(article.querySelector('[data-testid="card-meta"]')?.textContent).toContain('42 languages')
    expect(article.querySelector('[data-testid="wiki-index"]')?.textContent).toContain('Introduction')
  })

  it('renders widget bodies in the fill content area', () => {
    const article = render(makeResource({ type: 'todo', title: 'Today' }))

    expect(
      article.querySelector('[data-testid="tile-content"]')?.classList.contains('tile-content--fill'),
    ).toBe(true)
    expect(article.querySelector('button[title="Rename list"] > span')?.textContent).toBe('Today')
  })

  it('renders the generic fallback body for unknown sources without breaking the shell', () => {
    const article = render(makeResource({ type: 'mystery' as SourceType }))

    expect(article.classList.contains('tile-mystery')).toBe(true)
    expect(article.querySelector('[data-testid="card-shell"]')).not.toBeNull()
    const title = article.querySelector<HTMLAnchorElement>('h2 a')!
    expect(title.textContent).toBe('Sample title')
    expect(article.querySelector('[data-testid="summary"]')?.textContent).toContain('short summary')
    expect(article.querySelector('[data-testid="card-meta"]')?.textContent).toContain('example.com')
  })

  it('renders the edit-mode head chrome with source mark and actions', () => {
    const onToggleLock = () => {}
    const onThemeChange = () => {}
    const onRemove = () => {}
    const article = render(
      makeResource({ type: 'figma', meta: { duplicates: 12, likes: 300 } }),
      {
        editable: true,
        selected: true,
        onToggleLock,
        onThemeChange,
        onRemove,
      },
    )

    const head = article.querySelector('[data-testid="card-head"]')!
    expect(head).not.toBeNull()
    expect(article.querySelector('button[aria-label^="Move"]')?.getAttribute('aria-label')).toContain(
      'Move Figma card',
    )
    expect(article.querySelector('[data-testid="figma-mark"]')).not.toBeNull()
    expect(article.querySelector('[data-testid="source-name"]')?.textContent).toBe('Figma')
    const lock = article.querySelector<HTMLButtonElement>('button[aria-label^="Lock"]')!
    expect(lock.getAttribute('aria-pressed')).toBe('false')
    const theme = article.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(theme.getAttribute('aria-haspopup')).toBe('menu')
    expect(article.querySelector('button[aria-label^="Remove"]')).not.toBeNull()
    expect(article.querySelector('[data-testid="resource-mark-actions"]')).not.toBeNull()
    // Edit chrome: size badge + resize handle.
    expect(article.querySelector('[data-testid="size-badge"]')?.textContent).toBe('320 × 240 · 20,40')
    expect(article.querySelector('button[aria-label^="Resize"]')).not.toBeNull()
    // Content wrapper drops the no-head modifier in edit mode.
    expect(
      article.querySelector('[data-testid="tile-content"]')?.classList.contains('tile-content--no-head'),
    ).toBe(false)
  })

  it('keeps collection module titles in sentence case', () => {
    const article = render(
      makeResource({ type: 'collectionlist', title: 'Interface Systems' }),
      { editable: true, onRemove: () => {}, onToggleLock: () => {} },
    )
    const name = article.querySelector('[data-testid="source-name"]')
    expect(name?.classList.contains('source-name--plain')).toBe(true)
    expect(name?.textContent).toBe('Interface Systems')
    expect(article.querySelector('[data-testid="card-actions"]')).not.toBeNull()
  })

  it('hides mark actions for tool widgets', () => {
    const article = render(makeResource({ type: 'todo', title: 'Today' }), {
      editable: true,
      onToggleLock: () => {},
    })

    expect(article.querySelector('[data-testid="resource-mark-actions"]')).toBeNull()
    expect(article.querySelector('[data-testid="card-head"]')).not.toBeNull()
  })
})
