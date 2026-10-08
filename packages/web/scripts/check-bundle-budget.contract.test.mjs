#!/usr/bin/env node
/**
 * Contract tests for the homepage entry gzip budget gate.
 *
 * Run: node --test scripts/check-bundle-budget.contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkEntryBudget, checkStylesheetBudget, entryScriptSrc, inlinedStylesheets } from './check-bundle-budget.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-bundle-budget.mjs')

function fixtureDist(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

test('entryScriptSrc prefers assets/index-*.js over other module scripts', () => {
  const html = `
    <link rel="modulepreload" href="/assets/Explore-aaaa.js" />
    <script type="module" crossorigin src="/assets/vendor-bbbb.js"></script>
    <script type="module" crossorigin src="/assets/index-cccc.js"></script>
  `
  assert.equal(entryScriptSrc(html), '/assets/index-cccc.js')
})

test('under-budget entry passes; over-budget entry fails', () => {
  const dir = fixtureDist({
    'index.html': '<script type="module" src="/assets/index-ok.js"></script>',
    'assets/index-ok.js': 'export default 1\n',
  })
  try {
    const pass = checkEntryBudget(dir, 10_000)
    assert.equal(pass.ok, true)
    assert.equal(pass.src, '/assets/index-ok.js')
    assert.ok(pass.gzip > 0)
    const fail = checkEntryBudget(dir, 1)
    assert.equal(fail.ok, false)
    assert.equal(fail.gzip, pass.gzip)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exits 0 under budget and 1 over budget', () => {
  const dir = fixtureDist({
    'index.html': '<script type="module" src="/assets/index-cli.js"></script>',
    'assets/index-cli.js': 'export default 1\n',
  })
  try {
    const pass = spawnSync(process.execPath, [script, '--dist', dir, '--budget', '10000'], { encoding: 'utf8' })
    assert.equal(pass.status, 0, pass.stderr)
    assert.match(pass.stdout, /\[bundle-budget] entry gzip \d+ \/ 10000 bytes/)
    const fail = spawnSync(process.execPath, [script, '--dist', dir, '--budget', '1'], { encoding: 'utf8' })
    assert.equal(fail.status, 1)
    assert.match(fail.stderr, /over budget/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inlinedStylesheets flags only data: stylesheet links', () => {
  const html = `
    <link rel="stylesheet" href="data:text/css;base64,QGxheWVy" media="print" />
    <link rel="stylesheet" crossorigin href="/assets/index-aaaa.css">
    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E">
  `
  const found = inlinedStylesheets(html)
  assert.equal(found.length, 1)
  assert.match(found[0], /media="print"/)
})

test('CLI exits 1 when a stylesheet is inlined into index.html', () => {
  const dir = fixtureDist({
    'index.html': [
      '<link rel="stylesheet" href="data:text/css;base64,QGxheWVy" media="print" />',
      '<script type="module" src="/assets/index-inl.js"></script>',
    ].join('\n'),
    'assets/index-inl.js': 'export default 1\n',
  })
  try {
    const result = spawnSync(process.execPath, [script, '--dist', dir, '--budget', '10000'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /inlined into index\.html/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exits 1 when dist/index.html is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-empty-'))
  try {
    const result = spawnSync(process.execPath, [script, '--dist', dir], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing .*index\.html/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CSS budget sums split stylesheets, deduplicates links and fails the CLI', () => {
  const dir = fixtureDist({
    'index.html': '<script type="module" src="/assets/index-a.js"></script>'
      + '<link rel="stylesheet" href="/a.css"><link href="/b.css" rel="stylesheet">'
      + '<link rel="stylesheet" href="/a.css">',
    'assets/index-a.js': 'export default 1', 'a.css': 'a{color:red}', 'b.css': 'b{color:blue}',
  })
  try {
    const result = checkStylesheetBudget(dir)
    assert.equal(result.files, 2)
    assert.ok(result.ok)
    assert.equal(checkStylesheetBudget(dir, result.gzip - 1).ok, false)
    const child = spawnSync(process.execPath, [script, '--dist', dir, '--css-budget', '1'], {encoding:'utf8'})
    assert.equal(child.status, 1)
    assert.match(child.stderr, /CSS over budget/)
  } finally { rmSync(dir, {recursive:true, force:true}) }
})
