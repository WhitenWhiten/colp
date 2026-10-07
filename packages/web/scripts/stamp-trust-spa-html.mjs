import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyPageHead,
  escapeAttr,
  escapeHtml,
  MARKER_END,
  MARKER_START,
  replaceMarkedRegion,
  wrapAgentPublicFallback,
} from './spa-html-meta.mjs'

const TRUST_SPA_PAGES = [
  { file: 'about.html', canonicalPath: '/about' },
  { file: 'contact.html', canonicalPath: '/contact' },
  { file: 'privacy.html', canonicalPath: '/privacy' },
  { file: 'mcp.html', canonicalPath: '/mcp' },
  { file: 'developers.html', canonicalPath: '/developers' },
  { file: 'embed-guide.html', canonicalPath: '/embed-guide' },
  { file: 'extension.html', canonicalPath: '/extension' },
  { file: '404.html', canonicalPath: null },
]

/**
 * Sitemap-listed SPA routes with no generator document. They used to ship the
 * raw index.html, whose canonical / og:url / description all point at "/", so
 * every non-rendering consumer read them as duplicates of the home page. Title
 * must equal what the hydrated page writes via useDocumentTitle
 * (`{title} — Know-N`); `agentPublicFiles.test.ts` pins that against the page source.
 */
export const HEAD_ONLY_SPA_PAGES = [
  {
    file: 'login.html',
    canonicalPath: '/login',
    documentTitle: 'Sign in',
    heading: 'Sign in to Know-N',
    description: 'Sign in to Know-N to sync, organize, and share your bookmark collections.',
    links: [
      { href: '/register', label: 'Create an account' },
      { href: '/explore', label: 'Explore public collections' },
    ],
  },
  {
    file: 'register.html',
    canonicalPath: '/register',
    documentTitle: 'Create account',
    heading: 'Create a Know-N account',
    description: 'Create a Know-N account to save bookmarks, organize them into collections, and share reading paths.',
    links: [
      { href: '/login', label: 'Sign in' },
      { href: '/extension', label: 'Browser extension' },
    ],
  },
  /* R15-24: bare /share is the product page for sharing, not the homepage. */
  {
    file: 'share.html',
    canonicalPath: '/share',
    documentTitle: 'Share',
    heading: 'Share bookmark collections with one link',
    description: 'Share curated bookmark collections and learning paths with one Know-N link.',
    links: [
      { href: '/explore', label: 'Explore public collections' },
      { href: '/register', label: 'Create an account' },
    ],
  },
]

/**
 * R15-22: nginx serves this with 503 + Retry-After when a public page's
 * origin fails. It hydrates like any route, but carries no canonical, og:url
 * or JSON-LD, so an outage never reads as a copy of the home page.
 */
export const UNAVAILABLE_SHELL = {
  file: 'shell.html',
  title: 'Temporarily unavailable — Know-N',
  heading: 'Know-N is temporarily unavailable',
  description: 'Know-N is having trouble right now. Try again in a minute.',
}

export function stampUnavailableShell(indexHtml) {
  const fallback = `<h1>${escapeHtml(UNAVAILABLE_SHELL.heading)}</h1>\n`
    + `<p>${escapeHtml(UNAVAILABLE_SHELL.description)}</p>`
  const withFallback = replaceMarkedRegion(indexHtml, wrapAgentPublicFallback(fallback))
  return applyPageHead(withFallback, {
    title: UNAVAILABLE_SHELL.title,
    description: UNAVAILABLE_SHELL.description,
    canonicalPath: null,
  })
}

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readUtf8(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
}

function parseArgs(argv) {
  let distDir
  let publicDir
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--dist' && value) {
      distDir = value
      i += 1
      continue
    }
    if (flag === '--public' && value) {
      publicDir = value
      i += 1
      continue
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`)
  }
  return {
    distDir: distDir ?? join(webRoot, 'dist'),
    publicDir: publicDir ?? join(webRoot, 'public'),
  }
}

function extractTitle(html) {
  const match = /<title>([^<]*)<\/title>/u.exec(html)
  if (!match) {
    throw new Error('Standalone trust HTML is missing <title>')
  }
  return match[1].trim()
}

function unescapeAttr(text) {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

function extractDescription(html) {
  const match = /<meta name="description" content="([^"]*)" \/>/u.exec(html)
  if (!match) {
    throw new Error('Standalone trust HTML is missing meta description')
  }
  return unescapeAttr(match[1]).trim()
}

function extractBodyInner(html) {
  const match = /<body>([\s\S]*?)<\/body>/u.exec(html)
  if (!match) {
    throw new Error('Standalone trust HTML is missing <body>')
  }
  return match[1].trim()
}

function stampPage(indexHtml, standaloneHtml, { file, canonicalPath }) {
  if (standaloneHtml.includes('id="agent-public-fallback"') || standaloneHtml.includes('/assets/')) {
    throw new Error(`${file} must be generator standalone HTML, not a stamped SPA shell`)
  }
  const title = extractTitle(standaloneHtml)
  const description = extractDescription(standaloneHtml)
  const bodyInner = extractBodyInner(standaloneHtml)
  if (!/<h1[\s>]/u.test(bodyInner)) {
    throw new Error(`${file} standalone body must include an <h1>`)
  }
  const withFallback = replaceMarkedRegion(indexHtml, wrapAgentPublicFallback(bodyInner))
  return applyPageHead(withFallback, { title, description, canonicalPath })
}

export function headOnlyPageTitle(page) {
  return `${page.documentTitle} — Know-N`
}

/** Thin functional route: own head + a short fallback so no-JS readers get real links, not the home copy. */
export function stampHeadOnlyPage(indexHtml, page) {
  const links = page.links
    .map((link) => `<a href="${escapeAttr(link.href)}">${escapeHtml(link.label)}</a>`)
    .join(' · ')
  const fallback = `<h1>${escapeHtml(page.heading)}</h1>\n`
    + `<p>${escapeHtml(page.description)}</p>\n`
    + `<p>${links}</p>`
  const withFallback = replaceMarkedRegion(indexHtml, wrapAgentPublicFallback(fallback))
  return applyPageHead(withFallback, {
    title: headOnlyPageTitle(page),
    description: page.description,
    canonicalPath: page.canonicalPath,
  })
}

export function stampTrustSpaHtml({ distDir, publicDir }) {
  const indexPath = join(distDir, 'index.html')
  const indexHtml = readUtf8(indexPath)
  if (!indexHtml.includes(MARKER_START) || !indexHtml.includes(MARKER_END)) {
    throw new Error('dist/index.html must contain the agent-public markers')
  }

  for (const page of TRUST_SPA_PAGES) {
    const standaloneHtml = readUtf8(join(publicDir, page.file))
    const stamped = stampPage(indexHtml, standaloneHtml, page)
    writeFileSync(join(distDir, page.file), stamped, 'utf8')
  }
  for (const page of HEAD_ONLY_SPA_PAGES) {
    writeFileSync(join(distDir, page.file), stampHeadOnlyPage(indexHtml, page), 'utf8')
  }
  writeFileSync(join(distDir, UNAVAILABLE_SHELL.file), stampUnavailableShell(indexHtml), 'utf8')
}

const invokedAsCli = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsCli) stampTrustSpaHtml(parseArgs(process.argv.slice(2)))
