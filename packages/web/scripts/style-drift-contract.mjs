#!/usr/bin/env node
/**
 * G01 + G02 contract tests for the style-drift scanner and ratchet gate.
 *
 * Proves, from fixtures, that:
 *  - known violations classify stably (non-token radius, literal
 *    duration/easing, hardcoded colors, cross-file duplicate selectors,
 *    static TSX inline styles);
 *  - whitelisted fixtures do NOT false-positive (token radius, 50%
 *    circles, token color definitions, dynamic var() fallbacks, source
 *    accents, print CSS, prefers-reduced-motion overrides);
 *  - the duplicate-selector gate is COMPUTED from the scanned files, not
 *    read from the baseline (removing a fixture definition drops the
 *    count);
 *  - the CLI --scan --json path is machine-readable;
 *  - the G02 ratchet gate (--verify) exits 1 for NEW radius / motion /
 *    static inline style / duplicate-selector debt and for per-key count
 *    increases, prints file:line + token/owner suggestions, exits 0 when
 *    the tree matches the baseline or debt shrinks, and --write-baseline
 *    refuses to grow the baseline (baselineGrowth);
 *  - cascade overlaps use tokens.css layer order and main.tsx import
 *    order: same-layer later files win, and a higher layer beats a
 *    more-specific lower-layer selector (the old
 *    `if (loser.layer === winner.layer) continue` skip is gone).
 *
 * Run: node --test scripts/style-drift-contract.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { analyzeCssFile, analyzeDirectory, analyzeTsxFile, baselineGrowth, classifyCustomPropertyColor, collectCrossLayerOverlaps, collectForbiddenPatterns, extractColorTokens, extractRadiusTokens, gateCheck, parseCssImportOrder, parseLayerOrder, selectorCovers } from './check-style-drift.mjs'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const TOKENS = `:root {
  --paper: rgb(244 245 246);
  --danger: rgb(157 53 51);
  --surface-raised: rgb(255 255 255);
  --radius-xs: 0.25rem;
  --radius-sm: var(--radius-xs);
  --radius: 0.5rem;
}`

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'style-drift-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

test('radius: drift classified, token / 50% / mixed-token not misreported', () => {
  const css = [
    '.card { border-radius: 12px; }',
    '.dot { border-radius: 50%; }',
    '.tile { border-radius: var(--radius); }',
    '.corner { border-radius: 0.5rem; }',
    '.edge { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }',
  ].join('\n')
  const res = analyzeCssFile('fixture.css', css, extractColorTokens(TOKENS), extractRadiusTokens(TOKENS))

  assert.deepEqual(
    res.radius.map((r) => ({ value: r.value, kind: r.kind })),
    [
      { value: '12px', kind: 'drift' },
      { value: '0.5rem', kind: 'tokenMatch' },
    ],
  )
  assert.equal(res.radius.some((r) => r.value === '50%'), false, '50% circle must not be flagged')
  assert.equal(res.radius.some((r) => r.value === 'var(--radius)'), false, 'token radius must not be flagged')
  assert.equal(res.radius.some((r) => r.value.includes('var(--radius-sm)')), false, 'mixed token radius must not be flagged')
  assert.equal(res.whitelisted.circle50, 1)
  assert.equal(res.whitelisted.radiusToken, 2) // var(--radius) + mixed token value
})

test('motion: literal duration/easing flagged, token + dynamic fallback + reduced-motion not', () => {
  const css = [
    '.panel { transition: transform 0.25s cubic-bezier(0.23, 1, 0.32, 1); }',
    '.ok { transition: transform var(--duration) var(--ease-out); }',
    '.blink { animation: cursor-blink 1s steps(1) infinite; }',
    '.delay { transition-delay: var(--reveal-delay, 0ms); }',
    '@media (prefers-reduced-motion: reduce) { .calm { transition-duration: 0.01ms !important; } }',
  ].join('\n')
  const res = analyzeCssFile('fixture.css', css, new Map(), new Map())

  assert.deepEqual(
    res.motion.map((m) => ({ kind: m.kind, value: m.value })),
    [
      { kind: 'duration', value: '0.25s' },
      { kind: 'easing', value: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      { kind: 'duration', value: '1s' },
    ],
  )
  assert.equal(res.motion.some((m) => m.value === '0ms'), false, 'dynamic var() fallback must not be flagged')
  assert.equal(res.motion.some((m) => m.value === '0.01ms'), false, 'prefers-reduced-motion override must not be flagged')
})

test('colors: token defs / dynamic fallbacks / source accents whitelisted, semantic + unknown reported', () => {
  const css = [
    ':root { --custom: rgb(1 2 3); }',
    '.ssh { color: var(--ssh-fg, rgb(11 13 17)); }',
    '.err { color: #b42318; }',
    '.danger { color: rgb(157 53 51); }',
    '.tile-zhihu { background: rgb(234 245 255); }',
    '.plain { color: white; }',
    '.plain { color: rgb(999 999 999); }', // note: still a literal — sanity that parser does not drop it
  ].join('\n')
  const res = analyzeCssFile('fixture.css', css, extractColorTokens(TOKENS), extractRadiusTokens(TOKENS))

  assert.deepEqual(
    res.colors.map((c) => ({ value: c.value, category: c.category, token: c.token })),
    [
      { value: '#b42318', category: 'unknown', token: null },
      { value: 'rgb(157 53 51)', category: 'semanticMatch', token: '--danger' },
      { value: 'white', category: 'semanticMatch', token: '--surface-raised' },
      { value: 'rgb(999 999 999)', category: 'unknown', token: null },
    ],
  )
  assert.equal(res.whitelisted.tokenDefinition, 1)
  assert.equal(res.whitelisted.dynamicFallback, 1)
  assert.equal(res.whitelisted.sourceAccent, 1)
  assert.equal(res.colors.some((c) => c.value === 'rgb(11 13 17)'), false, 'dynamic var() fallback must not be flagged')
  assert.equal(res.colors.some((c) => c.value === 'rgb(234 245 255)'), false, 'source accent must not be flagged')
  assert.equal(res.maxAdhoc.hexValues, 1, 'non-print declaration hex must increment hexValues')
  assert.equal(res.maxAdhoc.customPropertyRgb, 1, 'non-tokens.css --custom: rgb() must increment customPropertyRgb')
  assert.equal(res.customPropertyColors.some((c) => c.category === 'customProperty' && c.value === 'rgb(1 2 3)'), true)
})

test('print CSS is whitelisted for colors', () => {
  const css = [
    '@layer print {',
    '@media print {',
    '  .page { color: #000; border-radius: 9px; }',
    '}',
    '}',
  ].join('\n')
  const res = analyzeCssFile('print.css', css, new Map(), new Map())
  assert.equal(res.colors.length, 0, 'print colors must not be flagged')
  assert.equal(res.radius.length, 0, 'print radius must not be flagged')
  assert.equal(res.maxAdhoc.hexValues, 0, 'print hex must not increment hexValues')
})

test('maxAdhoc.hexValues: declaration hex counted; print, token defs, ID selectors not', () => {
  const counted = analyzeCssFile('fixture.css', '.err { color: #b42318; }\n.fb { color: var(--ink, #fff); }\n', new Map(), new Map())
  assert.equal(counted.maxAdhoc.hexValues, 2, 'declaration hex and var() fallback hex must increment')

  const printRes = analyzeCssFile(
    'print.css',
    '@media print {\n  .page { color: #000; background: #fff; }\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(printRes.maxAdhoc.hexValues, 0, 'hex inside @media print must not increment')

  const tokenRes = analyzeCssFile('tokens.css', ':root {\n  --token: #fff;\n}\n', new Map(), new Map())
  assert.equal(tokenRes.maxAdhoc.hexValues, 0, '--token: #fff definition line must not increment')

  const idRes = analyzeCssFile(
    'page-layouts.css',
    '.settings-form #set-name,\n.settings-form #feed {\n  color: var(--ink);\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(idRes.maxAdhoc.hexValues, 0, 'ID selectors #set-name / #feed must not increment')
})

test('duplicate-selector gate is computed from files, not read from baseline', () => {
  const dir = fixtureDir({
    'a.css': '.dup { color: rgb(1 2 3); }',
    'b.css': '.dup { color: rgb(4 5 6); }',
  })
  try {
    const before = analyzeDirectory(dir)
    assert.equal(before.duplicateSelectors.length, 1)
    assert.equal(before.duplicateSelectors[0], '.dup :: a.css, b.css')

    // Remove the duplicate definition from one file — the count must drop.
    writeFileSync(join(dir, 'b.css'), '.other { color: rgb(7 8 9); }')
    const after = analyzeDirectory(dir)
    assert.equal(after.duplicateSelectors.length, 0, 'removing a fixture definition must drop the duplicate count')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TSX: static inline styles reported, dynamic / custom-property styles skipped', () => {
  const tsx = [
    "const a = <div style={{ display: 'block' }} />",
    'const b = <div style={{ top: menu.y }} />',
    "const c = <div style={{ ['--lang-color' as string]: v }} />",
    "const d = <div style={{ width: '100%', height: '100%' }} />",
  ].join('\n')
  const res = analyzeTsxFile('fixture.tsx', tsx)
  assert.deepEqual(
    res.map((s) => ({ line: s.line, style: s.style })),
    [
      { line: 1, style: "display: 'block'" },
      { line: 4, style: "width: '100%', height: '100%'" },
    ],
  )
})

test('CLI --scan --json is machine-readable and exits 0', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'fixture.css': '.card { border-radius: 12px; }\n.dot { border-radius: 50%; }',
  })
  try {
    const run = spawnSync(process.execPath, ['scripts/check-style-drift.mjs', '--scan', dir, '--json'], {
      cwd: webRoot,
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)
    assert.ok(Array.isArray(parsed.report.radius))
    assert.ok(Array.isArray(parsed.duplicateSelectors))
    assert.ok(parsed.report.radius.some((r) => r.value === '12px'))
    assert.equal(parsed.report.radius.some((r) => r.value === '50%'), false)
    assert.ok(parsed.report.forbidden)
    assert.ok(Array.isArray(parsed.report.forbidden.items))
    assert.equal(typeof parsed.report.forbidden.counts, 'object')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── G02 ratchet gate contract tests ────────────────────────────────── */
