#!/usr/bin/env node
/**
 * Dead-class ratchet (G03): class selectors defined in src/styles/*.css but
 * never referenced from any production TSX/TS source.
 *
 * Usage corpus: src/** production sources only — tightened in R9-29 so that
 * comments and test files no longer count as usage. A class kept alive only
 * by a unit-test/e2e selector or a comment mention is dead weight, not a
 * live hook. (`*.test.*` / `*.spec.*` / `e2e/**` / `src/test/**` are
 * excluded; line and block comments are stripped before matching.)
 * Dynamic template classes (`tile-${resource.type}`) are still matched by
 * prefix: `tile-github` counts as used when the source contains `tile-${`
 * — the audit concedes this is deliberate: generated skins cannot be
 * enumerated statically. Short stems (`is-${status}`) are ignored —
 * otherwise every `.is-*` rule would count as live.
 *
 * Gate: the baseline (scripts/dead-classes-baseline.json) is shrink-only —
 * a NEW dead class fails; classes cleaned from the baseline only warn.
 *
 * Reverse direction — ghost classes: a static `className` token in a
 * production TSX file that no stylesheet selects and nothing else (tests,
 * e2e, other TS such as querySelector) references. Those are noise that
 * looks like styling but is not; the gate has no baseline — any ghost fails.
 * A class kept as a test or JS hook is fine (the reference keeps it alive).
 *
 * Usage:
 *   node scripts/check-dead-classes.mjs                  # verify against baseline
 *   node scripts/check-dead-classes.mjs --write-baseline # regenerate (refuses to grow)
 *   node scripts/check-dead-classes.mjs --json           # machine-readable report
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanCssRules } from './check-style-drift.mjs'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(webRoot, 'src', 'styles')
const baselinePath = join(webRoot, 'scripts', 'dead-classes-baseline.json')

const args = process.argv.slice(2)
const writeBaseline = args.includes('--write-baseline')
const asJson = args.includes('--json')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Every class name appearing in a selector, per styles file. */
export function classesByFile(stylesDirPath = stylesDir) {
  const files = readdirSync(stylesDirPath).filter((f) => f.endsWith('.css'))
  const map = new Map()
  for (const file of files) {
    const text = readFileSync(join(stylesDirPath, file), 'utf8')
    const names = new Set()
    for (const rule of scanCssRules(text)) {
      for (const m of rule.selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) {
        names.add(m[1])
      }
    }
    map.set(file, names)
  }
  return map
}

/** Test/automation files are not production usage evidence (R9-29): a
 *  class kept alive only by a test selector is dead weight, not a hook. */
const TEST_FILE_RE = /(?:^|\/)[^/]*\.(?:test|spec)\.[tj]sx?$/

function isUsageEvidenceFile(root, file) {
  const rel = relative(root, file).split(sep).join('/')
  if (rel.startsWith('e2e/')) return false
  if (rel.startsWith('src/test/')) return false
  return !TEST_FILE_RE.test(rel)
}

/** Blank comments so a name mentioned only in a comment no longer counts as
 *  usage (R9-29). `//`/`/*` are only treated as comment openers at line
 *  start or after whitespace/`>` — never inside `https://…`, `'//foo'`, or
 *  glob strings like `src/**\/*.css` — so string usage evidence survives. */
