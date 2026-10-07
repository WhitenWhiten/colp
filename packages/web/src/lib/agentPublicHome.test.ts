import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const webRoot = join(import.meta.dirname, '../..')
const indexPath = join(webRoot, 'index.html')
const contentDir = join(webRoot, 'content', 'agent-public')
const PRINT_CSS_LINE = '    <link rel="stylesheet" href="/src/styles/print.css" media="print" />'

const deferredCommercialSurface =
  /\/(?:subscribe|subscriptions|checkout)(?:\/|['"`])|\b(?:billing|checkout|monetization|paid|payment|paywall|pricing|revenue|payouts?|subscription|subscriptions)\b/iu

/** Privacy copy must name read-only subscriptions and classification billing records. */
const privacyDisclosureSurface =
  /\/(?:subscribe|subscriptions|checkout)(?:\/|['"`])|\b(?:checkout|monetization|paid|payment|paywall|pricing|revenue|payouts?)\b/iu

function visibleText(html: string): string {
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/giu, '')
  const withoutStyles = withoutScripts.replace(/<style\b[\s\S]*?<\/style>/giu, '')
  return withoutStyles.replace(/<[^>]+>/gu, '')
}

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(full))
    else files.push(full)
  }
  return files
}

describe('agent-public homepage HTML', () => {
  it('ships the same <title> the hydrated Landing page writes, so raw HTML and DOM never disagree', () => {
    const html = readFileSync(indexPath, 'utf8')
    const landing = readFileSync(join(webRoot, 'src', 'pages', 'Landing.tsx'), 'utf8')
    const documentTitle = /useDocumentTitle\('([^']+)'\)/u.exec(landing)?.[1]
    expect(documentTitle).toBeTruthy()
    expect(html).toContain(`<title>${documentTitle} — Know-N</title>`)
    expect(html).not.toContain('<title>Know-N</title>')
  })

  const html = readFileSync(indexPath, 'utf8')

  it('keeps at least 500 characters of no-JS visible text with an h1', () => {
    expect(html).toContain('<h1')
    expect(visibleText(html).length).toBeGreaterThanOrEqual(500)
  })

  it('hides the agent-public fallback from visual browsers until React replaces #root', () => {
    const rootStart = html.indexOf('<div id="root">')
    const rootEnd = html.indexOf('</div>', html.indexOf('<!-- agent-public:end -->'))
    const rootHtml = html.slice(rootStart, rootEnd)
    expect(rootHtml).toMatch(/<div id="agent-public-fallback" hidden>/u)
    expect(html).toContain('#agent-public-fallback[hidden] { display: none !important; }')
    expect(html).toMatch(
      /<noscript>\s*<style>\s*@layer utilities \{\s*#agent-public-fallback\[hidden\] \{ display: block !important; \}\s*\}\s*<\/style>\s*<\/noscript>/u,
    )
    const main = readFileSync(join(webRoot, 'src/main.tsx'), 'utf8')
    // R15-19 passes createRoot error callbacks as a second argument.
    expect(main).toContain("createRoot(document.getElementById('root')!")
    expect(main).not.toMatch(/getElementById\(['"]root['"]\)[\s\S]{0,120}innerHTML\s*=/)
  })

  it('declares a homepage canonical URL', () => {
    expect(html).toContain('rel="canonical"')
    expect(html).toContain('href="https://know-n.com/"')
    expect(html).toContain('<link rel="canonical" href="https://know-n.com/" />')
  })

  it('points agents from the homepage to llms.txt and real MCP discovery', () => {
    const homeMd = readFileSync(join(contentDir, 'home.md'), 'utf8')
    expect(homeMd).toMatch(/## For agents/u)
    expect(homeMd).toContain('https://know-n.com/llms.txt')
    expect(homeMd).toContain('https://know-n.com/mcp')
    expect(homeMd).toContain('GET https://know-n.com/.well-known/mcp')
    expect(homeMd).toContain('There is no `/.well-known/mcp.json` and no `/mcp.json`.')
    expect(homeMd).toContain('POST https://know-n.com/collections/-/mcp')
    expect(homeMd).toContain('POST https://know-n.com/collections/-/mcp-compat')
    expect(homeMd).toContain('do not POST JSON-RPC there')

    expect(html).toContain(
      '<link rel="alternate" type="text/plain" title="llms.txt" href="https://know-n.com/llms.txt" />',
    )
    const start = html.indexOf('<!-- agent-public:start -->')
    const end = html.indexOf('<!-- agent-public:end -->')
    const region = html.slice(start, end)
    expect(region).toContain('href="https://know-n.com/llms.txt"')
    expect(region).toContain('/.well-known/mcp')
    expect(region).toContain('/mcp.json')
    expect(region).toContain('/collections/-/mcp-compat')
  })

  it('uses absolute OG image and url fields', () => {
    expect(html.match(/<meta property="og:locale"/gu)).toHaveLength(1)
    expect(html).toContain('<meta property="og:locale" content="en_US" />')
    expect(html).toContain('<meta property="og:url" content="https://know-n.com/" />')
    expect(html).toContain('<meta property="og:image" content="https://know-n.com/og-cover.png" />')
    expect(html).toContain('<meta property="og:image:alt" content="Know-N — Online bookmark library" />')
    expect(html).toContain('<meta name="twitter:image" content="https://know-n.com/og-cover.png" />')
    expect(html).not.toContain('content="/og-cover.png"')
  })

  it('embeds SoftwareApplication JSON-LD without offers or commercial copy', () => {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1]!) as Record<string, unknown>
    expect(data['@type']).toBe('SoftwareApplication')
    expect(data.name).toBe('Know-N')
    expect(data.url).toBe('https://know-n.com/')
    expect(typeof data.description).toBe('string')
    expect((data.description as string).length).toBeGreaterThan(0)
    expect(data).not.toHaveProperty('offers')
    expect(html).not.toMatch(/pricing|paywall/iu)
  })

  it('keeps the print.css link byte-identical', () => {
    expect(html).toContain(PRINT_CSS_LINE)
  })

  it('keeps deferred commercial language out of homepage HTML and agent-public sources', () => {
    expect(html, 'index.html').not.toMatch(deferredCommercialSurface)
    for (const file of walkFiles(contentDir)) {
      const source = readFileSync(file, 'utf8')
      const surface = file.endsWith(`${join('agent-public', 'privacy.md')}`)
        ? privacyDisclosureSurface
        : deferredCommercialSurface
      expect(source, file).not.toMatch(surface)
    }
  })
})
