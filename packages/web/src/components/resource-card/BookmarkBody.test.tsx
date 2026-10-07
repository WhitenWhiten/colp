// @vitest-environment happy-dom
/* BookmarkBody — body rendering and outbound-link hardening.
 *
 * Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the rendered anchor. Every registered source body is driven
 *    through the real `BookmarkBody` with a safe and with a rejected URL, and
 *    the DOM is asked what it produced (rel/target/href). Whether an outbound
 *    link is hardened is exactly what the user's browser acts on, so this is
 *    the strongest available form of the old "no raw
 *    `<a href={resource.url} rel="noreferrer">` in the sources" text scan.
 *
 * 2. Architecture — the *completeness* of that loop. A source-body module
 *    exported but never registered is unreachable dead code: nothing renders
 *    it, so no probe can see that it exists, and the behaviour loop above
 *    would silently stop covering it. The registry/export identity check
 *    below is what keeps the loop complete, and it is made on real module
 *    namespace values rather than on source text.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BookmarkResource, BookmarkType, CardLayout } from '../../types/catalog'
import { BookmarkBody } from './BookmarkBody'
import { resolveSourceBody, sourceBodyRegistry } from './source-bodies/registry'
import { cleanup, mountTree } from '../../test/render'

/* Real module namespaces: `sourceBodyRegistry` entries are compared by
   identity against these, so renaming a component cannot break the check. */
const sourceBodyModules = import.meta.glob('./source-bodies/*.tsx', {
  eager: true,
}) as Record<string, Record<string, unknown>>

const layout: CardLayout = { x: 0, y: 0, w: 1, h: 1, z: 0 }

function resource(overrides: Partial<BookmarkResource> = {}): BookmarkResource {
  return {
    id: 'r1',
    type: 'article',
    title: 'Sample',
    url: 'https://example.com/item',
    summary: 'Summary',
    host: 'example.com',
    layout,
    ...overrides,
  }
}

/** Every type the registry can resolve, i.e. every reachable source body. */
function registeredTypes(): BookmarkType[] {
  return Object.keys(sourceBodyRegistry) as BookmarkType[]
}

/** Every `*Body` component exported from a source-body module. */
function exportedSourceBodies(): { name: string; component: unknown }[] {
  const out: { name: string; component: unknown }[] = []
  for (const [path, module] of Object.entries(sourceBodyModules)) {
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'function' || !name.endsWith('Body')) continue
      out.push({ name: `${path}#${name}`, component: value })
    }
  }
  return out
}

function renderBody(type: BookmarkType, url = 'https://example.com/item') {
  mountTree(
    createElement(BookmarkBody, {
      resource: resource({ type, url, ...(type === 'techcrunch' ? { meta: { section: 'Apps', time: '2h' } } : {}) }),
      isVideo: false,
    }),
  )
}

describe('BookmarkBody outbound link behaviour', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders https bookmarks through ExternalLink', () => {
    mountTree(<BookmarkBody resource={resource()} isVideo={false} />)
    const anchor = document.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com/item')
    expect(anchor?.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer')
    expect(anchor?.getAttribute('target')).toBe('_blank')
  })

  it('omits href when the bookmark URL is rejected', () => {
    mountTree(<BookmarkBody resource={resource({ url: 'javascript:alert(1)' })} isVideo={false} />)
    expect(document.querySelector('a')).toBeNull()
    expect(document.querySelector('[href]')).toBeNull()
    expect(document.body.textContent).toContain('Sample')
  })

  it('hardens the outbound link in every registered source body', () => {
    const types = registeredTypes()
    /* A mis-anchored registry would make the loop below vacuous. */
    expect(types.length).toBeGreaterThan(30)
    const offenders: string[] = []
    const typesRenderingAnchors: BookmarkType[] = []
    for (const type of types) {
      renderBody(type)
      const anchors = [...document.querySelectorAll('a')]
      if (anchors.length > 0) typesRenderingAnchors.push(type)
      for (const anchor of anchors) {
        const rel = anchor.getAttribute('rel')
        const target = anchor.getAttribute('target')
        const href = anchor.getAttribute('href')
        if (rel !== 'nofollow ugc noopener noreferrer' || target !== '_blank' || href !== 'https://example.com/item') {
          offenders.push(`${type}: href=${href} rel=${rel} target=${target}`)
        }
      }
    }
    /* `path` is the one registered body that intentionally renders no outbound
       link (it renders the reading-path step list). Every other body must
       still produce one, so a body that silently stopped linking fails here
       instead of leaving the loop above vacuously green. */
    expect(typesRenderingAnchors).toEqual(types.filter((type) => type !== 'path'))
    expect(offenders).toEqual([])
  })

  it('drops the href in every registered source body when the URL is rejected', () => {
    const offenders: string[] = []
    for (const type of registeredTypes()) {
      renderBody(type, 'javascript:alert(1)')
      if (document.querySelector('a') !== null || document.querySelector('[href]') !== null) {
        offenders.push(type)
      }
    }
    /* The rejected URL is the same one the single-component probe above uses,
       so this cannot pass by rendering nothing at all. */
    renderBody('github', 'https://example.com/item')
    expect(document.querySelector('a')).not.toBeNull()
    expect(offenders).toEqual([])
  })
})

