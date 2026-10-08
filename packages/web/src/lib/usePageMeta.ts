import { useEffect } from 'react'
import { SITE_ORIGIN } from './siteOrigin'

export interface PageMeta {
  description?: string
  /** Site-relative path. `null` deliberately removes canonical and og:url. */
  canonicalPath?: string | null
  /**
   * Site-relative og:image path (D1; absolutized with SITE_ORIGIN). Absent
   * leaves the origin-injected value — the site-wide cover, or the
   * per-collection card the server stamped into this page's HTML.
   */
  ogImagePath?: string
  robots?: 'noindex' | null
}

type HeadTarget = {
  node: Element
  attribute: 'content' | 'href'
  hadAttribute: boolean
  value: string | null
  parent: ParentNode
  nextSibling: ChildNode | null
}

type Entry = PageMeta & { title: string }

const entries = new Map<symbol, Entry>()
let baseline: {
  description: HeadTarget | null
  canonical: HeadTarget | null
  ogTitle: HeadTarget | null
  ogDescription: HeadTarget | null
  ogUrl: HeadTarget | null
  ogImage: HeadTarget | null
} | null = null
let ownedRobots: HTMLMetaElement | null = null

function capture(selector: string, attribute: HeadTarget['attribute']): HeadTarget | null {
  const node = document.head.querySelector(selector)
  if (!node || !node.parentNode) return null
  return {
    node,
    attribute,
    hadAttribute: node.hasAttribute(attribute),
    value: node.getAttribute(attribute),
    parent: node.parentNode,
    nextSibling: node.nextSibling,
  }
}

function captureBaseline() {
  return {
    description: capture('meta[name="description"]', 'content'),
    canonical: capture('link[rel="canonical"]', 'href'),
    ogTitle: capture('meta[property="og:title"]', 'content'),
    ogDescription: capture('meta[property="og:description"]', 'content'),
    ogUrl: capture('meta[property="og:url"]', 'content'),
    ogImage: capture('meta[property="og:image"]', 'content'),
  }
}

function restore(target: HeadTarget | null): void {
  if (!target) return
  if (!target.node.isConnected) {
    const anchor = target.nextSibling?.parentNode === target.parent ? target.nextSibling : null
    target.parent.insertBefore(target.node, anchor)
  }
  if (target.hadAttribute) target.node.setAttribute(target.attribute, target.value ?? '')
  else target.node.removeAttribute(target.attribute)
}

function setValue(target: HeadTarget | null, value: string): void {
  if (!target) return
  target.node.setAttribute(target.attribute, value)
}

function lastEntry<K extends keyof PageMeta>(key: K): Entry | undefined {
  return [...entries.values()].reverse().find((entry) => entry[key] !== undefined)
}

function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Path half of the backend's buildCollectionOgImageUrl (D1): the card endpoint,
 * versioned by updatedAt so social caches re-scrape after an edit. The ?v is
 * dropped when updatedAt is not a real instant, mirroring the backend.
 */
export function collectionOgImagePath(slug: string, updatedAt: string): string {
  const epoch = Date.parse(updatedAt)
  const base = `/og/collections/${encodeURIComponent(slug)}.png`
  return Number.isNaN(epoch) ? base : `${base}?v=${epoch}`
}

function applyActiveEntries(): void {
  if (!baseline) return
  restore(baseline.description)
  restore(baseline.canonical)
  restore(baseline.ogTitle)
  restore(baseline.ogDescription)
  restore(baseline.ogUrl)
  restore(baseline.ogImage)

  const latest = [...entries.values()].at(-1)
  if (latest) setValue(baseline.ogTitle, latest.title)

  const ogImageEntry = lastEntry('ogImagePath')
  if (ogImageEntry?.ogImagePath !== undefined) {
    setValue(baseline.ogImage, absoluteUrl(ogImageEntry.ogImagePath))
  }

  const descriptionEntry = lastEntry('description')
  if (descriptionEntry?.description !== undefined) {
    setValue(baseline.description, descriptionEntry.description)
    setValue(baseline.ogDescription, descriptionEntry.description)
  }

  const canonicalEntry = lastEntry('canonicalPath')
  if (canonicalEntry?.canonicalPath === null) {
    baseline.canonical?.node.remove()
    baseline.ogUrl?.node.remove()
  } else if (canonicalEntry?.canonicalPath !== undefined) {
    const url = absoluteUrl(canonicalEntry.canonicalPath)
    setValue(baseline.canonical, url)
    setValue(baseline.ogUrl, url)
  }

  const wantsNoindex = [...entries.values()].some((entry) => entry.robots === 'noindex')
  if (wantsNoindex && !ownedRobots?.isConnected) {
    ownedRobots = document.createElement('meta')
    ownedRobots.name = 'robots'
    ownedRobots.content = 'noindex'
    ownedRobots.dataset.pageMetaOwned = 'true'
    document.head.append(ownedRobots)
  } else if (!wantsNoindex && ownedRobots) {
    ownedRobots.remove()
    ownedRobots = null
  }
}

function register(meta: PageMeta, title: string): () => void {
  if (entries.size === 0) baseline = captureBaseline()
  const id = Symbol('page-meta')
  entries.set(id, { ...meta, title })
  applyActiveEntries()
  return () => {
    entries.delete(id)
    applyActiveEntries()
    if (entries.size !== 0) return
    ownedRobots?.remove()
    ownedRobots = null
    baseline = null
  }
}

/** Applies runtime metadata and restores the exact head state that preceded it. */
export function usePageMeta(meta: PageMeta, synchronizedTitle?: string): void {
  const { description, canonicalPath, ogImagePath, robots } = meta
  useEffect(
    () => register({ description, canonicalPath, ogImagePath, robots }, synchronizedTitle ?? document.title),
    [description, canonicalPath, ogImagePath, robots, synchronizedTitle],
  )
}