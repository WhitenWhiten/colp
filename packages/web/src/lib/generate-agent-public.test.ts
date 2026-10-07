import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error generator is CLI ESM outside the app tsconfig graph
import { SITEMAP_PAGES, buildSitemap, buildSitemapIndex, extractMetaDescription, truncateMetaDescription } from '../../scripts/generate-agent-public.mjs'
import { MCP_COMPAT_INITIALIZE_INSTRUCTIONS } from './mcpCompatInitializeInstructions.fixture'
import { SITEMAP_INDEXABLE_PATHS } from './spaDocumentPrefixes'
import { appearanceChoices, appearanceColors, appearanceNumbers, parseEmbedAppearance } from '../pages/share/embedAppearance'

const webRoot = join(import.meta.dirname, '../..')
const indexPath = join(webRoot, 'index.html')
const publicDir = join(webRoot, 'public')
const generatorPath = join(webRoot, 'scripts', 'generate-agent-public.mjs')
const PRINT_CSS_LINE = '    <link rel="stylesheet" href="/src/styles/print.css" media="print" />'
const SITE_ORIGIN = 'https://know-n.com'
type SitemapPage = { path: string; lastmod?: string; sources?: string[] }
const sitemapPages = SITEMAP_PAGES as SitemapPage[]
const REQUIRED_PUBLIC_FILES = [
  'about.html',
  'contact.html',
  'privacy.html',
  'mcp.html',
  'developers.html',
  'embed-guide.html',
  'extension.html',
  '404.html',
  'home.md',
  'about.md',
  'contact.md',
  'privacy.md',
  'mcp.md',
  'developers.md',
  'embed-guide.md',
  'extension.md',
  '404.md',
  'robots.txt',
  'sitemap.xml',
  'sitemap-static.xml',
  'llms.txt',
  'indexnow.txt',
]

function runGenerate() {
  execFileSync(process.execPath, [generatorPath], { cwd: webRoot, stdio: 'pipe' })
}

function readPublic(name: string) {
  return readFileSync(join(publicDir, name), 'utf8')
}

function snapshotOutputs(): Record<string, string> {
  const files: Record<string, string> = {
    'index.html': readFileSync(indexPath, 'utf8'),
  }
  for (const name of REQUIRED_PUBLIC_FILES) {
    files[name] = readPublic(name)
  }
  return files
}

function parseSitemapIndex(xml: string) {
  expect(xml).toMatch(/<sitemapindex\b/)
  const blocks = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gu)].map((match) => match[1])
  return blocks.map((block) => /<loc>([^<]*)<\/loc>/u.exec(block!)?.[1])
}

function parseUrlset(xml: string) {
  expect(xml).toMatch(/<urlset\b/)
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => match[1])
  const urls = blocks.map((block) => {
    const loc = /<loc>([^<]*)<\/loc>/u.exec(block!)?.[1]
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/u.exec(block!)?.[1]
    return { loc, lastmod }
  })
  return urls
}