describe('BookmarkBody registry behaviour', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders a registered type through its cluster body', () => {
    mountTree(
      <BookmarkBody
        resource={resource({ type: 'github', meta: { owner: 'known', stars: 12 } })}
        isVideo={false}
      />,
    )
    expect(document.body.textContent).toContain('known')
    expect(document.querySelector('[data-icon="star"]')).not.toBeNull()
    expect(document.body.textContent).toContain('12')
    expect(document.querySelector('a')?.textContent).toBe('Sample')
  })

  it('renders the news cluster from its SourceType keys', () => {
    mountTree(
      <BookmarkBody
        resource={resource({ type: 'techcrunch', meta: { section: 'Apps', time: '2h' } })}
        isVideo={false}
      />,
    )
    expect(document.body.textContent).toContain('Apps')
    expect(document.body.textContent).toContain('2h')
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.com/item')
  })

  it('renders the video cluster when isVideo is set for an unregistered type', () => {
    mountTree(
      <BookmarkBody
        resource={resource({ type: 'article', meta: { duration: '4:01' } })}
        isVideo={true}
      />,
    )
    expect(document.querySelector('[aria-label="Play Sample"]')).not.toBeNull()
    expect(document.body.textContent).toContain('4:01')
  })

  it('falls back to a generic title/summary/meta body for unknown types', () => {
    mountTree(
      <BookmarkBody
        resource={resource({ type: 'mystery' as BookmarkType, host: 'unknown.example' })}
        isVideo={false}
      />,
    )
    expect(document.body.textContent).toContain('Sample')
    expect(document.body.textContent).toContain('Summary')
    expect(document.body.textContent).toContain('unknown.example')
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.com/item')
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps every exported source body reachable from the registry', () => {
    /* An exported-but-unreachable body module renders nothing, so the
       behaviour loop above cannot see it and would quietly stop covering it:
       there is no DOM state that distinguishes "unreachable module with a raw
       anchor" from "no such module". This identity check supplies exactly that
       missing completeness, and it compares real module values, so renaming a
       component moves both sides together. */
    const registered = new Set(Object.values(sourceBodyRegistry) as unknown[])
    /* The two module-level fallbacks `resolveSourceBody` hands out for an
       unregistered type are reachable without a registry key, so they are
       legitimate members of the reachable set — read from the resolver itself
       rather than hardcoded, to stay rename-proof. */
    const fallbackType = '__not_a_registered_type__' as BookmarkType
    const fallbacks = [
      resolveSourceBody(fallbackType, false),
      resolveSourceBody(fallbackType, true),
    ] as unknown[]
    expect(fallbacks.every((component) => typeof component === 'function')).toBe(true)

    const exported = exportedSourceBodies()
    /* Non-vacuity: a broken/empty glob would otherwise make every assertion in
       this test pass while checking nothing. */
    expect(exported.length).toBeGreaterThan(30)
    expect(registered.size).toBeGreaterThan(30)

    const reachable = new Set([...registered, ...fallbacks])
    const unreachable = exported.filter((entry) => !reachable.has(entry.component))
    expect(unreachable.map((entry) => entry.name)).toEqual([])

    const exportedValues = new Set(exported.map((entry) => entry.component))
    const stale = [...registered].filter((component) => !exportedValues.has(component))
    expect(stale).toEqual([])

    /* Cluster types share one component, so the key loop iterates more keys
       than there are distinct components. Every registered component must
       still be one the loop actually renders. */
    const renderedComponents = new Set(registeredTypes().map((type) => resolveSourceBody(type, false)))
    expect(renderedComponents.size).toBe(registered.size)
    expect([...registered].filter((component) => !renderedComponents.has(component as never))).toEqual([])
  })
})
