/**
 * L03 inline-style boundary gate (report + hard fail).
 *
 * Scans src/**\*.{ts,tsx} for every inline-style channel and classifies
 * occurrences against scripts/inline-style-fixtures.json:
 *
 *   - allowed: dynamic styles on the documented whitelist (coordinates,
 *     percentage progress, CSS custom properties, view transition names,
 *     controlled animation delay, data-driven accents/swatches).
 *   - debt:    documented static styles awaiting cleanup (must not grow;
 *     entries disappear when the code is cleaned up).
 *
 * Detection channels (R9-07 — the gate must SEE every channel so that an
 * unregistered static literal fails no matter how it is written):
 *
 *   A. JSX `style={ … }` attributes — any expression form: `style={{…}}`
 *      object literals (single- or multi-line, optional `as CSSProperties`
 *      cast), `style={ident}`, `style={call()}`, `style={cond ? {…} : …}`.
 *      The `style` token must not be a member access (`.style`), a dashed
 *      suffix (`data-style`), or a JS binding/statement (`const style =`,
 *      destructuring `{ style =`, call args `f(style =`).
 *   B. `receiver.style.setProperty('…', …)` custom-property writes.
 *   C. `receiver.style.prop = …` direct style writes.
 *
 * Channels B/C also run inside .ts files (imperative helpers live there)
 * but skip test/helper files — tests mutate DOM style in setup/assertions,
 * which is not shipped UI. `style.removeProperty` and style reads are not
 * writes and stay unreported. Scanning is deliberately quote-unaware (same
 * as the original line scanner): `style=` inside string literals is a
 * known, accepted blind spot.
 *
 * Judgement is unchanged: every detected occurrence must be covered by a
 * fixture entry (file + normalized text + count cap). Unlisted occurrences
 * fail; stale fixtures only warn.
 *
 * Exit code:
 *   0 — every occurrence is covered by the fixtures and no fixture is
 *       exceeded (stale fixtures only warn).
 *   1 — an unlisted style occurrence exists, or an allowed/debt pair count
 *       is exceeded.
 *
 * Usage: node scripts/check-inline-styles.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const rootDir = join(here, '..', 'src')
const fixturesPath = join(here, 'inline-style-fixtures.json')

/** Test/helper files are exempt from the imperative-write channels (B/C):
 *  they mutate DOM style in setup/assertions, not in shipped UI. The JSX
 *  `style={…}` attribute channel still covers them, as before. */
const TEST_FILE_RE = /\.(?:test|test-helper|spec)\./

/** Channel A — `style` followed by `=` and a `{` JSX expression container.
 *  Lookbehind rejects `.style` member access, `data-style`/`x:style`
 *  suffixes and `foo$style`-style identifiers. `\s` spans newlines so
 *  `style =\n  {` is covered too. */
const STYLE_ATTR_RE = /(?<![\w$.:-])style\s*=\s*\{/g

/** Channel B — `receiver.style.setProperty(…)`; receiver is a dotted
 *  identifier chain (`el`, `document.body`, `board`, …). */
const SET_PROPERTY_RE = /[A-Za-z_$][\w$.[\]]*\.style\.setProperty\s*\(/g

/** Channel C — `receiver.style.prop = …` (single `=` only; `==`, `===`,
 *  `=>` are rejected by the lookahead). */
const STYLE_WRITE_RE = /[A-Za-z_$][\w$.[\]]*\.style\.[A-Za-z_$][\w$]*\s*=(?![=>])/g

/** Keywords/punctuation that make `style =` a JS binding or statement
 *  rather than a JSX attribute (`const style = {`, `{ style = {} }`,
 *  `f(style = {}`, `cond ? style = {} : …`, …). */
const NON_ATTR_WORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'typeof', 'instanceof', 'new',
  'in', 'of', 'case', 'throw', 'extends', 'class', 'default', 'delete',
  'void', 'yield', 'await', 'import', 'export', 'else', 'do',
])
const NON_ATTR_CHARS = '({[=,:;?!&|+-*/%^~<>'

/** True when a `style=` match sits in JSX attribute position. Only the
 *  text on the same line before the match is inspected — an attribute on
 *  its own continuation line (blank prefix) is accepted. */
function isJsxAttrPosition(source, idx) {
  const lineStart = source.lastIndexOf('\n', idx) + 1
  const prefix = source.slice(lineStart, idx).replace(/\s+$/, '')
  if (prefix === '') return true
  const last = prefix[prefix.length - 1]
  if (NON_ATTR_CHARS.includes(last)) return false
  const word = prefix.match(/[\w$]+$/)?.[0] ?? ''
  return !NON_ATTR_WORDS.has(word)
}