function tryXmllint(name: string) {
  try {
    execFileSync('xmllint', ['--noout', join(publicDir, name)], { stdio: 'pipe' })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

describe('generate-agent-public', () => {
  it('writes every frozen output with crawlable contracts', () => {
    runGenerate()

    for (const name of REQUIRED_PUBLIC_FILES) {
      expect(existsSync(join(publicDir, name)), name).toBe(true)
    }
    expect(existsSync(join(publicDir, 'index.md'))).toBe(false)
    expect(existsSync(join(publicDir, 'home.md'))).toBe(true)

    const indexHtml = readFileSync(indexPath, 'utf8')
    expect(indexHtml).toContain('id="root"')
    expect(indexHtml).toContain('<!-- agent-public:start -->')
    expect(indexHtml).toContain('<!-- agent-public:end -->')
    expect(indexHtml).toContain(PRINT_CSS_LINE)
    expect(indexHtml.match(/<meta property="og:locale"/gu)).toHaveLength(1)
    expect(indexHtml).toContain('<meta property="og:locale" content="en_US" />')

    const start = indexHtml.indexOf('<!-- agent-public:start -->')
    const end = indexHtml.indexOf('<!-- agent-public:end -->')
    const region = indexHtml.slice(start, end)
    expect(region).toMatch(/<div id="agent-public-fallback" hidden>/u)
    expect(region).toMatch(/<h1[\s>]/u)

    const notFound = readPublic('404.html')
    expect(notFound.startsWith('<!doctype html>\n')).toBe(true)
    expect(notFound).toContain('<html lang="en">')
    expect(notFound).toContain('/sitemap.xml')
    expect(notFound).toContain('/llms.txt')
    expect(notFound).toContain('/mcp')
    expect(notFound).toMatch(/<a\s+href="\/sitemap.xml"/u)
    expect(notFound).toMatch(/<a\s+href="\/llms.txt"/u)

    for (const name of ['about.html', 'contact.html', 'privacy.html', 'mcp.html', 'developers.html', 'embed-guide.html', 'extension.html', '404.html'] as const) {
      const html = readPublic(name)
      expect(html.startsWith('<!doctype html>\n'), name).toBe(true)
      expect(html, name).toContain('<html lang="en">')
      expect(html, name).toMatch(/<meta charset="UTF-8" \/>/)
      expect(html, name).toMatch(/<meta name="description" content="[^"]+" \/>/)
      expect(html, name).toMatch(/<h1[\s>]/u)
      expect(html, name).not.toMatch(/<script type="module"/u)
      expect(html, name).not.toMatch(/src="\/assets\//u)
      const description = /<meta name="description" content="([^"]+)" \/>/u.exec(html)?.[1]
      expect(description, name).toEqual(expect.any(String))
      expect(description?.length, name).toBeGreaterThan(0)
      expect(description?.length, name).toBeLessThanOrEqual(160)
    }

    expect(readPublic('about.html')).toContain(
      'content="Know-N is an online bookmark library for saving, syncing, organizing, and sharing collections and public reading paths."',
    )
    expect(readPublic('extension.html')).toContain(
      'content="Use the Know-N browser extension to capture the active page and sync selected bookmark folders into collections you own."',
    )
    expect(readPublic('mcp.html')).toMatch(/pre\s*\{[^}]*white-space:\s*pre-wrap/)
    expect(readPublic('mcp.html')).toMatch(/pre\s*\{[^}]*overflow-wrap:\s*anywhere/)

    expect(readPublic('robots.txt')).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)
    expect(readPublic('indexnow.txt')).toMatch(/^[0-9a-f]{32}\n$/u)

    const indexLocs = parseSitemapIndex(readPublic('sitemap.xml'))
    expect(indexLocs).toEqual([
      `${SITE_ORIGIN}/sitemap-static.xml`,
      `${SITE_ORIGIN}/sitemap-collections.xml`,
      `${SITE_ORIGIN}/sitemap-profiles.xml`,
    ])
    expect(readPublic('sitemap.xml')).not.toMatch(/<lastmod>/u)
    expect(readPublic('sitemap.xml')).not.toMatch(/<urlset\b/)

    const sitemap = parseUrlset(readPublic('sitemap-static.xml'))
    const locs = sitemap.map((entry) => entry.loc)
    const expectedLocs = SITEMAP_INDEXABLE_PATHS.map((path) => `${SITE_ORIGIN}${path}`)
    expect(locs).toEqual(expectedLocs)
    expect(sitemap.map((entry) => entry.lastmod)).toEqual(sitemapPages.map((page) => page.lastmod))
    for (const page of sitemapPages) {
      if (page.sources) {
        expect(page.lastmod, `${page.path} has sources so it must declare lastmod`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      } else {
        expect(page.lastmod, `${page.path} has no tracked sources so it must not invent lastmod`).toBeUndefined()
      }
    }
    expect(sitemapPages.filter((page) => !page.sources).map((page) => page.path)).toEqual(['/explore', '/login', '/register'])
    expect(locs.some((loc) => loc?.includes('robots.txt'))).toBe(false)
    expect(locs.some((loc) => loc?.includes('sitemap.xml'))).toBe(false)
    expect(locs.some((loc) => loc?.includes('llms.txt'))).toBe(false)
    expect(locs.some((loc) => loc?.includes('#'))).toBe(false)

    tryXmllint('sitemap.xml')
    tryXmllint('sitemap-static.xml')

    const before = snapshotOutputs()
    runGenerate()
    expect(snapshotOutputs()).toEqual(before)
  })

  it('truncates descriptions at English and Chinese sentence boundaries', () => {
    const english = extractMetaDescription(
      '# Title\n\nKnow-N is an online bookmark library for saving, syncing, organizing, and sharing collections and public reading paths. It is a place to keep pages you already care about, group them into collections you own, and publish a reading path when you want other people to follow the same sequence.\n',
    )
    expect(english).toBe(
      'Know-N is an online bookmark library for saving, syncing, organizing, and sharing collections and public reading paths.',
    )
    expect(english.length).toBeLessThanOrEqual(160)

    const chineseFirst = `这是第一句${'甲'.repeat(90)}。`
    const chineseSecond = `这是第二句${'乙'.repeat(90)}。`
    expect(chineseFirst.length + chineseSecond.length).toBeGreaterThan(160)
    const chinese = extractMetaDescription(`# 标题\n\n${chineseFirst}${chineseSecond}\n`)
    expect(chinese).toBe(chineseFirst)

    const chineseExclaim = truncateMetaDescription(
      `${'这是一句用感叹号结束的很长说明'.repeat(8)}！${'后面还有更多文字'.repeat(8)}。`,
    )
    expect(chineseExclaim.endsWith('！')).toBe(true)
    expect(chineseExclaim.length).toBeLessThanOrEqual(160)

    const noBoundary = truncateMetaDescription('单词 '.repeat(80).trim())
    expect(noBoundary.length).toBeLessThanOrEqual(160)
    expect(noBoundary.includes('单词')).toBe(true)
  })

  it('takes sitemap lastmod from the page table, not Date.now(), and only with sources that justify it', () => {
    const xml = buildSitemap([{ path: '/about', lastmod: '2020-01-02', sources: ['content/agent-public/about.md'] }])
    expect(xml).toContain('<lastmod>2020-01-02</lastmod>')
    expect(xml).not.toContain(`<lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>`)
    const untracked = buildSitemap([{ path: '/explore' }])
    expect(untracked).toContain('<loc>https://know-n.com/explore</loc>')
    expect(untracked).not.toContain('<lastmod>')
    expect(() => buildSitemap([{ path: '/about', sources: ['content/agent-public/about.md'] }])).toThrow(/no valid lastmod/)
    expect(() => buildSitemap([{ path: '/about', lastmod: '', sources: ['content/agent-public/about.md'] }])).toThrow(/no valid lastmod/)
    expect(() => buildSitemap([{ path: '/about', lastmod: '2020-01-02' }])).toThrow(/without the sources/)
    expect(sitemapPages.find((page) => page.path === '/extension')?.lastmod).toBe('2026-08-31')
    for (const page of sitemapPages) {
      for (const source of page.sources ?? []) {
        expect(existsSync(join(webRoot, source)), `${page.path} source ${source} must exist`).toBe(true)
      }
    }
  })

  it('builds a loc-only sitemap index for the static and collections children', () => {
    const xml = buildSitemapIndex()
    expect(xml).toContain('<sitemapindex ')
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/sitemap-static.xml</loc>`)
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/sitemap-collections.xml</loc>`)
    expect(xml).not.toContain('<lastmod>')
    expect(xml).not.toContain(new Date().toISOString().slice(0, 10))
  })

  it('publishes the linked embed guide verbatim and serves it as Markdown', () => {
    const guide = readPublic('embed-guide.md')
    expect(guide).toBe(readFileSync(join(webRoot, 'content/agent-public/embed-guide.md'), 'utf8'))
    expect(readPublic('llms.txt')).toContain('https://know-n.com/embed-guide.md')
    expect(readPublic('developers.md')).toContain('(/embed-guide)')
    expect(readPublic('developers.html')).toContain('href="/embed-guide"')
    expect(guide).toContain('/reports/{slug}/issues/{editionId}?embed=1')
    for (const key of [...Object.keys(appearanceChoices), ...appearanceColors, ...Object.keys(appearanceNumbers)]) {
      expect(guide, `public guide documents ${key}`).toContain(`- ${key}:`)
    }
    for (const [key, range] of Object.entries(appearanceNumbers)) {
      expect(guide).toContain(`- ${key}: integer ${range.min}–${range.max}`)
    }
    const sample = /src="([^"]+)"/u.exec(guide)?.[1]
    expect(sample).toBeDefined()
    const params = new URL(sample!.replaceAll('&amp;', '&')).searchParams
    expect(params.get('embed')).toBe('1')
    params.delete('embed')
    expect(parseEmbedAppearance(params)).toEqual(Object.fromEntries(params))

    expect(guide).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"')
    const nginx = readFileSync(join(webRoot, 'upstream-fixtures/nginx.conf'), 'utf8')
    const location = nginx.slice(nginx.indexOf('location = /embed-guide.md'), nginx.indexOf('location = /developers.md'))
    expect(location).toContain('default_type "text/markdown; charset=utf-8"')
    expect(location).toContain('try_files $uri =404')
  })

  it('keeps generated mcp.md and llms.txt byte-identical to agent-public sources', () => {
    runGenerate()
    const contentDir = join(webRoot, 'content', 'agent-public')
    const normalize = (source: string) => `${source.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\s+$/u, '')}\n`
    expect(readPublic('mcp.md')).toBe(normalize(readFileSync(join(contentDir, 'mcp.md'), 'utf8')))
    expect(readPublic('extension.md')).toBe(normalize(readFileSync(join(contentDir, 'extension.md'), 'utf8')))
    expect(readPublic('llms.txt')).toBe(normalize(readFileSync(join(contentDir, 'llms.md'), 'utf8')))
  })

  it('pins the compat chooser, singleton 11-25 allowlist, and frozen write-approval instructions', () => {
    runGenerate()
    const mcp = readPublic('mcp.md')
    const llms = readPublic('llms.txt')
    const chooserStart = mcp.indexOf('## Choose an endpoint\n')
    const chooserBodyStart = chooserStart + '## Choose an endpoint\n'.length
    const chooserEnd = mcp.indexOf('\n## ', chooserBodyStart)
    const chooser = chooserStart < 0 ? '' : mcp.slice(chooserBodyStart, chooserEnd < 0 ? undefined : chooserEnd)

    expect(chooser).toContain('POST https://know-n.com/collections/-/mcp')
    expect(chooser).toContain('POST https://know-n.com/collections/-/mcp-compat')
    expect(chooser).toContain('supported versions only `2025-11-25`')
    expect(chooser).not.toContain('2025-06-18')
    expect(mcp).toContain('2025-06-18')
    expect(mcp).toMatch(/requested `2025-06-18`/u)
    expect(mcp).not.toMatch(/supported versions[^\n]*2025-06-18/u)
    expect(llms).not.toMatch(/supported versions[^\n]*2025-06-18/u)
    expect(mcp).toContain(MCP_COMPAT_INITIALIZE_INSTRUCTIONS)
    expect(sitemapPages.find((page) => page.path === '/')?.lastmod).toBe('2026-09-28')
    expect(sitemapPages.find((page) => page.path === '/mcp')?.lastmod).toBe('2026-08-29')
  })

  it('declared lastmod is never older than the last commit that touched its sources (full clones only)', () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: webRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    let shallow = 'false'
    try {
      shallow = git('rev-parse', '--is-shallow-repository')
    } catch {
      return // not a git checkout (packed source); nothing to compare against
    }
    if (shallow === 'true') return // CI shallow clone: history is truncated, comparison would be meaningless
    const stale: string[] = []
    for (const page of sitemapPages) {
      if (!page.sources || !page.lastmod) continue
      const committed = git('log', '-1', '--format=%cs', '--', ...page.sources)
      if (committed && committed > page.lastmod) {
        stale.push(`${page.path}: lastmod ${page.lastmod} but ${page.sources.join(', ')} last changed ${committed}`)
      }
    }
    expect(stale, 'bump SITEMAP_PAGES lastmod when its sources change (or leave uncommitted edits out of this check)').toEqual([])
  })
})
