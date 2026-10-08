import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error stamp script is CLI ESM outside the app tsconfig graph
import { HEAD_ONLY_SPA_PAGES, headOnlyPageTitle } from '../../scripts/stamp-trust-spa-html.mjs'

const webRoot = join(import.meta.dirname, '../..')
const stampPath = join(webRoot, 'scripts', 'stamp-trust-spa-html.mjs')
const SITE_ORIGIN = 'https://know-n.com'
const HOME_UNIQUE = 'HOME_FALLBACK_UNIQUE'
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Know-N</title>
    <meta name="description" content="Home description." />
    <link rel="canonical" href="${SITE_ORIGIN}/" />
    <meta property="og:title" content="Know-N — Online bookmark library" />
    <meta property="og:description" content="Home og description." />
    <meta property="og:url" content="${SITE_ORIGIN}/" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"SoftwareApplication","name":"Know-N","url":"${SITE_ORIGIN}/"}
    </script>
    <script type="module" src="/assets/index-TESTHASH.js"></script>
  </head>
  <body>
    <div id="root">
      <!-- agent-public:start -->
<div id="agent-public-fallback" hidden>
<h1>Know-N</h1>
<p>${HOME_UNIQUE}</p>
</div>
      <!-- agent-public:end -->
    </div>
  </body>
</html>
`

function standaloneDocument(title: string, body: string, description: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
  </head>
  <body>
${body}
  </body>
</html>
`
}

const STANDALONE = {
  'about.html': standaloneDocument(
    'About Know-N',
    '<h1>About Know-N</h1>\n<p>About body for agents and guests.</p>',
    'About Know-N is an online bookmark library for agents and guests.',
  ),
  'contact.html': standaloneDocument(
    'Contact Know-N',
    '<h1>Contact Know-N</h1>\n<p>Write to <a href="mailto:help@know-n.com">help@know-n.com</a>.</p>',
    'Write to help@know-n.com for product questions.',
  ),
  'privacy.html': standaloneDocument(
    'Privacy on Know-N',
    '<h1>Privacy on Know-N</h1>\n<p>Privacy body for agents and guests.</p>',
    'Privacy body for agents and guests.',
  ),
  'mcp.html': standaloneDocument(
    'MCP on Know-N',
    '<h1>MCP on Know-N</h1>\n<p>POST /collections/-/mcp is the protocol endpoint.</p>',
    'Know-N exposes a Model Context Protocol server for agents.',
  ),
  'developers.html': standaloneDocument(
    'Developers on Know-N',
    '<h1>Developers on Know-N</h1>\n<p>Discovery index for COLP, MCP, and markdown negotiation.</p>',
    'Discovery index for COLP, MCP, and markdown negotiation.',
  ),
  'embed-guide.html': standaloneDocument(
    'Customize Know-N embedded cards with an agent',
    '<h1>Customize Know-N embedded cards with an agent</h1><p>Choose appearance parameters.</p>',
    'Generate a card matching your website.',
  ),
  'extension.html': standaloneDocument(
    'Know-N browser extension',
    '<h1>Know-N browser extension</h1>\n<p>Capture the active page and sync selected bookmark folders.</p>',
    'Capture the active page and sync selected bookmark folders into collections you own.',
  ),
  '404.html': standaloneDocument(
    'Page not found',
    '<h1>Page not found</h1>\n<nav>\n<p><a href="/sitemap.xml">Sitemap</a></p>\n<p><a href="/llms.txt">llms.txt</a></p>\n</nav>',
    'This URL is not a published Know-N document.',
  ),
} as const

function stampStderr(error: unknown) {
  const err = error as { message: string; stderr?: string | Buffer }
  const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''
  return `${err.message}\n${stderr}`
}

