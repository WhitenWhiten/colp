#!/usr/bin/env node
/**
 * Contract tests for the self-hosted dist step (D15).
 *
 * Run: node --test scripts/self-hosted-dist.contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { SELF_HOSTED_ROBOTS } from './self-hosted-dist.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'self-hosted-dist.mjs')
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta name="description" content="Know-N is an online bookmark library." />
    <meta property="og:site_name" content="Know-N" />
    <meta property="og:url" content="https://know-n.com/" />
    <meta name="twitter:image" content="https://know-n.com/og-cover.png" />
    <title>Online bookmark library — Know-N</title>
    <link rel="canonical" href="https://know-n.com/" />
    <link rel="alternate" type="text/plain" title="llms.txt" href="https://know-n.com/llms.txt" />
    <script type="application/ld+json">{ "name": "Know-N" }</script>
  </head>
  <body><div id="root"><!-- agent-public:start --><div>Know-N home https://know-n.com/llms.txt</div><!-- agent-public:end --></div></body>
</html>
`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-hosted-dist-'))
  const files = {
    'index.html': INDEX, 'robots.txt': 'Allow: /\nSitemap: https://know-n.com/sitemap.xml\n',
    'sitemap.xml': '<x/>', 'llms.txt': 'Know-N', 'indexnow.txt': 'key', 'privacy.html': 'Know-N',
    'privacy.md': 'Know-N', 'login.html': 'Know-N', 'og-cover.png': 'png', 'favicon.svg': '<svg/>',
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

function run(dir, env) {
  return spawnSync(process.execPath, [script, dir], { env: { ...process.env, ...env }, encoding: 'utf8' })
}

test('self-hosted build removes know-n.com files and neutralises index.html', () => {
  const dir = fixture()
  try {
    const result = run(dir, { VITE_EDITION: 'self-hosted' })
    assert.equal(result.status, 0, result.stderr)
    for (const name of ['sitemap.xml', 'llms.txt', 'indexnow.txt', 'privacy.html', 'privacy.md', 'login.html', 'og-cover.png']) {
      assert.equal(existsSync(join(dir, name)), false, name)
    }
    assert.equal(existsSync(join(dir, 'favicon.svg')), true)
    assert.equal(readFileSync(join(dir, 'robots.txt'), 'utf8'), SELF_HOSTED_ROBOTS)
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    assert.doesNotMatch(html, /know-n\.com|Know-N/u)
    assert.match(html, /<title>COLP Server<\/title>/u)
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without VITE_EDITION=self-hosted the step changes nothing', () => {
  const dir = fixture()
  try {
    const result = run(dir, { VITE_EDITION: '' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), INDEX)
    assert.equal(existsSync(join(dir, 'llms.txt')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