const EMPTY_REPORT = { radius: [], motion: [], colors: [], staticInlineStyles: [] }

function writeBaseline(dir, overrides = {}) {
  const baseline = {
    duplicateSelectors: [],
    maxAdhoc: { rgbValues: 0, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
    residualReport: { ...EMPTY_REPORT, ...overrides.residualReport },
  }
  const p = join(dir, 'baseline.json')
  writeFileSync(p, JSON.stringify(baseline, null, 2))
  return p
}

function runVerify(dir, baselineFile) {
  return spawnSync(process.execPath, ['scripts/check-style-drift.mjs', '--verify', dir, '--baseline', baselineFile], {
    cwd: webRoot,
    encoding: 'utf8',
  })
}

test('G02: gate exits 0 when the tree matches the baseline exactly', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.card { border-radius: 0.3rem; }\n.dot { border-radius: 50%; }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { radius: [{ file: 'base.css', line: 1, selector: '.card', kind: 'drift', value: '0.3rem', token: null }] },
    })
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /OK —/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 with file:line + token suggestion for a NEW non-token radius', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.card { border-radius: 0.3rem; }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { radius: [{ file: 'base.css', line: 1, selector: '.card', kind: 'drift', value: '0.3rem', token: null }] },
    })
    writeFileSync(join(dir, 'base.css'), '.card { border-radius: 0.3rem; }\n.extra { border-radius: 0.33rem; }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /new radius: base\.css:2/)
    assert.match(run.stderr, /\.33rem/)
    assert.match(run.stderr, /--radius-sm/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW literal motion duration with token suggestion', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS + '\n  --duration-fast: 120ms;\n  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);\n',
    'base.css': '.panel { transition: transform 200ms ease; }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { motion: [{ file: 'base.css', line: 1, selector: '.panel', kind: 'duration', value: '200ms' }] },
    })
    writeFileSync(join(dir, 'base.css'), '.panel { transition: transform 200ms ease; }\n.calm { transition-duration: 350ms; }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /new motion: base\.css:2/)
    assert.match(run.stderr, /350ms/)
    assert.match(run.stderr, /--duration-fast/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW static TSX inline style with owner suggestion', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.ok { color: rgb(1 2 3); }',
    'a.tsx': "const a = <div style={{ marginTop: '0.5rem' }} />",
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { staticInlineStyles: [{ file: 'a.tsx', line: 1, style: "marginTop: '0.5rem'" }] },
    })
    writeFileSync(join(dir, 'a.tsx'), "const a = <div style={{ marginTop: '0.5rem' }} />\nconst b = <div style={{ gap: '1.25rem' }} />\n")
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /new staticInlineStyles: a\.tsx:2/)
    assert.match(run.stderr, /inline-style-fixtures\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW cross-file duplicate selector via --verify', () => {
  const dir = fixtureDir({
    'a.css': '.dup { color: rgb(1 2 3); }',
    'b.css': '.other { color: rgb(4 5 6); }',
  })
  try {
    const baselineFile = writeBaseline(dir)
    writeFileSync(join(dir, 'b.css'), '.other { color: rgb(4 5 6); }\n.dup { color: rgb(7 8 9); }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /duplicate selector without declared owner/)
    assert.match(run.stderr, /\.dup :: a\.css, b\.css/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 when an existing debt key grows (count ratchet)', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.a { border-radius: 0.3rem; }\n.a { border-radius: 0.3rem; }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { radius: [{ file: 'base.css', line: 1, selector: '.a', kind: 'drift', value: '0.3rem', token: null }] },
    })
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /count increased/)
    assert.match(run.stderr, /1 -> 2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 0 and reports resolved debt when an item is removed', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.card { border-radius: 0.3rem; }\n.dot { border-radius: 50%; }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: {
        radius: [
          { file: 'base.css', line: 1, selector: '.card', kind: 'drift', value: '0.3rem', token: null },
          { file: 'base.css', line: 2, selector: '.gone', kind: 'drift', value: '0.37rem', token: null },
        ],
      },
    })
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /radius resolved/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: baselineGrowth refuses a larger baseline (count increase)', () => {
  const current = {
    duplicateSelectors: [],
    maxAdhoc: { rgbValues: 3, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
    report: {
      radius: [{ file: 'a.css', line: 1, selector: '.a', kind: 'drift', value: '0.3rem', token: null }],
      motion: [],
      colors: [],
      staticInlineStyles: [],
    },
  }
  const baseline = {
    duplicateSelectors: [],
    maxAdhoc: { rgbValues: 2, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
    residualReport: {
      radius: [{ file: 'a.css', line: 1, selector: '.a', kind: 'drift', value: '0.3rem', token: null }],
      motion: [],
      colors: [],
      staticInlineStyles: [],
    },
  }
  const grown = baselineGrowth(current, baseline)
  assert.deepEqual(grown, ['maxAdhoc.rgbValues: 2 -> 3'])
})

