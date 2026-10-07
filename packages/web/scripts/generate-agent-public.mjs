import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_ORIGIN = 'https://know-n.com'
const MARKER_START = '<!-- agent-public:start -->'
const MARKER_END = '<!-- agent-public:end -->'
/**
 * `lastmod` is declared only where the page's content lives in tracked
 * sources (`sources`, web-root relative) and must be bumped when those
 * sources change; `generate-agent-public.test.ts` compares it against the
 * sources' last git commit date. SPA-only routes (/explore, /login, /register)
 * have no trackable content instant and deliberately carry no lastmod: an
 * inaccurate value would also erode trust in the accurate dynamic sitemaps.
 */
export const SITEMAP_PAGES = Object.freeze([
  { path: '/', lastmod: '2026-09-28', sources: ['index.html', 'content/agent-public/home.md'] },
  { path: '/explore' },
  { path: '/about', lastmod: '2026-08-25', sources: ['content/agent-public/about.md'] },
  { path: '/contact', lastmod: '2026-08-23', sources: ['content/agent-public/contact.md'] },
  { path: '/privacy', lastmod: '2026-09-30', sources: ['content/agent-public/privacy.md'] },
  { path: '/extension', lastmod: '2026-08-31', sources: ['content/agent-public/extension.md'] },
  { path: '/mcp', lastmod: '2026-08-29', sources: ['content/agent-public/mcp.md'] },
  { path: '/developers', lastmod: '2026-09-22', sources: ['content/agent-public/developers.md'] },
  { path: '/embed-guide', lastmod: '2026-09-26', sources: ['content/agent-public/embed-guide.md'] },
  { path: '/login' },
  { path: '/register' },
])
const DOCUMENT_PAGES = [
  { source: 'about.md', htmlName: 'about.html', mdName: 'about.md' },
  { source: 'contact.md', htmlName: 'contact.html', mdName: 'contact.md' },
  { source: 'privacy.md', htmlName: 'privacy.html', mdName: 'privacy.md' },
  { source: 'mcp.md', htmlName: 'mcp.html', mdName: 'mcp.md' },
  { source: 'developers.md', htmlName: 'developers.html', mdName: 'developers.md' },
  { source: 'extension.md', htmlName: 'extension.html', mdName: 'extension.md' },
  { source: 'embed-guide.md', htmlName: 'embed-guide.html', mdName: 'embed-guide.md' },
  { source: '404.md', htmlName: '404.html', mdName: '404.md' },
]

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const contentDir = join(webRoot, 'content', 'agent-public')
const publicDir = join(webRoot, 'public')
const indexPath = join(webRoot, 'index.html')

function readUtf8(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
}

function normalizeMarkdown(source) {
  return `${source.replace(/\s+$/u, '')}\n`
}

function escapeHtml(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/gu, '&quot;')
}

/** Same http(s)+no-userinfo rule as `src/lib/publicCollectionTree.ts` `safeExternalUrl`. */
function safeExternalUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

const MAILTO_HREF = /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u

/** Must stay aligned with `src/lib/agentPublicMarkdown.ts` `safeAgentPublicHref`. */
function safeAgentPublicHref(href) {
  const trimmed = href.trim()
  if (!trimmed || /[\s\\]/.test(trimmed)) return null
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  if (MAILTO_HREF.test(trimmed)) return trimmed
  return safeExternalUrl(trimmed)
}

/** Must stay aligned with `src/lib/agentPublicMarkdown.ts` `renderAgentPublicInlineHtml`. */
function renderInline(text) {
  const escaped = escapeHtml(text)
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
  return withBold.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (match, label, href) => {
    const safe = safeAgentPublicHref(href)
    if (!safe) return match
    return `<a href="${escapeAttr(safe)}">${label}</a>`
  })
}