function runStamp(distDir: string, publicDir: string) {
  execFileSync(process.execPath, [stampPath, '--dist', distDir, '--public', publicDir], {
    cwd: webRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function withFixture(run: (dirs: { distDir: string; publicDir: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'stamp-trust-spa-'))
  const distDir = join(root, 'dist')
  const publicDir = join(root, 'public')
  mkdirSync(distDir)
  mkdirSync(publicDir)
  writeFileSync(join(distDir, 'index.html'), INDEX_HTML, 'utf8')
  for (const [name, html] of Object.entries(STANDALONE)) {
    writeFileSync(join(publicDir, name), html, 'utf8')
  }
  try {
    run({ distDir, publicDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('stamp-trust-spa-html', () => {
  it('is wired into the production frontend build', () => {
    const pkg = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['stamp:trust-spa']).toBe('node scripts/stamp-trust-spa-html.mjs')
    expect(pkg.scripts.build).toMatch(/npm run stamp:trust-spa/)
  })

  it('clones the SPA shell and swaps the agent-public fallback per trust page', () => {
    withFixture(({ distDir, publicDir }) => {
      runStamp(distDir, publicDir)

      const about = readFileSync(join(distDir, 'about.html'), 'utf8')
      expect(about).toContain('<script type="module" src="/assets/index-TESTHASH.js">')
      expect(about).toContain('<div id="agent-public-fallback" hidden>')
      expect(about).toContain('<h1>About Know-N</h1>')
      expect(about).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/about" />`)
      expect(about).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/about" />`)
      expect(about).toContain('<title>About Know-N</title>')
      expect(about).toContain('<meta property="og:title" content="About Know-N" />')
      expect(about).toContain(
        '<meta name="description" content="About Know-N is an online bookmark library for agents and guests." />',
      )
      expect(about).toContain(
        '<meta property="og:description" content="About Know-N is an online bookmark library for agents and guests." />',
      )
      expect(about).toMatch(/<script type="application\/ld\+json">/)
      expect(about).toContain('"@type": "WebPage"')
      expect(about).toContain('"name": "About Know-N"')
      expect(about).toContain(
        '"description": "About Know-N is an online bookmark library for agents and guests."',
      )
      expect(about).toContain(`"url": "${SITE_ORIGIN}/about"`)
      expect(about).not.toContain(HOME_UNIQUE)
      expect(about).not.toContain('SoftwareApplication')
      expect(about).not.toContain(`<link rel="canonical" href="${SITE_ORIGIN}/" />`)
      expect(about).not.toContain(`<meta property="og:url" content="${SITE_ORIGIN}/" />`)

      const contact = readFileSync(join(distDir, 'contact.html'), 'utf8')
      expect(contact).toContain('mailto:help@know-n.com')
      expect(contact).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/contact" />`)
      expect(contact).toContain('<script type="module" src="/assets/index-TESTHASH.js">')

      const privacy = readFileSync(join(distDir, 'privacy.html'), 'utf8')
      expect(privacy).toContain('<h1>Privacy on Know-N</h1>')
      expect(privacy).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/privacy" />`)

      const mcp = readFileSync(join(distDir, 'mcp.html'), 'utf8')
      expect(mcp).toContain('<h1>MCP on Know-N</h1>')
      expect(mcp).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/mcp" />`)

      const guide = readFileSync(join(distDir, 'embed-guide.html'), 'utf8')
      expect(guide).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/embed-guide" />`)
      expect(guide).toContain('Choose appearance parameters.')
      const developers = readFileSync(join(distDir, 'developers.html'), 'utf8')
      expect(developers).toContain('<h1>Developers on Know-N</h1>')
      expect(developers).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/developers" />`)
      expect(developers).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/developers" />`)

      const extension = readFileSync(join(distDir, 'extension.html'), 'utf8')
      expect(extension).toContain('<h1>Know-N browser extension</h1>')
      expect(extension).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/extension" />`)
      expect(extension).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/extension" />`)
      expect(extension).toContain('<meta property="og:title" content="Know-N browser extension" />')
      expect(extension).toContain('"@type": "WebPage"')
      expect(extension).toContain(`"url": "${SITE_ORIGIN}/extension"`)

      const notFound = readFileSync(join(distDir, '404.html'), 'utf8')
      expect(notFound).toContain('<h1>Page not found</h1>')
      expect(notFound).toContain('href="/sitemap.xml"')
      expect(notFound).toContain('href="/llms.txt"')
      expect(notFound).toContain('<script type="module" src="/assets/index-TESTHASH.js">')
      expect(notFound).not.toContain('rel="canonical"')
      expect(notFound).not.toContain('property="og:url"')
      expect(notFound).not.toContain('application/ld+json')
      expect(notFound).not.toContain(HOME_UNIQUE)

      const indexAfter = readFileSync(join(distDir, 'index.html'), 'utf8')
      expect(indexAfter).toBe(INDEX_HTML)

      runStamp(distDir, publicDir)
      expect(readFileSync(join(distDir, 'about.html'), 'utf8')).toBe(about)
    })
  })

  it('stamps head-only login/register shells so sitemap URLs stop declaring the home canonical', () => {
    withFixture(({ distDir, publicDir }) => {
      runStamp(distDir, publicDir)

      const login = readFileSync(join(distDir, 'login.html'), 'utf8')
      expect(login).toContain('<script type="module" src="/assets/index-TESTHASH.js">')
      expect(login).toContain('<title>Sign in — Know-N</title>')
      expect(login).toContain('<meta property="og:title" content="Sign in — Know-N" />')
      expect(login).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/login" />`)
      expect(login).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/login" />`)
      expect(login).toContain(
        '<meta name="description" content="Sign in to Know-N to sync, organize, and share your bookmark collections." />',
      )
      expect(login).toContain('"@type": "WebPage"')
      expect(login).toContain(`"url": "${SITE_ORIGIN}/login"`)
      expect(login).toContain('<div id="agent-public-fallback" hidden>')
      expect(login).toContain('<h1>Sign in to Know-N</h1>')
      expect(login).toContain('<a href="/register">Create an account</a>')
      expect(login).not.toContain(HOME_UNIQUE)
      expect(login).not.toContain(`<link rel="canonical" href="${SITE_ORIGIN}/" />`)
      expect(login).not.toContain('name="robots"')

      const register = readFileSync(join(distDir, 'register.html'), 'utf8')
      expect(register).toContain('<title>Create account — Know-N</title>')
      expect(register).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/register" />`)
      expect(register).toContain('<h1>Create a Know-N account</h1>')
      expect(register).toContain('<a href="/login">Sign in</a>')
      expect(register).not.toMatch(/free|price|\$/i)

      // R15-24: bare /share gets its own head instead of the homepage's.
      const share = readFileSync(join(distDir, 'share.html'), 'utf8')
      expect(share).toContain('<title>Share — Know-N</title>')
      expect(share).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/share" />`)
      expect(share).toContain('<h1>Share bookmark collections with one link</h1>')
      expect(share).not.toContain(HOME_UNIQUE)
    })
  })

  it('stamps a canonical-free shell.html for nginx to serve with 503 on upstream failure (R15-22)', () => {
    withFixture(({ distDir, publicDir }) => {
      runStamp(distDir, publicDir)

      const shell = readFileSync(join(distDir, 'shell.html'), 'utf8')
      expect(shell).toContain('<script type="module" src="/assets/index-TESTHASH.js">')
      expect(shell).toContain('<title>Temporarily unavailable — Know-N</title>')
      expect(shell).toContain('<h1>Know-N is temporarily unavailable</h1>')
      expect(shell).not.toContain('rel="canonical"')
      expect(shell).not.toContain('property="og:url"')
      expect(shell).not.toContain('application/ld+json')
      expect(shell).not.toContain(HOME_UNIQUE)
    })
  })

  it('head-only titles equal the hydrated useDocumentTitle output for the same routes', () => {
    const pages = HEAD_ONLY_SPA_PAGES as ReadonlyArray<{ file: string; canonicalPath: string; documentTitle: string }>
    const titleOf = headOnlyPageTitle as (page: { documentTitle: string }) => string
    const pageSource: Record<string, string> = {
      '/login': readFileSync(join(webRoot, 'src', 'pages', 'Login.tsx'), 'utf8'),
      '/register': readFileSync(join(webRoot, 'src', 'pages', 'Register.tsx'), 'utf8'),
      '/share': readFileSync(join(webRoot, 'src', 'pages', 'share', 'ProductShare.tsx'), 'utf8'),
    }
    const useDocumentTitle = readFileSync(join(webRoot, 'src', 'lib', 'useDocumentTitle.ts'), 'utf8')
    const edition = readFileSync(join(webRoot, 'src', 'lib', 'edition.ts'), 'utf8')
    // The hook titles through brandedTitle(); the cloud product name is Know-N.
    expect(useDocumentTitle).toContain('document.title = brandedTitle(title)')
    expect(edition).toMatch(/`\$\{title\} — \$\{productName\(\)\}`/)
    expect(edition).toContain("isSelfHostedEdition() ? 'COLP Server' : 'Know-N'")
    expect(pages.map((page) => page.canonicalPath)).toEqual(['/login', '/register', '/share'])
    for (const page of pages) {
      expect(pageSource[page.canonicalPath]).toContain(`useDocumentTitle('${page.documentTitle}')`)
      expect(titleOf(page)).toBe(`${page.documentTitle} — Know-N`)
    }
  })

  it('refuses to stamp from an already-shelled public HTML file', () => {
    withFixture(({ distDir, publicDir }) => {
      writeFileSync(join(publicDir, 'about.html'), INDEX_HTML, 'utf8')
      try {
        runStamp(distDir, publicDir)
        throw new Error('expected stamp to fail')
      } catch (error) {
        const err = error as { message: string }
        if (err.message === 'expected stamp to fail') throw error
        expect(stampStderr(error)).toMatch(/standalone HTML/)
      }
    })
  })

  it('throws when a required homepage meta tag is missing', () => {
    withFixture(({ distDir, publicDir }) => {
      writeFileSync(
        join(distDir, 'index.html'),
        INDEX_HTML.replace('    <meta property="og:url" content="https://know-n.com/" />\n', ''),
        'utf8',
      )
      try {
        runStamp(distDir, publicDir)
        throw new Error('expected stamp to fail')
      } catch (error) {
        const err = error as { message: string }
        if (err.message === 'expected stamp to fail') throw error
        expect(stampStderr(error)).toMatch(/Failed to (?:replace|remove) og:url/)
      }
    })
  })
})