test('G02: gateCheck treats a new tokenMatch radius as new debt (hint suggests the token)', () => {
  const current = {
    duplicateSelectors: [],
    maxAdhoc: { rgbValues: 0, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
    report: {
      radius: [{ file: 'b.css', line: 4, selector: '.corner', kind: 'tokenMatch', value: '0.5rem', token: '--radius' }],
      motion: [],
      colors: [],
      staticInlineStyles: [],
    },
  }
  const baseline = {
    duplicateSelectors: [],
    maxAdhoc: { rgbValues: 0, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
    residualReport: { ...EMPTY_REPORT },
  }
  const gate = gateCheck(current, baseline, {
    radiusTokens: [{ token: '--radius', value: '0.5rem' }],
    motionTokens: [],
  })
  assert.equal(gate.failed, true)
  assert.match(gate.failures[0], /b\.css:4/)
  assert.match(gate.failures[0], /use var\(--radius\)/)
})

test('cross-layer overlap: same selector + overlapping props across layers is keyed', () => {
  const dir = fixtureDir({
    'low.css': '@layer pages {\n.card { color: red; box-shadow: none; margin: 0; }\n}',
    'high.css': '@layer components {\n.card { box-shadow: 0 1px 0 black; padding: 1rem; }\n}',
  })
  try {
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.deepEqual(keys, ['.card :: low.css < high.css :: box-shadow'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('same-layer overlap: later import wins and the earlier file is reported', () => {
  const dir = fixtureDir({
    'tokens.css': '@layer tokens, base, pages, patterns, components, utilities, print;\n@layer tokens {\n:root { --x: 1; }\n}\n',
    'main.tsx': "import './z-early.css'\nimport './a-late.css'\n",
    'z-early.css': '@layer components {\n.card-title { font-size: 1rem; color: red; }\n}',
    'a-late.css': '@layer components {\n.card-title { font-size: 2rem; color: blue; }\n}',
  })
  try {
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.ok(keys.includes('.card-title :: z-early.css < a-late.css :: font-size'), keys.join('\n'))
    assert.ok(keys.includes('.card-title :: z-early.css < a-late.css :: color'), keys.join('\n'))
    assert.equal(keys.some((k) => k.includes('a-late.css < z-early.css')), false, 'alphabetical order must not referee; import order does')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cross-layer overlap: higher layer beats a more-specific lower-layer selector', () => {
  const dir = fixtureDir({
    'tokens.css': '@layer tokens, base, pages, patterns, components, utilities, print;\n@layer tokens {\n:root { --x: 1; }\n}\n',
    'main.tsx': "import './pages.css'\nimport './cards.css'\n",
    'pages.css': '@layer pages {\n.dashboard-stack .tile { position: relative; width: 100%; transform: none; }\n}',
    'cards.css': '@layer components {\n.tile { position: absolute; width: var(--w); transform: translate3d(0, 0, 0); }\n}',
  })
  try {
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.ok(keys.includes('.dashboard-stack .tile :: pages.css < cards.css :: position'), keys.join('\n'))
    assert.ok(keys.includes('.dashboard-stack .tile :: pages.css < cards.css :: width'), keys.join('\n'))
    assert.ok(keys.includes('.dashboard-stack .tile :: pages.css < cards.css :: transform'), keys.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectCrossLayerOverlaps no longer skips same-layer pairs', () => {
  const src = readFileSync(join(webRoot, 'scripts', 'check-style-drift.mjs'), 'utf8')
  assert.equal(src.includes('if (loser.layer === winner.layer) continue'), false, 'old same-layer skip must be gone')
  const dir = fixtureDir({
    'a.css': '@layer components {\n.card { color: red; }\n}',
    'b.css': '@layer components {\n.card { color: blue; }\n}',
  })
  try {
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.deepEqual(keys, ['.card :: a.css < b.css :: color'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('layer order is parsed from the tokens.css @layer statement', () => {
  const dir = fixtureDir({
    'tokens.css': '@layer components, pages;\n@layer tokens {\n:root { --x: 1; }\n}\n',
    'main.tsx': "import './cards.css'\nimport './pages.css'\n",
    'cards.css': '@layer components {\n.tile { position: absolute; }\n}',
    'pages.css': '@layer pages {\n.dashboard-stack .tile { position: relative; }\n}',
  })
  try {
    assert.deepEqual(parseLayerOrder(readFileSync(join(dir, 'tokens.css'), 'utf8')), { components: 0, pages: 1 })
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.equal(keys.some((k) => k.includes('.dashboard-stack .tile :: pages.css <')), false, 'pages is the winning layer in this fixture')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseCssImportOrder reads main.tsx CSS imports and skips fontsource', () => {
  const order = parseCssImportOrder([
    "import '@fontsource-variable/instrument-sans/wdth.css'",
    "import './styles/cards.css'",
    "import './styles/cards-ui.css'",
  ].join('\n'))
  assert.deepEqual(order, ['cards.css', 'cards-ui.css'])
})

test('selectorCovers: general class covers a descendant subject; reverse does not', () => {
  assert.equal(selectorCovers('.tile', '.dashboard-stack .tile'), true)
  assert.equal(selectorCovers('.dashboard-stack .tile', '.tile'), false)
  assert.equal(selectorCovers('.card-title', '.card-title'), true)
  assert.equal(selectorCovers('*', '.tile'), false)
})

test('cascade overlap: print and reduced-motion are not counted', () => {
  const dir = fixtureDir({
    'low.css': '@layer pages {\n.card { color: red; }\n}',
    'print.css': '@layer print {\n@media print {\n.card { color: black; }\n}\n}',
    'motion.css': '@layer patterns {\n@media (prefers-reduced-motion: reduce) {\n.card { color: green; }\n}\n}',
  })
  try {
    const { keys } = collectCrossLayerOverlaps(dir)
    assert.equal(keys.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('custom-property colors: tokens.css skipped; others counted and classified', () => {
  const tokenRes = analyzeCssFile(
    'tokens.css',
    ':root {\n  --paper: rgb(1 2 3);\n  --hex: #fff;\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(tokenRes.maxAdhoc.customPropertyRgb, 0, 'tokens.css custom-property rgb must not increment')
  assert.equal(tokenRes.maxAdhoc.customPropertyHex, 0, 'tokens.css custom-property hex must not increment')
  assert.equal(tokenRes.customPropertyColors.length, 0)

  const local = analyzeCssFile(
    'cards.css',
    '.tile-ssh {\n  --ssh-bg: rgb(11 13 17); /* local-palette */\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(local.maxAdhoc.customPropertyRgb, 0, 'local-palette allowlist must not increment the ratchet')
  assert.equal(local.whitelisted.localPalette, 1)

  const ssh = analyzeCssFile('cards.css', '.tile-ssh {\n  --ssh-bg: rgb(11 13 17);\n}\n', new Map(), new Map())
  assert.equal(ssh.maxAdhoc.customPropertyRgb, 1)
  assert.equal(ssh.customPropertyColors[0]?.category, 'customProperty')

  const theme = analyzeCssFile('desk-themes.css', '.tile-theme-ink {\n  --paper: rgb(8 9 12);\n}\n', new Map(), new Map())
  assert.equal(theme.maxAdhoc.customPropertyRgb, 1)
  assert.equal(theme.customPropertyColors[0]?.category, 'themeReassignment')
  assert.equal(classifyCustomPropertyColor('desk-themes.css', { contrast: false }, '--paper: rgb(8 9 12);'), 'themeReassignment')

  const contrast = analyzeCssFile(
    'global.css',
    '@media (prefers-contrast: more) {\n  :root {\n    --line: rgb(6 7 10 / 0.2);\n  }\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(contrast.maxAdhoc.customPropertyRgb, 1)
  assert.equal(contrast.customPropertyColors[0]?.category, 'contrastOverride')

  const printHex = analyzeCssFile(
    'print.css',
    '@media print {\n  :root { --paper: #fff; }\n}\n',
    new Map(),
    new Map(),
  )
  assert.equal(printHex.maxAdhoc.customPropertyHex, 0, 'print custom-property hex must not increment')

  const liveHex = analyzeCssFile('other.css', ':root {\n  --mark: #b42318;\n}\n', new Map(), new Map())
  assert.equal(liveHex.maxAdhoc.customPropertyHex, 1)
})

test('G02: gate exits 1 when maxAdhoc.customPropertyRgb increases versus a zero baseline', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.ok { color: rgb(1 2 3); }\n',
  })
  try {
    const baselineFile = join(dir, 'baseline.json')
    writeFileSync(baselineFile, JSON.stringify({
      duplicateSelectors: [],
      maxAdhoc: { rgbValues: 1, literalMs: 0, literalFontWeight: 0, literalFontSize: 0, spacing: 0, hexValues: 0, customPropertyRgb: 0, customPropertyHex: 0 },
      residualReport: { ...EMPTY_REPORT },
    }))
    writeFileSync(join(dir, 'base.css'), '.ok { color: rgb(1 2 3); }\n.tile-ssh { --ssh-bg: rgb(11 13 17); }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /maxAdhoc\.customPropertyRgb increased: 0 -> 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 when maxAdhoc.hexValues increases versus a zero baseline', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.ok { color: rgb(1 2 3); }',
  })
  try {
    const baselineFile = join(dir, 'baseline.json')
    writeFileSync(baselineFile, JSON.stringify({
      duplicateSelectors: [],
      maxAdhoc: { rgbValues: 1, literalMs: 0, literalFontWeight: 0, literalFontSize: 0, spacing: 0, hexValues: 0 },
      residualReport: { ...EMPTY_REPORT },
    }))
    writeFileSync(join(dir, 'base.css'), '.ok { color: rgb(1 2 3); }\n.err { color: #b42318; }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /maxAdhoc\.hexValues increased: 0 -> 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW same-layer overlap (later import wins)', () => {
  const dir = fixtureDir({
    'tokens.css': '@layer tokens, components;\n@layer tokens {\n:root { --x: 1; }\n}\n',
    'main.tsx': "import './early.css'\nimport './late.css'\n",
    'early.css': '@layer components {\n.card-title { font-size: 1rem; }\n}',
    'late.css': '@layer components {\n.other { color: red; }\n}',
  })
  try {
    const baselineFile = join(dir, 'baseline.json')
    writeFileSync(baselineFile, JSON.stringify({
      duplicateSelectors: [],
      crossLayerOverlaps: [],
      maxAdhoc: { rgbValues: 0, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
      residualReport: { ...EMPTY_REPORT },
    }))
    writeFileSync(join(dir, 'late.css'), '@layer components {\n.card-title { font-size: 2rem; }\n}\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /cross-layer overlap/)
    assert.match(run.stderr, /\.card-title :: early\.css < late\.css :: font-size/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW cross-layer overlapping declaration', () => {
  const dir = fixtureDir({
    'low.css': '@layer pages {\n.card { box-shadow: none; }\n}',
    'high.css': '@layer components {\n.other { color: red; }\n}',
  })
  try {
    const baselineFile = join(dir, 'baseline.json')
    writeFileSync(baselineFile, JSON.stringify({
      duplicateSelectors: [],
      crossLayerOverlaps: [],
      maxAdhoc: { rgbValues: 0, literalMs: 0, literalFontWeight: 0, literalFontSize: 0 },
      residualReport: { ...EMPTY_REPORT },
    }))
    writeFileSync(join(dir, 'high.css'), '@layer components {\n.card { box-shadow: 0 1px 0 black; }\n}\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /cross-layer overlap/)
    assert.match(run.stderr, /\.card :: low\.css < high\.css :: box-shadow/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const FORBIDDEN_HITS = `
.caps { text-transform: uppercase; letter-spacing: 0.08em; }
.em { font-style: italic; }
.ink { border-top: 2px solid var(--ink); }
.lift:hover { transform: translateY(-2px); }
.spin { animation: wiggle 1s linear; }
.tex { background-image: var(--dither); }
@keyframes wiggle { from { opacity: 0; } to { opacity: 1; } }
`

const FORBIDDEN_EXEMPT = `
.eyebrow { text-transform: uppercase; letter-spacing: 0.08em; }
.page-head span { text-transform: uppercase; letter-spacing: 0.08em; }
.btn-primary:hover { transform: scale(1.02); }
.result-card:hover { transform: translateY(-1px); }
.load { animation: loading-pulse 1s; }
@keyframes loading-pulse { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .calm { font-style: italic; animation: wiggle 1s; transform: scale(1.1); }
}
`

test('forbidden: six kinds hit, six exemption classes stay quiet', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'hits.css': FORBIDDEN_HITS,
    'base.css': FORBIDDEN_EXEMPT,
    'landing.css': '.ink { border-bottom: 3px solid var(--ink); }\n.tex { background-image: var(--grain); }\n',
    'print.css': '.em { font-style: italic; }\n',
  })
  try {
    const forbidden = collectForbiddenPatterns(dir)
    const kinds = new Set(forbidden.items.map((item) => item.split(' :: ')[0]))
    assert.deepEqual([...kinds].sort(), ['caps', 'hoverTransform', 'inkRule', 'italic', 'keyframes', 'texture'])
    assert.equal(forbidden.items.some((i) => i.includes(' :: .caps')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .em')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .ink')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .lift:hover')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .spin')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .tex')), true)
    assert.equal(forbidden.items.some((i) => i.includes('@keyframes wiggle')), true)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .eyebrow')), false)
    assert.equal(forbidden.items.some((i) => i.includes('.page-head')), false)
    assert.equal(forbidden.items.some((i) => i.includes('.btn-primary')), false)
    assert.equal(forbidden.items.some((i) => i.includes('.result-card')), false)
    assert.equal(forbidden.items.some((i) => i.includes('loading-pulse')), false)
    assert.equal(forbidden.items.some((i) => i.includes(' :: .calm')), false)
    assert.equal(forbidden.items.some((i) => i.includes('landing.css')), false)
    assert.equal(forbidden.items.some((i) => i.includes('print.css')), false)
    assert.equal(forbidden.items.some((i) => i.includes('tokens.css')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G02: gate exits 1 for a NEW caps forbidden item', () => {
  const dir = fixtureDir({
    'tokens.css': TOKENS,
    'base.css': '.ok { color: rgb(1 2 3); }',
  })
  try {
    const baselineFile = writeBaseline(dir, {
      residualReport: { forbidden: { items: [], counts: { caps: 0, italic: 0, inkRule: 0, hoverTransform: 0, keyframes: 0, texture: 0 } } },
    })
    writeFileSync(join(dir, 'base.css'), '.ok { color: rgb(1 2 3); }\n.x { text-transform: uppercase; letter-spacing: 0.1em; }\n')
    const run = runVerify(dir, baselineFile)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /base\.css :: \.x :: caps/)
    assert.match(run.stderr, /section-label/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

