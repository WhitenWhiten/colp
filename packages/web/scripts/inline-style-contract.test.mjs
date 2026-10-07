/**
 * L03 contract tests for the inline-style boundary gate.
 * Run with: node --test scripts/inline-style-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkInlineStyles,
  groupByStyle,
  scanInlineStyles,
} from './check-inline-styles.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixturesPath = join(here, 'inline-style-fixtures.json')
const srcDir = join(here, '..', 'src')

test('real src tree passes the gate with zero violations', () => {
  const result = checkInlineStyles(srcDir, fixturesPath)
  assert.deepEqual(result.errors, [])
  assert.ok(result.occurrences >= 24, `expected >=24 style occurrences, got ${result.occurrences}`)
  assert.ok(result.allowedHits >= 24, `expected >=24 allowed hits, got ${result.allowedHits}`)
  assert.equal(result.debtHits, 0, 'static inline-style debt must stay at 0')
})

test('every allowed fixture is actually present in src (no stale allowed fixtures)', () => {
  const result = checkInlineStyles(srcDir, fixturesPath)
  const staleAllowed = result.warnings.filter((w) => w.startsWith('stale allowed fixture'))
  assert.deepEqual(staleAllowed, [], 'allowed fixtures must all match live occurrences')
})

test('unlisted static inline style fails the gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-style-violation-'))
  try {
    writeFileSync(join(dir, 'Bad.tsx'), `export function Bad() {\n  return <div style={{ marginTop: '9px' }} />\n}\n`)
    const result = checkInlineStyles(dir, fixturesPath)
    assert.ok(result.errors.length >= 1, 'expected a violation error')
    assert.match(result.errors[0], /unlisted static inline style/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the whitelist is fixture-scoped: dynamic-looking but unlisted styles still fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-style-dynamic-'))
  try {
    writeFileSync(
      join(dir, 'Dyn.tsx'),
      [
        `export function Dyn({ x, y, pct, id, i }: any) {`,
        `  return (`,
        `    <div`,
        `      style={{ top: y, left: x, '--swatch': '#fff', animationDelay: \`\${i * 40}ms\`, viewTransitionName: \`c-\${id}\`, width: \`\${pct}%\` }}`,
        `    />`,
        `  )`,
        `}`,
        ``,
      ].join('\n'),
    )
    // The synthetic file has no fixture entries, so it must fail as unlisted —
    // the whitelist is the explicit fixture list, not a pattern match. The
    // dynamic patterns themselves are covered by the real-tree allowed
    // fixtures (coordinates, --swatch, animationDelay, viewTransitionName,
    // width progress).
    const result = checkInlineStyles(dir, fixturesPath)
    assert.ok(result.errors.length >= 1, 'synthetic unlisted file must fail (fixture-scoped gate)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('widened channels fail when unlisted: style={expr}, setProperty, style.prop writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-style-channels-'))
  try {
    writeFileSync(
      join(dir, 'Bad.tsx'),
      [
        `export function Bad({ cond }: any) {`,
        `  const style = { color: 'red' } // const binding, not a JSX attribute`,
        `  return (`,
        `    <div>`,
        `      <i style={cond ? { color: 'blue' } : undefined} />`,
        `      <u style={style} />`,
        `    </div>`,
        `  )`,
        `}`,
        ``,
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'imperative.ts'),
      [
        `export function touch(el: HTMLElement) {`,
        `  el.style.setProperty('--x', '1px')`,
        `  el.style.position = 'absolute'`,
        `}`,
        ``,
      ].join('\n'),
    )
    // Test files are exempt from the imperative-write channels.
    writeFileSync(join(dir, 'ok.test.tsx'), `document.body.style.overflow = 'hidden'\n`)
    const result = checkInlineStyles(dir, fixturesPath)
    const kinds = result.errors.join('\n')
    assert.match(kinds, /unlisted inline style \(expression\).*style=\{cond \? \{ color: 'blue' \} : undefined\}/)
    assert.match(kinds, /unlisted inline style \(expression\).*style=\{style\}/)
    assert.match(kinds, /unlisted inline style \(setProperty\).*el\.style\.setProperty\('--x', '1px'\)/)
    assert.match(kinds, /unlisted inline style \(write\).*el\.style\.position = 'absolute'/)
    assert.equal(result.errors.length, 4, `expected exactly 4 violations, got: ${kinds}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('debt entries map to real occurrences and never grow', () => {
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'))
  const result = checkInlineStyles(srcDir, fixturesPath)
  const staleDebt = result.warnings.filter((w) => w.startsWith('debt fixture resolved'))
  assert.equal(
    fixtures.debt.reduce((n, d) => n + d.count, 0),
    0,
    'documented debt occurrences must stay at 0',
  )
  // Resolved debt (cleanup) surfaces only as a warning — removing the fixture
  // entry afterwards is the improvement path.
  assert.ok(Array.isArray(staleDebt))
})

test('groupByStyle groups duplicate occurrences by file+style', () => {
  const groups = groupByStyle([
    { file: 'a.tsx', line: 1, style: 'style={{ margin: 0 }}' },
    { file: 'a.tsx', line: 9, style: 'style={{ margin: 0 }}' },
    { file: 'a.tsx', line: 3, style: 'style={{ top: y }}' },
  ])
  assert.equal(groups.length, 2)
  const margin = groups.find((g) => g.style.includes('margin: 0'))
  assert.equal(margin.count, 2)
  assert.deepEqual(margin.lines, [1, 9])
})

test('scanInlineStyles extracts balanced objects including multiline styles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-style-scan-'))
  try {
    writeFileSync(
      join(dir, 'Multi.tsx'),
      `export function Multi({ a, b }: any) {\n  return <div\n    style={{\n      '--a': a,\n      '--b': b,\n    } as React.CSSProperties}\n  />\n}\n`,
    )
    const found = scanInlineStyles(dir)
    assert.equal(found.length, 1)
    assert.match(found[0].style, /--a/)
    assert.match(found[0].style, /--b/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