/** 1-based line number of `idx` in `text`. */
function lineAt(text, idx) {
  let line = 1
  for (let i = 0; i < idx; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** Balance-match the bracket opened at `openIdx`; returns the index just
 *  past the matching close, or -1 when unbalanced. Quote-unaware, same as
 *  the original line scanner. */
function matchOpen(text, openIdx, open, close) {
  let depth = 0
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** End of a `= <rhs>` statement starting at `start`: the first `;` or
 *  newline at bracket-depth 0, or a `}`/`)`/`]` closing an enclosing
 *  construct. Quoted strings and template literals are skipped so a `;`
 *  inside them does not cut the statement short. */
function scanStatementEnd(text, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/' && depth === 0) return i
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return i
      depth -= 1
    } else if ((ch === ';' || ch === '\n') && depth === 0) return i
  }
  return text.length
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

function scanSource(file, source, isTest, found) {
  // Channel A — JSX style attributes (all expression forms).
  for (const m of source.matchAll(STYLE_ATTR_RE)) {
    if (!isJsxAttrPosition(source, m.index)) continue
    const openIdx = m.index + m[0].length - 1
    const end = matchOpen(source, openIdx, '{', '}')
    if (end === -1) continue
    found.push({
      file,
      line: lineAt(source, m.index),
      style: normalize(`style=${source.slice(openIdx, end)}`),
      kind: source[openIdx + 1] === '{' ? 'literal' : 'expression',
    })
  }
  if (isTest) return

  // Channel B — `.style.setProperty('…', …)` writes.
  for (const m of source.matchAll(SET_PROPERTY_RE)) {
    const end = matchOpen(source, m.index + m[0].length - 1, '(', ')')
    if (end === -1) continue
    found.push({
      file,
      line: lineAt(source, m.index),
      style: normalize(source.slice(m.index, end)),
      kind: 'setProperty',
    })
  }

  // Channel C — `.style.prop = …` writes.
  for (const m of source.matchAll(STYLE_WRITE_RE)) {
    const end = scanStatementEnd(source, m.index + m[0].length)
    found.push({
      file,
      line: lineAt(source, m.index),
      style: normalize(source.slice(m.index, end)),
      kind: 'write',
    })
  }
}

/** Extract every inline-style occurrence (normalized) per file. */
export function scanInlineStyles(srcDir = rootDir) {
  const found = []
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(p)
      } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
        const source = readFileSync(p, 'utf8')
        scanSource(relative(srcDir, p).replace(/\\/g, '/'), source, TEST_FILE_RE.test(entry), found)
      }
    }
  }
  walk(srcDir)
  return found
}

/** Group occurrences by (file, normalized style text). */
export function groupByStyle(occurrences) {
  const groups = new Map()
  for (const occ of occurrences) {
    const key = `${occ.file} ${occ.style}`
    const g = groups.get(key) ?? { file: occ.file, style: occ.style, kind: occ.kind, count: 0, lines: [] }
    g.count++
    g.lines.push(occ.line)
    groups.set(key, g)
  }
  return [...groups.values()]
}

export function checkInlineStyles(srcDir = rootDir, fixturesPathOverride = fixturesPath) {
  const fixtures = JSON.parse(readFileSync(fixturesPathOverride, 'utf8'))
  const groups = groupByStyle(scanInlineStyles(srcDir))

  const allowed = new Map()
  const debt = new Map()
  for (const f of fixtures.allowed) allowed.set(`${f.file} ${f.style}`, f)
  for (const f of fixtures.debt) debt.set(`${f.file} ${f.style}`, f)

  const errors = []
  const warnings = []
  const matched = new Set()
  const byKind = { literal: 0, expression: 0, setProperty: 0, write: 0 }
  let allowedHits = 0
  let debtHits = 0

  for (const g of groups) {
    const key = `${g.file} ${g.style}`
    byKind[g.kind] = (byKind[g.kind] ?? 0) + g.count
    const a = allowed.get(key)
    const d = debt.get(key)
    if (a) {
      allowedHits += g.count
      matched.add(`allowed ${key}`)
      if (g.count > a.count) {
        errors.push(`exceeded allowed fixture ${g.file}:${g.lines.join(',')} (${g.count} > ${a.count}) ${g.style}`)
      }
    } else if (d) {
      debtHits += g.count
      matched.add(`debt ${key}`)
      if (g.count > d.count) {
        errors.push(`exceeded debt fixture ${g.file}:${g.lines.join(',')} (${g.count} > ${d.count}) ${g.style}`)
      }
    } else {
      const what = g.kind === 'literal' ? 'static inline style' : `inline style (${g.kind})`
      errors.push(`unlisted ${what} ${g.file}:${g.lines.join(',')} — move to CSS or fixture it: ${g.style}`)
    }
  }

  // Stale fixtures: a fixture that no longer matches anything signals cleanup —
  // warn (removal is an improvement; the debt must not grow instead).
  for (const f of fixtures.allowed) {
    if (!matched.has(`allowed ${f.file} ${f.style}`)) {
      warnings.push(`stale allowed fixture (no longer present): ${f.file} ${f.style}`)
    }
  }
  for (const f of fixtures.debt) {
    if (!matched.has(`debt ${f.file} ${f.style}`)) {
      warnings.push(`debt fixture resolved — remove from fixture list: ${f.file} ${f.style}`)
    }
  }

  return { errors, warnings, occurrences: groups.length, allowedHits, debtHits, byKind }
}

// CLI
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const json = process.argv.includes('--json')
  const result = checkInlineStyles()
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const w of result.warnings) console.log(`[inline-style] warning: ${w}`)
    for (const e of result.errors) console.log(`[inline-style] FAIL: ${e}`)
    console.log(
      `[inline-style] ${result.occurrences} occurrence(s) — ${result.allowedHits} allowed (dynamic), ${result.debtHits} documented debt, ${result.errors.length} violation(s)`,
    )
    console.log(
      `[inline-style] channels: ${result.byKind.literal} literal attrs, ${result.byKind.expression} expression attrs, ${result.byKind.setProperty} setProperty writes, ${result.byKind.write} style.prop writes`,
    )
  }
  process.exit(result.errors.length > 0 ? 1 : 0)
}