function stripUsageComments(text) {
  return text
    .replace(/(^|\s)\/\*[\s\S]*?\*\//gm, '$1')
    .replace(/(^|[\s>])<!--[\s\S]*?-->/gm, '$1')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

/** Concatenated production-source corpus (src/** minus tests, comments
 *  stripped), plus the set of dynamic `prefix-${` templates. */
export function usageCorpus(root = webRoot) {
  const dirs = [join(root, 'src'), join(root, 'e2e')].filter((d) => existsSync(d))
  const files = dirs.flatMap((d) => walk(d))
    .filter((f) => /\.(tsx?|jsx?|mjs|cjs|html)$/.test(f))
    .filter((f) => isUsageEvidenceFile(root, f))
  const texts = files.map((f) => stripUsageComments(readFileSync(f, 'utf8')))
  const dynamicPrefixes = new Set()
  for (const text of texts) {
    for (const m of text.matchAll(/[`'"]([^`'"]*?)\$\{/g)) {
      // last whitespace-separated token before the interpolation
      const before = m[1].split(/\s/).pop()
      if (before && /^[_a-zA-Z0-9-]+$/.test(before)) dynamicPrefixes.add(before)
    }
  }
  return { text: texts.join('\n'), dynamicPrefixes }
}

/** Minimum stem length (trailing `-` stripped) before a `${` prefix can
 *  keep generated classes alive. `tile-` (stem `tile`) is accepted;
 *  `is-` (stem `is`) is not — it would keep every `.is-*` rule. */
export const MIN_DYNAMIC_STEM = 3

function prefixKeeps(name, prefix) {
  const stem = prefix.replace(/-+$/, '')
  if (stem.length < MIN_DYNAMIC_STEM) return false
  return prefix.endsWith('-')
    ? name.startsWith(prefix)
    : name.startsWith(`${prefix}-`) || name === prefix
}

/** class is used when it appears as a whole word, or a `prefix-${` template covers it. */
export function isUsed(name, corpus) {
  if (new RegExp(`(?<![_a-zA-Z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![_a-zA-Z0-9-])`).test(corpus.text)) return true
  for (const prefix of corpus.dynamicPrefixes) {
    if (prefixKeeps(name, prefix)) return true
  }
  return false
}

export function findDeadClasses(root = webRoot) {
  const stylesPath = join(root, 'src', 'styles')
  const byFile = classesByFile(stylesPath)
  const corpus = usageCorpus(root)
  // capture.css is the design-system source copied by the extension build;
  // its DOM adapter is production usage, and uses the same test/comment filter.
  const extensionRoot = join(webRoot, '../../Known-Extension')
  const captureCorpus = root === webRoot && existsSync(join(extensionRoot, 'src')) ? usageCorpus(extensionRoot) : null
  const dead = new Map()
  for (const [file, names] of byFile) {
    const deadNames = [...names].filter((n) => !isUsed(n, corpus) && !(file === 'capture.css' && captureCorpus && isUsed(n, captureCorpus))).sort()
    if (deadNames.length) dead.set(file, deadNames)
  }
  return dead
}

const STATIC_CLASSNAME_RE = /className=(?:"([^"]+)"|\{'([^']+)'\}|\{`([^`]+)`\})/g
const CLASS_TOKEN_RE = /^-?[_a-zA-Z][_a-zA-Z0-9-]*[_a-zA-Z0-9]$/

function isProductionTsx(rel) {
  return rel.endsWith('.tsx') && !rel.endsWith('.test.tsx') && !rel.startsWith('src/test/')
}

/** Static class tokens per production TSX file. Template interpolations are
 *  blanked so `desk-${kind}` does not yield a half token. */
export function staticClassTokens(root = webRoot) {
  const srcDir = join(root, 'src')
  if (!existsSync(srcDir)) return new Map()
  const byToken = new Map()
  for (const file of walk(srcDir)) {
    const rel = relative(root, file).split(sep).join('/')
    if (!isProductionTsx(rel)) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(STATIC_CLASSNAME_RE)) {
      const raw = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' ')
      for (const token of raw.split(/\s+/)) {
        if (!CLASS_TOKEN_RE.test(token)) continue
        if (!byToken.has(token)) byToken.set(token, new Set())
        byToken.get(token).add(rel)
      }
    }
  }
  return byToken
}

/** Class tokens rendered from JSX that no stylesheet selects and no other
 *  source (test, e2e, TS hook) references. Returns token → declaring files. */
export function findGhostClasses(root = webRoot) {
  const styled = new Set()
  for (const names of classesByFile(join(root, 'src', 'styles')).values()) {
    for (const name of names) styled.add(name)
  }
  const dirs = [join(root, 'src'), join(root, 'e2e')].filter((d) => existsSync(d))
  const corpus = dirs.flatMap((d) => walk(d))
    .filter((f) => /\.(tsx?|jsx?|mjs|cjs|html)$/.test(f))
    .map((f) => ({ rel: relative(root, f).split(sep).join('/'), text: readFileSync(f, 'utf8') }))
  const ghosts = new Map()
  for (const [token, files] of staticClassTokens(root)) {
    if (styled.has(token)) continue
    const word = new RegExp(`(?<![_a-zA-Z0-9-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![_a-zA-Z0-9-])`)
    const referenced = corpus.some(({ rel, text }) => !files.has(rel) && word.test(text))
    if (!referenced) ghosts.set(token, [...files].sort())
  }
  return ghosts
}

function main() {
  const dead = findDeadClasses()
  const deadObj = Object.fromEntries(dead)
  const ghosts = findGhostClasses()

  if (writeBaseline) {
    const existing = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
    const existingCount = Object.values(existing).flat().length
    const nextCount = Object.values(deadObj).flat().length
    if (existsSync(baselinePath) && nextCount > existingCount) {
      console.error(`[dead-classes] refusing to grow baseline: ${existingCount} -> ${nextCount}`)
      process.exit(1)
    }
    writeFileSync(baselinePath, `${JSON.stringify(deadObj, null, 2)}\n`)
    console.log(`[dead-classes] baseline written: ${nextCount} entr${nextCount === 1 ? 'y' : 'ies'}`)
    return
  }

  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
  const baselineSet = new Set(Object.entries(baseline).flatMap(([file, names]) => names.map((n) => `${file}::${n}`)))
  const deadSet = new Set(Object.entries(deadObj).flatMap(([file, names]) => names.map((n) => `${file}::${n}`)))

  const newDead = [...deadSet].filter((k) => !baselineSet.has(k))
  const cleaned = [...baselineSet].filter((k) => !deadSet.has(k))

  const ghostObj = Object.fromEntries(ghosts)

  if (asJson) {
    console.log(JSON.stringify({ dead: deadObj, newDead, cleaned, ghosts: ghostObj }, null, 2))
    return
  }

  for (const [file, names] of dead) {
    console.log(`[dead-classes] ${file}: ${names.length} unreferenced`)
    for (const n of names) console.log(`  .${n}`)
  }
  console.log(`[dead-classes] total ${deadSet.size}, baseline ${baselineSet.size}`)
  if (cleaned.length) {
    console.log(`[dead-classes] ${cleaned.length} baseline entr${cleaned.length === 1 ? 'y' : 'ies'} cleaned up — shrink the baseline with --write-baseline:`)
    for (const k of cleaned) console.log(`  ${k}`)
  }
  let failed = false
  if (newDead.length) {
    console.error(`[dead-classes] FAIL: ${newDead.length} NEW unreferenced class${newDead.length === 1 ? '' : 'es'} (not in baseline):`)
    for (const k of newDead) console.error(`  ${k}`)
    failed = true
  }
  if (ghosts.size) {
    console.error(`[dead-classes] FAIL: ${ghosts.size} ghost class${ghosts.size === 1 ? '' : 'es'} — rendered from JSX but no stylesheet or hook references them:`)
    for (const [token, files] of ghosts) console.error(`  .${token}  <- ${files.join(', ')}`)
    console.error('[dead-classes] drop the token, style it, or reference it from a test/hook')
    failed = true
  }
  if (failed) process.exit(1)
  console.log('[dead-classes] OK — no new unreferenced classes, no ghost classes')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
