import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_COMPAT_INITIALIZE_INSTRUCTIONS } from './mcpCompatInitializeInstructions.fixture'
import { SITEMAP_INDEXABLE_PATHS } from './spaDocumentPrefixes'

const webRoot = join(import.meta.dirname, '../..')
const publicDir = join(webRoot, 'public')
const SITE_ORIGIN = 'https://know-n.com'

/** Plan §7.3 indexable whitelist as absolute loc values. */
const SECTION_7_3_LOCS = [
  `${SITE_ORIGIN}/`,
  `${SITE_ORIGIN}/explore`,
  `${SITE_ORIGIN}/about`,
  `${SITE_ORIGIN}/contact`,
  `${SITE_ORIGIN}/privacy`,
  `${SITE_ORIGIN}/extension`,
  `${SITE_ORIGIN}/mcp`,
  `${SITE_ORIGIN}/developers`,
  `${SITE_ORIGIN}/embed-guide`,
  `${SITE_ORIGIN}/login`,
  `${SITE_ORIGIN}/register`,
] as const

function readPublic(name: string) {
  return readFileSync(join(publicDir, name), 'utf8')
}

function parseSitemapIndex(xml: string): string[] {
  expect(xml, 'sitemap.xml must declare a sitemapindex').toMatch(/<sitemapindex\b/)
  const index = /<sitemapindex\b[^>]*>([\s\S]*)<\/sitemapindex>/u.exec(xml)
  expect(index, 'sitemap.xml root must be sitemapindex').not.toBeNull()
  const body = index?.[1] ?? ''
  const remainder = body.replace(/<sitemap>[\s\S]*?<\/sitemap>/gu, '').trim()
  expect(remainder, 'sitemapindex must contain only sitemap entries').toBe('')
  return [...body.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gu)].map((match) => {
    const loc = /<loc>([^<]*)<\/loc>/u.exec(match[1] ?? '')?.[1]
    expect(loc, 'every index child must have loc').toEqual(expect.any(String))
    return loc ?? ''
  })
}

function parseUrlset(xml: string): { loc: string; lastmod: string | undefined }[] {
  expect(xml, 'sitemap-static.xml must declare a urlset').toMatch(/<urlset\b/)
  const urlset = /<urlset\b[^>]*>([\s\S]*)<\/urlset>/u.exec(xml)
  expect(urlset, 'sitemap-static.xml root must be urlset').not.toBeNull()
  const body = urlset?.[1] ?? ''
  const remainder = body.replace(/<url>[\s\S]*?<\/url>/gu, '').trim()
  expect(remainder, 'urlset must contain only url entries').toBe('')
  return [...body.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => {
    const block = match[1] ?? ''
    const loc = /<loc>([^<]*)<\/loc>/u.exec(block)?.[1]
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/u.exec(block)?.[1]
    expect(loc, 'every url must have loc').toEqual(expect.any(String))
    return { loc: loc ?? '', lastmod }
  })
}