function markdownToHtml(markdown) {
  const lines = normalizeMarkdown(markdown).replace(/\n$/u, '').split('\n')
  const html = []
  let listItems = []
  let codeLines = null

  const flushList = () => {
    if (listItems.length === 0) return
    html.push('<ul>')
    for (const item of listItems) html.push(`<li>${item}</li>`)
    html.push('</ul>')
    listItems = []
  }

  const flushCode = () => {
    if (codeLines === null) return
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
    codeLines = null
  }

  for (const line of lines) {
    if (/^```/u.test(line)) {
      if (codeLines === null) {
        flushList()
        codeLines = []
      } else {
        flushCode()
      }
      continue
    }
    if (codeLines !== null) {
      codeLines.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      continue
    }
    const listItem = /^[-*]\s+(.+)$/u.exec(line)
    if (listItem) {
      listItems.push(renderInline(listItem[1].trim()))
      continue
    }
    flushList()
    const trimmed = line.trim()
    if (trimmed === '') continue
    html.push(`<p>${renderInline(trimmed)}</p>`)
  }
  flushList()
  flushCode()
  return html.join('\n')
}

function extractTitle(markdown) {
  const heading = /^#\s+(.+)$/mu.exec(markdown)
  if (!heading) {
    throw new Error('Markdown document is missing a top-level # heading')
  }
  return heading[1].replace(/\*\*/gu, '').trim()
}

function markdownInlineToPlain(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
}

export function extractFirstParagraphFromMarkdown(markdown) {
  const lines = normalizeMarkdown(markdown).replace(/\n$/u, '').split('\n')
  const para = []
  let pastTitle = false
  let inCode = false
  for (const line of lines) {
    if (/^```/u.test(line)) {
      if (inCode) {
        inCode = false
        continue
      }
      if (para.length > 0) break
      inCode = true
      continue
    }
    if (inCode) continue
    if (/^#\s+/u.test(line) && !pastTitle) {
      pastTitle = true
      continue
    }
    if (/^#{1,6}\s+/u.test(line) || /^[-*]\s+/u.test(line)) {
      if (para.length > 0) break
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') {
      if (para.length > 0) break
      continue
    }
    para.push(trimmed)
  }
  if (para.length === 0) {
    throw new Error('Markdown document is missing a first paragraph for description')
  }
  return markdownInlineToPlain(para.join(' '))
}

export function truncateMetaDescription(text, maxLength = 160) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const window = normalized.slice(0, maxLength)
  const boundary = /(?:[.!?](?=\s|$)|[。！？])/gu
  let last = -1
  let match = boundary.exec(window)
  while (match) {
    last = match.index + match[0].length
    match = boundary.exec(window)
  }
  if (last > 0) return window.slice(0, last).trim()
  const lastSpace = window.lastIndexOf(' ')
  if (lastSpace >= 40) return window.slice(0, lastSpace).trim()
  return window.trim()
}

export function extractMetaDescription(markdown) {
  return truncateMetaDescription(extractFirstParagraphFromMarkdown(markdown))
}

function replaceMarkedRegion(html, inner) {
  const start = html.indexOf(MARKER_START)
  const end = html.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`index.html must contain ${MARKER_START} and ${MARKER_END} inside #root`)
  }
  const before = html.slice(0, start + MARKER_START.length)
  const after = html.slice(end)
  return `${before}\n${inner}\n      ${after}`
}

/** Keep crawlable HTML in the document, but never paint it in visual browsers. */
function wrapAgentPublicFallback(html) {
  return `<div id="agent-public-fallback" hidden>\n${html}\n</div>`
}

/* R7-32: brand-minimum styling for the no-JS / crawler view. Production
   stamps only <title> and <body> into the SPA shell (stamp-trust-spa-html),
   so this head-only block never reaches JS users. Values mirror tokens.css. */
const STANDALONE_STYLE = `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 3rem 1.25rem 4rem;
        background: rgb(243 245 248);
        color: rgb(6 7 10);
        font-family: "Instrument Sans", "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
        line-height: 1.6;
      }
      body > * { max-width: 38rem; margin-left: auto; margin-right: auto; overflow-wrap: anywhere; }
      h1 { font-size: 1.75rem; letter-spacing: -0.02em; margin: 0 auto 1rem; }
      h2 { font-size: 1.15rem; margin: 2rem auto 0.5rem; }
      p, li { color: rgb(51 53 58); }
      a { color: rgb(56 102 149); }
      nav p { margin: 0.35rem auto; }
      pre {
        max-width: 100%;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    </style>`

