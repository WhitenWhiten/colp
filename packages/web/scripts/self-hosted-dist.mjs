#!/usr/bin/env node
/**
 * Last build step for VITE_EDITION=self-hosted (D15, C1 step 4).
 *
 * `public/` and the trust-page stamping describe know-n.com: its sitemap,
 * llms.txt, IndexNow key, privacy policy, and a canonical URL on know-n.com.
 * A self-hosted server must not claim to be know-n.com or invite indexing,
 * so this step removes those files from dist/, writes a robots.txt that
 * disallows everything, and gives index.html a neutral COLP Server head.
 * Without VITE_EDITION=self-hosted it does nothing.
 *
 * Run: node scripts/self-hosted-dist.mjs [distDir]
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** know-n.com public site files. index.html stays; the SPA serves every route. */
export const KNOW_N_PUBLIC_FILES = Object.freeze([
  'sitemap.xml',
  'sitemap-static.xml',
  'llms.txt',
  'indexnow.txt',
  'og-cover.png',
  'brand-wordmark.svg',
  'brand-wordmark-dark.svg',
])

export const SELF_HOSTED_ROBOTS = 'User-agent: *\nDisallow: /\n'
export const SELF_HOSTED_TITLE = 'COLP Server'
export const SELF_HOSTED_DESCRIPTION = 'A self-hosted COLP bookmark server.'
export const SELF_HOSTED_ICON = '/colp-mark.svg'

const FALLBACK = [
  '<div id="agent-public-fallback" hidden>',
  '<h1>COLP Server</h1>',
  '<p>This is a self-hosted COLP bookmark server. Enable JavaScript to sign in.</p>',
  '</div>',
].join('\n')

/** Every stamped trust page and agent-readable Markdown copy is know-n.com content. */
function isKnowNPage(name) {
  if (name === 'index.html') return false
  return name.endsWith('.html') || name.endsWith('.md')
}

export function neutralIndexHtml(html) {
  let out = html
    // The self-hosted design is scoped to this attribute (src/styles/edition.css);
    // main.tsx sets it too, but the first paint happens before that module runs.
    .replace(/<html(?![^>]*\sdata-edition=)([^>]*)>/u, '<html$1 data-edition="self-hosted">')
    .replace(/<title>[\s\S]*?<\/title>/u, `<title>${SELF_HOSTED_TITLE}</title>`)
    // The tab shows the COLP Server mark, not the Know-N N.
    .replace(/\s*<link rel="icon" href="\/favicon\.ico"[^>]*>/u, '')
    .replace(/\s*<link rel="apple-touch-icon"[^>]*>/u, '')
    .replace(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/u, `<link rel="icon" type="image/svg+xml" href="${SELF_HOSTED_ICON}"`)
    .replace(/\s*<meta name="description" content="[^"]*"\s*\/?>/u,
      `\n    <meta name="description" content="${SELF_HOSTED_DESCRIPTION}" />\n    <meta name="robots" content="noindex, nofollow" />`)
    .replace(/\s*<meta property="og:[^"]+" content="[^"]*"\s*\/?>/gu, '')
    .replace(/\s*<meta name="twitter:[^"]+" content="[^"]*"\s*\/?>/gu, '')
    .replace(/\s*<link rel="canonical" href="[^"]*"\s*\/?>/gu, '')
    .replace(/\s*<link rel="alternate" type="text\/plain"[^>]*>/gu, '')
    .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/gu, '')
  const start = out.indexOf('<!-- agent-public:start -->')
  const end = out.indexOf('<!-- agent-public:end -->')
  if (start !== -1 && end > start) {
    out = `${out.slice(0, start + '<!-- agent-public:start -->'.length)}\n${FALLBACK}\n      ${out.slice(end)}`
  }
  return out
}

export function applySelfHostedDist(distDir) {
  for (const name of readdirSync(distDir)) {
    if (KNOW_N_PUBLIC_FILES.includes(name) || isKnowNPage(name)) {
      rmSync(join(distDir, name), { force: true })
    }
  }
  writeFileSync(join(distDir, 'robots.txt'), SELF_HOSTED_ROBOTS)
  const indexPath = join(distDir, 'index.html')
  const html = neutralIndexHtml(readFileSync(indexPath, 'utf8'))
  if (/know-n\.com|Know-N/u.test(html)) {
    throw new Error('self-hosted index.html still names Know-N or know-n.com')
  }
  writeFileSync(indexPath, html)
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.env.VITE_EDITION === 'self-hosted') {
    const distDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'))
    if (!existsSync(join(distDir, 'index.html'))) {
      console.error(`self-hosted-dist: ${distDir}/index.html is missing; run vite build first`)
      process.exit(1)
    }
    applySelfHostedDist(distDir)
    console.log('self-hosted-dist: removed know-n.com public files and neutralised index.html')
  }
}