describe('agent-public robots, sitemap, and llms.txt', () => {
  it('publishes the exact lowercase 32-hex IndexNow verification key', () => {
    expect(readPublic('indexnow.txt')).toMatch(/^[0-9a-f]{32}\n$/u)
  })

  it('keeps sitemap.xml as an index of static + collections children', () => {
    const index = readPublic('sitemap.xml')
    expect(index).toMatch(/<sitemapindex\b/)
    expect(index).not.toMatch(/<urlset\b/)
    expect(parseSitemapIndex(index)).toEqual([
      `${SITE_ORIGIN}/sitemap-static.xml`,
      `${SITE_ORIGIN}/sitemap-collections.xml`,
      `${SITE_ORIGIN}/sitemap-profiles.xml`,
    ])
  })

  it('keeps sitemap-static.xml as a §7.3 urlset with lastmod only on source-tracked pages and no agent-file locs', () => {
    const urls = parseUrlset(readPublic('sitemap-static.xml'))
    const locs = urls.map((entry) => entry.loc)

    expect(new Set(locs)).toEqual(new Set(SECTION_7_3_LOCS))
    expect(locs).toHaveLength(SECTION_7_3_LOCS.length)
    expect(locs.sort()).toEqual(
      SITEMAP_INDEXABLE_PATHS.map((path) => `${SITE_ORIGIN}${path}`).sort(),
    )

    const withoutLastmod = urls.filter((entry) => entry.lastmod === undefined).map((entry) => entry.loc).sort()
    expect(withoutLastmod).toEqual([`${SITE_ORIGIN}/explore`, `${SITE_ORIGIN}/login`, `${SITE_ORIGIN}/register`])
    for (const entry of urls) {
      if (entry.lastmod !== undefined) expect(entry.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(locs.some((loc) => loc.includes('#'))).toBe(false)
    expect(locs.some((loc) => loc.includes('/robots.txt'))).toBe(false)
    expect(locs.some((loc) => loc.includes('/sitemap.xml'))).toBe(false)
    expect(locs.some((loc) => loc.includes('/llms.txt'))).toBe(false)
  })

  it('keeps llms.txt as when-to-use guidance with collection work and COLP discovery', () => {
    const llms = readPublic('llms.txt')
    expect(llms).toMatch(/when to use/i)
    expect(llms).toMatch(/save/i)
    expect(llms).toMatch(/sync/i)
    expect(llms).toMatch(/organiz/i)
    expect(llms).toMatch(/share/i)
    expect(llms).toContain('/.well-known/collection-protocol')
    expect(llms).toContain('/.well-known/mcp')
    expect(llms).toContain('/collections/-/mcp')
    expect(llms).toContain('https://know-n.com/mcp')
    expect(llms).toContain('https://know-n.com/developers')
  })

  it('keeps MCP discovery copy pointing at the protocol endpoint, not /mcp POST', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')
    const about = readPublic('about.html')
    const notFound = readPublic('404.html')

    expect(mcp).toContain('POST https://know-n.com/collections/-/mcp')
    expect(mcp).toContain('/.well-known/mcp')
    expect(mcp).toContain('/.well-known/oauth-protected-resource')
    expect(mcp).toContain('/.well-known/oauth-authorization-server/api/v1/auth')
    expect(mcp).toMatch(/API[- ]key/i)
    expect(mcp).toContain('Do not POST JSON-RPC to')
    expect(mcp).toContain('/mcp')
    expect(llms).toContain('POST https://know-n.com/collections/-/mcp')
    expect(llms).toContain('/.well-known/mcp')
    expect(llms).toContain('do not POST JSON-RPC there')
    expect(llms).toContain('There is no `/.well-known/mcp.json` and no `/mcp.json`.')
    expect(about).toContain('href="/mcp"')
    expect(notFound).toContain('/mcp')
  })

  it('documents enabled MCP write tools, scopes, and /approvals as a second gate', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')

    expect(mcp).toContain('nodes.create')
    expect(mcp).toContain('changes.plan')
    expect(mcp).toContain('changes.commit')
    expect(mcp).toContain('changes.cancel')
    expect(mcp).toContain('Scopes are per tool')
    expect(mcp).toContain('nodes.create` needs `nodes:write')
    expect(mcp).toContain('changes.plan` needs `nodes:write` and `access:write')
    expect(mcp).toContain('changes.commit` needs those plus `changes:commit')
    expect(mcp).toContain('changes.cancel` needs `changes:cancel')
    expect(mcp).not.toMatch(/They require `nodes:write`, `access:write`, `changes:commit`, and `changes:cancel`/u)
    expect(mcp).toContain('nodes:write')
    expect(mcp).toContain('access:write')
    expect(mcp).toContain('changes:commit')
    expect(mcp).toContain('changes:cancel')
    expect(mcp).toContain('/approvals')
    expect(mcp).toContain('GET /api/v1/mcp/approvals')
    expect(mcp).toContain('401')
    expect(mcp).not.toMatch(/are off until that gate is enabled/i)
    expect(mcp).not.toMatch(/A 404 on \/api\/v1\/mcp\/approvals/i)
    expect(mcp).toContain('nodes.get')
    expect(mcp).toContain('nodes.update')
    expect(mcp).toContain('collections.update')
    expect(mcp).toContain('annotations.create')
    expect(mcp).toContain('changes.get')
    expect(mcp).toContain('not bookmark `note`/`tldr` fields')
    expect(mcp).not.toMatch(/recommendedClients/)
    expect(llms).toContain('nodes.create')
    expect(llms).toContain('changes.plan')
    expect(llms).toContain('per-tool scopes')
    expect(llms).toContain('/approvals')
    expect(llms).toContain('nodes.get')
    expect(llms).toContain('nodes.update')
    expect(llms).toContain('collections.update')
    expect(llms).toContain('annotations.create')
    expect(llms).toContain('changes.get')
    expect(llms).toContain('User-Agent')
    expect(llms).toContain('unpublished')
    expect(llms).toContain('pending plan')
  })

  it('documents anonymous public read tools on /mcp and llms.txt', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')

    expect(mcp).toContain('collections.get')
    expect(mcp).toContain('collections.get_snapshot')
    expect(mcp).toContain('nodes.get')
    expect(mcp).toContain('nodes.update')
    expect(mcp).toContain('collections.update')
    expect(mcp).toContain('annotations.create')
    expect(mcp).toContain('changes.get')
    expect(mcp).toContain('not bookmark `note`/`tldr` fields')
    expect(mcp).not.toMatch(/recommendedClients/)
    expect(mcp).not.toMatch(/Anonymous `tools\/list` is allowed but returns no tools/i)
    expect(llms).toContain('collections.get')
    expect(llms).toContain('collections.get_snapshot')
    expect(llms).toContain('nodes.get')
    expect(llms).toContain('nodes.update')
    expect(llms).toContain('collections.update')
    expect(llms).toContain('annotations.create')
    expect(llms).toContain('changes.get')
    expect(llms).not.toMatch(/only tools require the OAuth consent above/i)
  })

  it('documents Known MCP server identity and mcp-read/mcp-write COLP claims', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')

    expect(mcp).toContain('Known MCP')
    expect(mcp).toContain('mcp-read')
    expect(mcp).toContain('mcp-write')
    expect(mcp).toContain('/.well-known/collection-protocol')
    expect(llms).toContain('Known MCP')
    expect(llms).toContain('mcp-read')
    expect(llms).toContain('mcp-write')
  })

  it('documents the actually supported OAuth grant and token-auth subset', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')

    expect(mcp).toContain('authorization_code')
    expect(mcp).toContain('refresh_token')
    expect(mcp).toContain('offline_access')
    expect(mcp).toContain('3600')
    expect(mcp).toMatch(/token-endpoint authentication `none`/)
    expect(mcp).toContain('client_credentials')
    expect(mcp).toContain('private_key_jwt')
    expect(llms).toContain('authorization_code')
    expect(llms).toContain('refresh_token')
    expect(llms).toContain('offline_access')
    expect(llms).toContain('3600')
    expect(llms).toContain('none')
  })

  it('documents RFC 7591 DCR as the OAuth client registration fallback', () => {
    const mcp = readPublic('mcp.html')
    const llms = readPublic('llms.txt')

    expect(mcp).toContain('oauth2/register')
    expect(mcp).toContain('RFC 7591')
    expect(mcp).not.toMatch(/intentionally returns 404/i)
    expect(mcp).not.toMatch(/Do not call `\/oauth2\/register`/i)
    expect(llms).toContain('oauth2/register')
  })

  it('documents loopback CIMD callbacks that omit the port', () => {
    const mcp = readPublic('mcp.html')

    expect(mcp).toContain('http://localhost/callback')
    expect(mcp).toContain('ephemeral port')
    expect(mcp).not.toMatch(/localhost` redirect URIs must match the registered port exactly/i)
  })

  it('documents the CIMD Content-Type hard check and GitHub/Gist raw counterexamples', () => {
    const mcp = readPublic('mcp.html')

    expect(mcp).toContain('Content-Type')
    expect(mcp).toContain('application/json')
    expect(mcp).toContain('*+json')
    expect(mcp).toContain('GitHub raw')
    expect(mcp).toContain('Gist raw')
    expect(mcp).toContain('text/plain')
  })

  it('keeps robots.txt allowing the origin and pointing at the sitemap', () => {
    const robots = readPublic('robots.txt')
    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    expect(robots).toContain('Sitemap: https://know-n.com/sitemap.xml')
  })
})

const MCP_COMPAT_TABLE_COLUMNS = [
  'client',
  'tested client version',
  'tested date',
  'transport',
  'requested/negotiated protocol',
  'auth registration',
  'anonymous/read/write/approval result',
  'known limitations',
] as const

function markdownSection(markdown: string, heading: string): string {
  const marker = `## ${heading}\n`
  const start = markdown.indexOf(marker)
  if (start < 0) return ''
  const bodyStart = start + marker.length
  const next = markdown.indexOf('\n## ', bodyStart)
  return next < 0 ? markdown.slice(bodyStart) : markdown.slice(bodyStart, next)
}

function markdownTableRows(markdown: string): string[][] {
  const lines = markdown.split('\n').filter((line) => line.trim().startsWith('|'))
  return lines
    .filter((line) => !/^\|[\s:-|]+\|$/u.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/u, '')
        .replace(/\|$/u, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
}

function fenceBody(markdown: string, lang: string, needle: string): string {
  const blocks = [...markdown.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'gu'))]
  const found = blocks.find((block) => (block[1] ?? '').includes(needle))
  return found?.[1] ?? ''
}

describe('T-10 MCP endpoint chooser and compatibility measurements', () => {
  it('documents the strict vs compat chooser without listing 2025-06-18 as supported', () => {
    const mcp = readPublic('mcp.md')
    const chooser = markdownSection(mcp, 'Choose an endpoint')

    expect(chooser.length, 'mcp.md must have ## Choose an endpoint').toBeGreaterThan(0)
    expect(chooser).toContain('POST https://know-n.com/collections/-/mcp')
    expect(chooser).toContain('COLP')
    expect(chooser).toContain('2026-07-28')
    expect(chooser).toMatch(/Profile only/i)
    expect(chooser).toContain('POST https://know-n.com/collections/-/mcp-compat')
    expect(chooser).toMatch(/host compatibility/i)
    expect(chooser).toContain('supported versions only `2025-11-25`')
    expect(chooser).not.toContain('2025-06-18')
  })

  it('pins a client matrix with required columns, Not tested cells, and no speculative checkmarks', () => {
    const mcp = readPublic('mcp.md')
    const rows = markdownTableRows(mcp)
    const header = rows.find((row) => row[0]?.toLowerCase() === 'client')
    expect(header, 'mcp.md must include the T-10 client matrix').toBeDefined()
    expect(header?.map((cell) => cell.toLowerCase())).toEqual([...MCP_COMPAT_TABLE_COLUMNS])

    const body = rows.filter((row) => row !== header)
    expect(body.some((row) => row.join(' ').includes('Not tested'))).toBe(true)
    expect(mcp).not.toContain('✅')

    const codex = body.find((row) => /Codex CLI/u.test(row[0] ?? ''))
    const claude = body.find((row) => /Claude Code/u.test(row[0] ?? ''))
    expect(codex).toBeDefined()
    expect(claude).toBeDefined()
    expect(codex?.[1]).toBe('0.150.1')
    expect(codex?.[2]).toBe('2026-08-28')
    expect(codex?.[3]).toMatch(/Streamable HTTP/i)
    expect(codex?.join(' ')).toMatch(/2025-06-18/)
    expect(codex?.join(' ')).toMatch(/2025-11-25/)
    expect(codex?.slice(5).join(' ')).toContain('Not tested')
    expect(claude?.[1]).toBe('2.1.250')
    expect(claude?.[2]).toBe('2026-08-28')
    expect(claude?.[3]).toMatch(/Streamable HTTP/i)
    expect(claude?.join(' ')).toMatch(/2025-11-25/)
    expect(claude?.slice(5).join(' ')).toContain('Not tested')
  })

  it('records handshake facts without a Codex/Claude support or write/OAuth verification claim', () => {
    const mcp = readPublic('mcp.md')
    const llms = readPublic('llms.txt')

    expect(mcp).toMatch(/requested `2025-06-18`/u)
    expect(mcp).toMatch(/negotiated `2025-11-25`/u)
    expect(mcp).toMatch(/not operational `2025-06-18` support/i)
    expect(mcp).toMatch(/only speak `2025-06-18` are unsupported|`2025-06-18`-only clients are unsupported/i)
    expect(mcp).toMatch(/requested, negotiated, and (?:ran|operational) `2025-11-25`/i)
    expect(mcp).toContain('405')
    expect(mcp).toContain('text/plain')
    expect(mcp).toContain('Method not allowed.')
    expect(mcp).toMatch(/beta\/unverified/i)
    expect(mcp).toContain('2026-08-28')
    expect(mcp).toMatch(/handshake/i)
    expect(mcp).toMatch(/not a (?:full )?support claim/i)
    expect(mcp).not.toMatch(/verified for write/i)
    expect(mcp).not.toMatch(/verified for OAuth/i)
    expect(mcp).not.toMatch(/recommendedClients/)
    expect(llms).not.toMatch(/verified for write/i)
    expect(llms).not.toMatch(/verified for OAuth/i)
  })

  it('documents capability delta, dual OAuth resources, no error fallback, and stateless compat', () => {
    const mcp = readPublic('mcp.md')

    expect(mcp).toMatch(/resources\/subscribe/)
    expect(mcp).toMatch(/listChanged/)
    expect(mcp).toMatch(/server-to-client/)
    expect(mcp).toMatch(/prompts/)
    expect(mcp).toContain('approvalUri')
    expect(mcp).toContain(MCP_COMPAT_INITIALIZE_INSTRUCTIONS)
    expect(mcp).toMatch(/stateless/i)
    expect(mcp).toMatch(/session id/i)
    expect(mcp).toContain('https://know-n.com/collections/-/mcp')
    expect(mcp).toContain('https://know-n.com/collections/-/mcp-compat')
    expect(mcp).toMatch(/token `aud` is the URL the client is calling/i)
    expect(mcp).not.toMatch(/OAuth audience is the strict URL/i)
    expect(mcp).not.toMatch(/try the other endpoint/i)
    expect(mcp).toMatch(/Do not treat HTTP 401, 403, or 5xx/i)
    expect(mcp).toContain('--scope user')
    expect(mcp).toMatch(/2\.1\.250.{0,8}must use the compatibility URL/i)
    expect(mcp).not.toMatch(/已支持 Claude Code 写入/u)
    expect(mcp).toContain('User-Agent')
    expect(mcp).toContain('Error 1010')
    expect(mcp).toContain('unpublished')
    expect(mcp).toContain('pending plan')
    expect(mcp).toContain('collections/get')
    expect(mcp).toContain('collection resource')
  })

  it('copies the measured Codex and Claude handshake configs with the production origin only', () => {
    const mcp = readPublic('mcp.md')
    const toml = fenceBody(mcp, 'toml', 'mcp_servers.known_compat')
    const jsonRaw = fenceBody(mcp, 'json', 'mcpServers')

    expect(toml).toBe(
      [
        '[mcp_servers.known_compat]',
        'url = "https://know-n.com/collections/-/mcp-compat"',
        'enabled = true',
        '',
      ].join('\n'),
    )
    expect(JSON.parse(jsonRaw)).toEqual({
      mcpServers: {
        'known-compat': {
          type: 'http',
          url: 'https://know-n.com/collections/-/mcp-compat',
        },
      },
    })
    expect(mcp).toMatch(/Do not enable[^`]*`mcp_2026_07_28`/u)
  })

  it('keeps llms.txt as a short chooser that does not treat handshake as full support', () => {
    const llms = readPublic('llms.txt')

    expect(llms).toContain('POST https://know-n.com/collections/-/mcp')
    expect(llms).toContain('POST https://know-n.com/collections/-/mcp-compat')
    expect(llms).toContain('2026-07-28')
    expect(llms).toContain('supported versions only `2025-11-25`')
    expect(llms).toContain('Codex CLI 0.150.1')
    expect(llms).toContain('Claude Code 2.1.250')
    expect(llms).toMatch(/handshake/i)
    expect(llms).toMatch(/not a full support claim/i)
    expect(llms).toMatch(/request(?:ed)? `2025-06-18`/i)
    expect(llms).toMatch(/negotiat(?:ed|e) `2025-11-25`/i)
    expect(llms).toMatch(/[Oo]ther and older clients are unsupported/)
    expect(llms).toContain('https://know-n.com/mcp')

    const supportedMentions = [...llms.matchAll(/supported versions only `([^`]+)`/gu)].map(
      (match) => match[1],
    )
    expect(supportedMentions).toEqual(['2025-11-25'])
  })
})