function buildStandaloneDocument(title, bodyInner, description) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}" />
${STANDALONE_STYLE}
  </head>
  <body>
${bodyInner}
  </body>
</html>
`
}

function build404Body(fromMarkdown) {
  return `${fromMarkdown}
<nav>
<p><a href="/sitemap.xml">Sitemap</a></p>
<p><a href="/llms.txt">llms.txt</a></p>
</nav>`
}

function buildRobots() {
  return `User-agent: *
Allow: /
Sitemap: ${SITE_ORIGIN}/sitemap.xml
`
}

function xmlEscape(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

export function buildSitemapIndex() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${xmlEscape(`${SITE_ORIGIN}/sitemap-static.xml`)}</loc>
  </sitemap>
  <sitemap>
    <loc>${xmlEscape(`${SITE_ORIGIN}/sitemap-collections.xml`)}</loc>
  </sitemap>
  <sitemap>
    <loc>${xmlEscape(`${SITE_ORIGIN}/sitemap-profiles.xml`)}</loc>
  </sitemap>
</sitemapindex>
`
}

export function buildSitemap(pages = SITEMAP_PAGES) {
  const urls = pages.map((page) => {
    if (typeof page?.path !== 'string' || page.path.length === 0) {
      throw new Error('sitemap entry is missing path')
    }
    const hasSources = Array.isArray(page.sources) && page.sources.length > 0
    if (page.lastmod !== undefined || hasSources) {
      if (typeof page.lastmod !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(page.lastmod)) {
        throw new Error(`sitemap entry ${page.path} declares sources but no valid lastmod`)
      }
      if (!hasSources) {
        throw new Error(`sitemap entry ${page.path} declares lastmod without the sources that justify it`)
      }
    }
    const loc = `${SITE_ORIGIN}${page.path}`
    const lastmod = page.lastmod === undefined ? '' : `\n    <lastmod>${xmlEscape(page.lastmod)}</lastmod>`
    return `  <url>
    <loc>${xmlEscape(loc)}</loc>${lastmod}
  </url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`
}

function writeText(path, contents) {
  writeFileSync(path, contents, 'utf8')
}

function generate() {
  mkdirSync(publicDir, { recursive: true })
  const homeMd = normalizeMarkdown(readUtf8(join(contentDir, 'home.md')))
  const homeHtml = markdownToHtml(homeMd)
  if (!/<h1[\s>]/u.test(homeHtml)) {
    throw new Error('home.md must produce an <h1> for the index.html fallback')
  }

  const indexHtml = readUtf8(indexPath)
  const nextIndex = replaceMarkedRegion(indexHtml, wrapAgentPublicFallback(homeHtml))
  if (!nextIndex.includes('id="root"')) {
    throw new Error('Refusing to write index.html without #root')
  }
  writeText(indexPath, nextIndex)

  writeText(join(publicDir, 'home.md'), homeMd)

  for (const page of DOCUMENT_PAGES) {
    const markdown = normalizeMarkdown(readUtf8(join(contentDir, page.source)))
    const title = extractTitle(markdown)
    const description = extractMetaDescription(markdown)
    let body = markdownToHtml(markdown)
    if (page.htmlName === '404.html') body = build404Body(body)
    writeText(join(publicDir, page.htmlName), buildStandaloneDocument(title, body, description))
    writeText(join(publicDir, page.mdName), markdown)
  }

  writeText(join(publicDir, 'robots.txt'), buildRobots())
  writeText(join(publicDir, 'sitemap-static.xml'), buildSitemap())
  writeText(join(publicDir, 'sitemap.xml'), buildSitemapIndex())
  writeText(join(publicDir, 'llms.txt'), normalizeMarkdown(readUtf8(join(contentDir, 'llms.md'))))
  const indexNowKey = readUtf8(join(contentDir, 'indexnow.txt'))
  if (!/^[0-9a-f]{32}\n$/u.test(indexNowKey)) {
    throw new Error('indexnow.txt must contain exactly 32 lowercase hexadecimal characters and one newline')
  }
  writeText(join(publicDir, 'indexnow.txt'), indexNowKey)
}

const invokedAsCli = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsCli) generate()
