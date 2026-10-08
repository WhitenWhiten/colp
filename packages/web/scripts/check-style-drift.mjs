#!/usr/bin/env node
/**
 * Style drift ratchet gate + multidimensional residual report (G01 + G02).
 *
 * Gate (blocking, G01 semantics kept):
 *  1. Cross-file duplicate selectors — the same normalized selector defined
 *     in 2+ stylesheets is a cascade hazard (winner decided by import order).
 *     Baseline grandfathered and shrink-only (102 after the pages.css
 *     split; do not mass-merge .tile). Any NEW duplicate without a
 *     declared owner fails the build.
 *  2. Cascade overlaps — a rule is reported when another file's rule
 *     matches every element it matches, shares at least one property, the
 *     winner's media covers the loser's, and the winner actually beats it
 *     in the cascade: higher `@layer` (from the tokens.css order statement)
 *     always wins, then specificity, then CSS import order from `src/main.tsx`
 *     (later import wins). This catches same-layer dead copies (.card-title,
 *     .tile-search) and the pages-vs-components Dashboard failure
 *     (.dashboard-stack .tile lost to .tile). Print / reduced-motion
 *     overrides are excluded. Counts may only go DOWN.
 *  3. maxAdhoc counters — hardcoded rgb()/hsl() values, hex color literals
 *     (#rgb / #rrggbb / #rrggbbaa in declaration values; @media print and
 *     tokens.css token-definition lines excluded), rgb()/hex on
 *     non-tokens.css custom properties (customPropertyRgb /
 *     customPropertyHex — desk-themes reassignment and prefers-contrast
 *     overrides are classified, not skipped; a same-line
 *     local-palette comment allowlist opts a line out of the ratchet),
 *     literal ms durations, literal font-weight numbers, literal rem
 *     font-sizes, off-scale spacing lengths (padding/margin/gap values
 *     that match no --space-* / --hair-* token; on-scale literals are
 *     tolerated but prefer the token). Counts may only go DOWN; an
 *     increase over the baseline fails.
 *  4. Undefined var() references (R9-05) — a `var(--x)` whose --x is
 *     declared in no stylesheet and written by no JS is a hard failure:
 *     the fallback silently masks the missing token (or invalidates the
 *     declaration outright when no fallback exists). CSS declarations
 *     (`--x:` at any scope, `@property`) and JS writes (`'--x'` style
 *     keys, `setProperty('--x', …)`) both satisfy a reference; test files
 *     are not scanned. Whitelist: UNDEFINED_VAR_WHITELIST.
 *
 * Ratchet gate (G02 — residual dimensions turned blocking):
 *  3. NEW non-token border-radius (drift or tokenMatch), per file:line with
 *     a replacement token suggestion.
 *  4. NEW literal motion durations / easings, per file:line with a
 *     --duration-* / --ease-* token suggestion.
 *  5. NEW static TSX inline styles, per file:line with an owner/CSS
 *     suggestion (must be on the L03 fixture list to be allowed).
 *  6. Per-file debt ratchet: an existing item key may only shrink or stay;
 *     `--write-baseline` refuses to write a baseline larger than the
 *     current one (growing counts or new entries are rejected).
 *  7. NEW forbidden §0.2 patterns (caps, italic, inkRule, hoverTransform,
 *     keyframes, texture) in src/styles/*.css. Grandfathered in the
 *     baseline; each kind may only shrink or stay. Exemptions: tokens.css /
 *     print.css / landing.css, prefers-reduced-motion, .eyebrow / .page-head
 *     caps, .btn-primary / .result-card hover transforms, retained
 *     loading/cursor/desk keyframes (loading-pulse, empty-float,
 *     cursor-blink, typewriter-pop, desk-ssh-blink, capture-*).
 *
 * Informational only (never fails):
 *  - hardcoded colors, per file + selector, categorized:
 *    tokenDefinition / dynamicFallback / sourceAccent / print (whitelisted)
 *    vs semanticMatch (value equals a token — should use the token) and
 *    unknown (real drift). New rgb()/hsl() literals are still blocked by
 *    the maxAdhoc.rgbValues counter; new hex literals by maxAdhoc.hexValues.
 *
 * Whitelisted exceptions (explicit, minimal):
 *  - `border-radius: 50%` (circles), `0` / `inherit` / `initial` / `unset`
 *  - print CSS (`@media print` blocks)
 *  - token definitions in tokens.css (`--x: <color>` custom property lines)
 *  - same-line local-palette comment on a non-tokens.css custom property
 *    (classified, not ratcheted; desk-themes / prefers-contrast stay counted)
 *  - dynamic CSS custom property fallbacks (`var(--x, <value>)`)
 *  - source accents (rules under `.tile-*` / `.source-*` / `.compact-row--*`
 *    selectors)
 *  - motion literals inside `@media (prefers-reduced-motion: reduce)`
 *    (canonical reduced-motion override pattern)
 *  - dynamic TSX inline styles covered by scripts/inline-style-fixtures.json
 *    (L03 gate).
 *
 * Usage:
 *   node scripts/check-style-drift.mjs                  # verify against baseline
 *   node scripts/check-style-drift.mjs --write-baseline # regenerate baseline (refuses to grow it)
 *   node scripts/check-style-drift.mjs --scan <dir> [--json]  # analyze a dir, no gate
 *   node scripts/check-style-drift.mjs --verify <dir> [--baseline <file>]  # run the gate on a dir
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(webRoot, 'src', 'styles')
const srcDir = join(webRoot, 'src')
const baselinePath = join(webRoot, 'scripts', 'style-drift-baseline.json')

/* ── Small helpers ──────────────────────────────────────────────────── */
/** Strip comments while preserving line numbers (newlines kept). */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
}

export function normalizeColor(value) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function normalizeSelector(sel) {
  return sel.replace(/\s+/g, ' ').trim()
}

function splitSelectors(header) {
  // split on top-level commas only (ignore commas inside () / [])
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of header) {
    if (ch === '(' || ch === '[') depth += 1
    if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => normalizeSelector(p)).filter(Boolean)
}

/** Recursively list files under dir, skipping build/vcs noise. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function relName(root, p) {
  return relative(root, p).split(sep).join('/')
}

/* ── Naive but sufficient CSS rule scanner ─────────────────────────────
 * Produces one entry per rule: normalized header, declaration line of the
 * header, body char span and whether the rule lives inside `@media print`
 * (print CSS is whitelisted for color/motion/radius reporting) or inside
 * `@media (prefers-reduced-motion: reduce)` (motion literals there are the
 * canonical reduced-motion override pattern).
 * Keyframes bodies are skipped; custom-property blocks (`--x { … }`) are
 * not selectors. */
export function scanCssRules(text) {
  const noComments = stripComments(text)
  const rules = [] // { selector, line, bodyStart, bodyEnd, print, reducedMotion, contrast, media }
  const stack = [] // { kind: 'rule' | 'container' | 'skip', print, reducedMotion, contrast, media?, rule? }
  let buf = ''
  let bufStartLine = 1
  let line = 1
  let i = 0
  const isPrint = (s) => s.some((e) => e.kind === 'container' && e.print)
  const isReducedMotion = (s) => s.some((e) => e.kind === 'container' && e.reducedMotion)
  const isContrast = (s) => s.some((e) => e.kind === 'container' && e.contrast)
  const isSkip = (s) => s.some((e) => e.kind === 'skip')
  const stackedMedia = (s) => s.filter((e) => e.kind === 'container' && e.media).map((e) => e.media).join(' and ')
  while (i < noComments.length) {
    const ch = noComments[i]
    if (ch === '\n') line += 1
    if (ch === '{') {
      const header = buf.trim()
      const inPrint = isPrint(stack)
      const inReduced = isReducedMotion(stack)
      const inContrast = isContrast(stack)
      if (/^@(keyframes|-\w+-keyframes)\b/i.test(header)) {
        stack.push({ kind: 'skip', print: inPrint, reducedMotion: inReduced, contrast: inContrast })
      } else if (header.startsWith('@')) {
        const media = /^@media\b/i.test(header) ? normalizeSelector(header.replace(/^@media\s*/i, '')) : ''
        stack.push({
          kind: 'container',
          print: inPrint || /^@media\s+print\b/i.test(header),
          reducedMotion: inReduced || /^@media\s*\(prefers-reduced-motion/i.test(header),
          contrast: inContrast || /^@media\s*\(prefers-contrast/i.test(header),
          media,
        })
      } else {
        if (!isSkip(stack) && header && !header.startsWith('--')) {
          const rule = {
            selector: normalizeSelector(header),
            line: bufStartLine,
            bodyStart: i + 1,
            bodyEnd: -1,
            print: inPrint,
            reducedMotion: inReduced,
            contrast: inContrast,
            media: stackedMedia(stack),
          }
          rules.push(rule)
          stack.push({ kind: 'rule', print: inPrint, reducedMotion: inReduced, contrast: inContrast, rule })
        } else {
          stack.push({ kind: 'rule', print: inPrint, reducedMotion: inReduced, contrast: inContrast })
        }
      }
      buf = ''
      bufStartLine = line
    } else if (ch === '}') {
      const top = stack.pop()
      if (top && top.kind === 'rule' && top.rule) top.rule.bodyEnd = i
      buf = ''
      bufStartLine = line
    } else if (ch === ';') {
      buf = ''
      bufStartLine = line
    } else {
      buf += ch
    }
    i += 1
  }
  return rules
}

const FORBIDDEN_FILES = new Set(['tokens.css', 'print.css', 'landing.css'])
const FORBIDDEN_KINDS = ['caps', 'italic', 'inkRule', 'hoverTransform', 'keyframes', 'texture']
const FORBIDDEN_HINTS = {
  caps: 'use .section-label weight/color instead',
  italic: 'drop font-style',
  inkRule: '1px solid var(--line)',
  hoverTransform: 'remove transform; keep color/border/shadow',
  keyframes: 'remove; use transition with --duration-* tokens',
  texture: 'remove background-image',
}
const INK_BORDER_PROPS = new Set([
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-block', 'border-inline',
])
const INK_BORDER_RE = /^\s*[2-9]px\s+solid\s+var\(--ink\)/
const TEXTURE_VARS = ['--dither', '--dither-paper', '--grain', '--band-texture']
const KEYFRAME_EXEMPT_RE = /loading-pulse|empty-float|cursor-blink|typewriter-pop|desk-ssh-blink|capture-/

function declarationEntries(body) {
  const entries = []
  for (const part of body.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const name = part.slice(0, i).trim().toLowerCase()
    const value = part.slice(i + 1).trim()
    if (!name || name.startsWith('--') || name.startsWith('@')) continue
    entries.push({ name, value })
  }
  return entries
}

function forbiddenFileName(file) {
  return file.split('/').pop()
}

function isKeyframeExempt(text) {
  return KEYFRAME_EXEMPT_RE.test(text)
}

function classifyForbiddenRule(file, selector, decls, reducedMotion) {
  if (reducedMotion) return []
  const kinds = []
  const hasUppercase = decls.some((d) => d.name === 'text-transform' && /\buppercase\b/i.test(d.value))
  const hasTracking = decls.some((d) => d.name === 'letter-spacing')
  if (hasUppercase && hasTracking) {
    const exactEyebrow = splitSelectors(selector).some((s) => s === '.eyebrow')
    if (!exactEyebrow && !selector.includes('.page-head')) kinds.push('caps')
  }
  if (decls.some((d) => d.name === 'font-style' && /\bitalic\b/i.test(d.value))) kinds.push('italic')
  if (decls.some((d) => INK_BORDER_PROPS.has(d.name) && INK_BORDER_RE.test(d.value))) kinds.push('inkRule')
  if (/:hover/.test(selector)
      && decls.some((d) => d.name === 'transform' && /(translate|scale)/i.test(d.value))
      && !selector.includes('.btn-primary')
      && !selector.includes('.result-card')) {
    kinds.push('hoverTransform')
  }
  const animationText = decls
    .filter((d) => d.name === 'animation' || d.name === 'animation-name')
    .map((d) => d.value)
    .join(' ')
  if (animationText && !isKeyframeExempt(`${selector} ${animationText}`)) kinds.push('keyframes')
  if (decls.some((d) => TEXTURE_VARS.some((v) => d.value.includes(`var(${v})`)))) kinds.push('texture')
  return kinds.map((kind) => `${kind} :: ${file} :: ${selector}`)
}

/** Scan `dir` stylesheets for §0.2 forbidden patterns. Returns sorted unique
 *  item keys `"kind :: file :: selector"` and per-kind counts. */
export function collectForbiddenPatterns(dir) {
  const files = walk(dir).filter((f) => f.endsWith('.css')).sort()
  const items = new Set()
  for (const file of files) {
    const name = relName(dir, file)
    if (FORBIDDEN_FILES.has(forbiddenFileName(name))) continue
    const text = readFileSync(file, 'utf8')
    const noComments = stripComments(text)
    for (const rule of scanCssRules(text)) {
      const body = noComments.slice(rule.bodyStart, rule.bodyEnd < 0 ? noComments.length : rule.bodyEnd)
      for (const item of classifyForbiddenRule(name, rule.selector, declarationEntries(body), rule.reducedMotion)) {
        items.add(item)
      }
    }
    for (const match of noComments.matchAll(/@(-[a-z]+-)?keyframes\s+([\w-]+)/gi)) {
      const selector = `@keyframes ${match[2]}`
      if (isKeyframeExempt(selector)) continue
      items.add(`keyframes :: ${name} :: ${selector}`)
    }
  }
  const sorted = [...items].sort()
  const counts = {}
  for (const kind of FORBIDDEN_KINDS) counts[kind] = 0
  for (const item of sorted) {
    const kind = item.split(' :: ')[0]
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return { items: sorted, counts }
}

/** Fallback layer rank when a tree has no `@layer a, b, …;` statement.
 *  Later = winning. Overridden by parseLayerOrder() when tokens.css is present. */
export const LAYER_RANK = {
  tokens: 0,
  base: 1,
  pages: 2,
  patterns: 3,
  components: 4,
  utilities: 5,
  print: 6,
}

/** `@layer tokens, base, pages, …;` order statement → { name: rank }. Later = winning. */
export function parseLayerOrder(cssText) {
  const text = stripComments(cssText)
  const match = text.match(/@layer\s+((?:[\w-]+\s*,\s*)+[\w-]+)\s*;/)
  if (!match) return null
  const names = match[1].split(',').map((n) => n.trim()).filter(Boolean)
  if (names.length < 2) return null
  const rank = {}
  names.forEach((name, i) => { rank[name] = i })
  return rank
}

/** CSS import order from a `main.tsx`-style entry. Later index = winning source order.
 *  Bare filenames (`cards.css`) so fixture imports and `./styles/cards.css` compare. */
export function parseCssImportOrder(tsxText) {
  const order = []
  const seen = new Set()
  for (const match of tsxText.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm)) {
    const spec = match[1]
    if (spec.startsWith('@')) continue
    const base = spec.split('/').pop()
    if (!base || seen.has(base)) continue
    seen.add(base)
    order.push(base)
  }
  return order
}

function resolveCascadeContext(dir) {
  const tokensPath = existsSync(join(dir, 'tokens.css'))
    ? join(dir, 'tokens.css')
    : existsSync(join(dir, '..', 'tokens.css'))
      ? join(dir, '..', 'tokens.css')
      : null
  const mainPath = existsSync(join(dir, 'main.tsx'))
    ? join(dir, 'main.tsx')
    : existsSync(join(dir, '..', 'main.tsx'))
      ? join(dir, '..', 'main.tsx')
      : existsSync(join(dir, '..', 'src', 'main.tsx'))
        ? join(dir, '..', 'src', 'main.tsx')
        : null
  const layerRank = tokensPath ? (parseLayerOrder(readFileSync(tokensPath, 'utf8')) ?? { ...LAYER_RANK }) : { ...LAYER_RANK }
  const importOrder = mainPath ? parseCssImportOrder(readFileSync(mainPath, 'utf8')) : []
  return { layerRank, importOrder }
}

function buildFileRank(fileNames, importOrder) {
  const rank = new Map()
  let n = 0
  for (const name of importOrder) {
    if (fileNames.includes(name) && !rank.has(name)) rank.set(name, n++)
  }
  for (const name of [...fileNames].sort()) {
    if (!rank.has(name)) rank.set(name, n++)
  }
  return rank
}

/** First top-level `@layer name {` after an optional order statement. */
export function stylesheetLayer(cssText) {
  let text = stripComments(cssText).trimStart()
  text = text.replace(/^@layer\s+[\w-]+(?:\s*,\s*[\w-]+)*;\s*/, '')
  const match = text.match(/^@layer\s+([\w-]+)\s*\{/)
  return match ? match[1] : null
}

/** Split a selector into compound selectors (combinators dropped). */
export function splitCompounds(selector) {
  const parts = []
  let cur = ''
  let depth = 0
  for (const ch of selector) {
    if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
      if (cur.trim()) parts.push(cur.trim())
      cur = ''
      continue
    }
    if (depth === 0 && ch === ' ') {
      if (cur.trim()) {
        parts.push(cur.trim())
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function parseCompound(compound) {
  const classes = new Set()
  const ids = new Set()
  const attrs = new Set()
  const pseudos = new Set()
  let type = null
  let i = 0
  const s = compound.trim()
  while (i < s.length) {
    const ch = s[i]
    if (ch === '.') {
      i += 1
      const m = s.slice(i).match(/^[\w-]+/)
      if (m) {
        classes.add(m[0])
        i += m[0].length
      }
    } else if (ch === '#') {
      i += 1
      const m = s.slice(i).match(/^[\w-]+/)
      if (m) {
        ids.add(m[0])
        i += m[0].length
      }
    } else if (ch === '[') {
      const end = s.indexOf(']', i)
      if (end === -1) break
      attrs.add(s.slice(i, end + 1).replace(/\s+/g, ''))
      i = end + 1
    } else if (ch === ':') {
      const start = i
      i += 1
      if (s[i] === ':') i += 1
      const m = s.slice(i).match(/^[\w-]+/)
      if (m) i += m[0].length
      if (s[i] === '(') {
        let depth = 1
        i += 1
        while (i < s.length && depth) {
          if (s[i] === '(') depth += 1
          else if (s[i] === ')') depth -= 1
          i += 1
        }
      }
      pseudos.add(s.slice(start, i))
    } else if (ch === '*') {
      i += 1
    } else if (/[\w-]/.test(ch)) {
      const m = s.slice(i).match(/^[\w-]+/)
      if (m) {
        type = m[0]
        i += m[0].length
      } else {
        i += 1
      }
    } else {
      i += 1
    }
  }
  return { type, classes, ids, attrs, pseudos }
}

function compoundIsUniversal(parsed) {
  return !parsed.type && parsed.classes.size === 0 && parsed.ids.size === 0 && parsed.attrs.size === 0 && parsed.pseudos.size === 0
}

/** True when `specific` satisfies every simple selector in `general`. */
function compoundContains(specific, general) {
  if (general.type && general.type !== specific.type) return false
  for (const c of general.classes) if (!specific.classes.has(c)) return false
  for (const id of general.ids) if (!specific.ids.has(id)) return false
  for (const a of general.attrs) if (!specific.attrs.has(a)) return false
  for (const p of general.pseudos) if (!specific.pseudos.has(p)) return false
  return true
}

/**
 * True when every element matching `specific` also matches `general`.
 * `*` does not cover other selectors (would drown the gate).
 */
export function selectorCovers(general, specific) {
  if (general === specific) return true
  const g = splitCompounds(general).map(parseCompound)
  const s = splitCompounds(specific).map(parseCompound)
  if (g.length === 0 || s.length === 0) return false
  if (g.length === 1 && compoundIsUniversal(g[0])) return false
  if (!compoundContains(s[s.length - 1], g[g.length - 1])) return false
  if (g.length === 1) return true
  let si = s.length - 2
  for (let gi = g.length - 2; gi >= 0; gi -= 1) {
    let found = false
    while (si >= 0) {
      if (compoundContains(s[si], g[gi])) {
        found = true
        si -= 1
        break
      }
      si -= 1
    }
    if (!found) return false
  }
  return true
}

export function selectorSpecificity(selector) {
  let a = 0
  let b = 0
  let c = 0
  for (const raw of splitCompounds(selector)) {
    const p = parseCompound(raw)
    a += p.ids.size
    b += p.classes.size + p.attrs.size
    for (const pseudo of p.pseudos) {
      if (pseudo.startsWith('::')) c += 1
      else if (!pseudo.startsWith(':where')) b += 1
    }
    if (p.type) c += 1
  }
  return { a, b, c }
}

function compareSpecificity(left, right) {
  if (left.a !== right.a) return left.a - right.a
  if (left.b !== right.b) return left.b - right.b
  return left.c - right.c
}

function cascadeBeats(winner, loser, layerRank, fileRank) {
  const wLayer = layerRank[winner.layer]
  const lLayer = layerRank[loser.layer]
  if (wLayer == null || lLayer == null) return false
  if (wLayer !== lLayer) return wLayer > lLayer
  const spec = compareSpecificity(winner.spec, loser.spec)
  if (spec !== 0) return spec > 0
  const wFile = fileRank.get(winner.file) ?? -1
  const lFile = fileRank.get(loser.file) ?? -1
  if (wFile !== lFile) return wFile > lFile
  return winner.line > loser.line
}

function declarationProps(body) {
  const props = new Set()
  for (const part of body.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const name = part.slice(0, i).trim().toLowerCase()
    if (!name || name.startsWith('--') || name.startsWith('@')) continue
    props.add(name)
  }
  return props
}

/** Winner shorthand defeats the matching loser longhands (padding: 0 vs padding-bottom). */
const SHORTHAND_LONGHANDS = {
  padding: ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block', 'padding-inline-start', 'padding-inline-end', 'padding-block-start', 'padding-block-end'],
  margin: ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block', 'margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end'],
}

function collidingProps(loserProps, winnerProps) {
  const overlap = new Set()
  for (const prop of loserProps) {
    if (winnerProps.has(prop)) overlap.add(prop)
  }
  for (const [shorthand, longs] of Object.entries(SHORTHAND_LONGHANDS)) {
    if (!winnerProps.has(shorthand)) continue
    for (const long of longs) {
      if (loserProps.has(long)) overlap.add(long)
    }
  }
  return [...overlap].sort()
}

/** True when the winner's media applies whenever the loser's does. */
function mediaCovers(winnerMedia, loserMedia) {
  if (!winnerMedia) return true
  return winnerMedia === loserMedia
}

/**
 * Cascade overlaps: a rule is keyed when another file's rule covers it
 * (matches every element it matches), shares properties, the winner's media
 * covers the loser's, and the winner beats it by layer / specificity /
 * import order. Same-layer pairs are included (later import wins at equal
 * specificity). Print and reduced-motion are excluded.
 * Keys: `${loserSelector} :: ${loserFile} < ${winnerFile} :: ${property}`
 */
export function collectCrossLayerOverlaps(dir) {
  const { layerRank, importOrder } = resolveCascadeContext(dir)
  const files = walk(dir).filter((f) => f.endsWith('.css')).sort()
  const occs = []
  const fileNames = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = relName(dir, file)
    const layer = stylesheetLayer(text)
    if (!layer || layerRank[layer] == null || layer === 'print') continue
    fileNames.push(name)
    const noComments = stripComments(text)
    for (const rule of scanCssRules(text)) {
      if (rule.print || rule.reducedMotion) continue
      const props = declarationProps(noComments.slice(rule.bodyStart, rule.bodyEnd))
      if (props.size === 0) continue
      for (const sel of splitSelectors(rule.selector)) {
        occs.push({
          selector: sel,
          file: name,
          layer,
          media: rule.media ?? '',
          props,
          line: rule.line,
          spec: selectorSpecificity(sel),
        })
      }
    }
  }

  const fileRank = buildFileRank(fileNames, importOrder)
  const bySubject = new Map()
  const subjectKey = (sel) => {
    const last = splitCompounds(sel).at(-1)
    if (!last) return []
    const parsed = parseCompound(last)
    const keys = [...parsed.classes, ...[...parsed.ids].map((id) => `#${id}`), ...parsed.attrs]
    if (keys.length === 0 && parsed.type) keys.push(`type:${parsed.type}`)
    return keys
  }
  for (const occ of occs) {
    for (const key of subjectKey(occ.selector)) {
      if (!bySubject.has(key)) bySubject.set(key, [])
      bySubject.get(key).push(occ)
    }
  }

  const keys = []
  const details = []
  const seenPair = new Set()
  for (const group of bySubject.values()) {
    for (const loser of group) {
      for (const winner of group) {
        if (loser === winner) continue
        if (loser.file === winner.file) continue
        const pairId = `${loser.line}\0${loser.file}\0${loser.selector}\0${winner.line}\0${winner.file}\0${winner.selector}`
        if (seenPair.has(pairId)) continue
        seenPair.add(pairId)
        if (!selectorCovers(winner.selector, loser.selector)) continue
        if (!cascadeBeats(winner, loser, layerRank, fileRank)) continue
        if (!mediaCovers(winner.media, loser.media)) continue
        const overlap = collidingProps(loser.props, winner.props)
        if (overlap.length === 0) continue
        details.push({
          selector: loser.selector,
          loserFile: loser.file,
          loserLine: loser.line,
          loserLayer: loser.layer,
          winnerFile: winner.file,
          winnerLayer: winner.layer,
          media: loser.media,
          props: overlap,
        })
        for (const prop of overlap) {
          keys.push(`${loser.selector} :: ${loser.file} < ${winner.file} :: ${prop}`)
        }
      }
    }
  }
  keys.sort()
  return { keys: [...new Set(keys)], details }
}

/** Map each 0-based line index to the innermost rule that owns it. */
function ruleOwnerByLine(noComments, rules) {
  const lineStarts = [0]
  for (let i = 0; i < noComments.length; i += 1) {
    if (noComments[i] === '\n') lineStarts.push(i + 1)
  }
  const owner = new Array(lineStarts.length).fill(null)
  const sorted = [...rules].sort((a, b) => a.bodyStart - b.bodyStart)
  for (let li = 0; li < lineStarts.length; li += 1) {
    const start = lineStarts[li]
    const end = li + 1 < lineStarts.length ? lineStarts[li + 1] : noComments.length
    // innermost = the rule with the largest bodyStart that overlaps this
    // line (handles multi-line bodies as well as one-liner rules)
    let best = null
    for (const r of sorted) {
      if (r.bodyStart > end) break
      if (r.bodyEnd > start) best = r
    }
    owner[li] = best
  }
  return owner
}

/* ── Token index ────────────────────────────────────────────────────── */
/** Map normalized color literal -> token name, from `--x: <color>` lines. */
export function extractColorTokens(cssText) {
  const map = new Map()
  for (const line of cssText.split('\n')) {
    const m = line.match(/^\s*--([\w-]+)\s*:\s*((?:rgb|hsl)a?\([^;]+\))\s*;?/)
    if (m) map.set(normalizeColor(m[2]), `--${m[1]}`)
  }
  return map
}

/** Map normalized radius literal -> radius token name (tokens.css). */
export function extractRadiusTokens(cssText) {
  const map = new Map()
  for (const line of cssText.split('\n')) {
    const m = line.match(/^\s*--(radius[\w-]*)\s*:\s*([^;]+)\s*;?/)
    if (m) map.set(normalizeSelector(m[2]), `--${m[1]}`)
  }
  return map
}

/** `--duration-*` / `--ease-*` token definitions from tokens.css. */
export function extractMotionTokens(cssText) {
  const tokens = []
  for (const line of cssText.split('\n')) {
    const m = line.match(/^\s*--((?:duration|ease)[\w-]*)\s*:\s*([^;]+)\s*;?/)
    if (m) tokens.push({ token: `--${m[1]}`, value: normalizeSelector(m[2]) })
  }
  return tokens
}

/** `--space-*` / `--hair-*` scale values (rem numbers) from tokens.css. */
export function extractSpaceTokens(cssText) {
  const scale = new Set()
  for (const line of cssText.split('\n')) {
    const m = line.match(/^\s*--(?:space|hair)-[\w-]+\s*:\s*([^;]+)\s*;?/)
    if (!m) continue
    const value = m[1].trim()
    if (value === '0') {
      scale.add(0)
      continue
    }
    const rem = value.match(/^([\d.]+)rem$/)
    if (rem) scale.add(Number(rem[1]))
  }
  return scale
}

/** Radius + motion token lists used for replacement suggestions. */
export function buildTokenHints(cssText) {
  const radiusTokens = []
  for (const line of cssText.split('\n')) {
    const m = line.match(/^\s*--(radius[\w-]*)\s*:\s*([^;]+)\s*;?/)
    if (m) radiusTokens.push({ token: `--${m[1]}`, value: normalizeSelector(m[2]) })
  }
  return { radiusTokens, motionTokens: extractMotionTokens(cssText) }
}

const COLOR_LITERAL_RE = /\b(?:rgb|hsl)a?\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:white|black)(?![\w-])\b/g
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g
const RGB_HSL_RE = /\b(?:rgb|hsl)a?\s*\(/g
const LOCAL_PALETTE_RE = /\/\*\s*local-palette\s*\*\//
const CUSTOM_PROP_LINE_RE = /^\s*--[\w-]+\s*:/

function isTokensStylesheet(fileName) {
  return fileName === 'tokens.css' || fileName.endsWith('/tokens.css')
}

function isDeskThemesStylesheet(fileName) {
  return fileName === 'desk-themes.css' || fileName.endsWith('/desk-themes.css')
}

/** Classify a non-tokens.css custom-property color so it is never silently skipped. */
export function classifyCustomPropertyColor(fileName, rule, originalLine) {
  if (LOCAL_PALETTE_RE.test(originalLine)) return 'localPalette'
  if (rule?.contrast) return 'contrastOverride'
  if (isDeskThemesStylesheet(fileName)) return 'themeReassignment'
  return 'customProperty'
}

function emptyMaxAdhoc() {
  return {
    rgbValues: 0,
    literalMs: 0,
    literalFontWeight: 0,
    literalFontSize: 0,
    literalLineHeight: 0,
    spacing: 0,
    hexValues: 0,
    customPropertyRgb: 0,
    customPropertyHex: 0,
  }
}

/**
 * Hex color literals in a rule body's declaration values. Selectors are
 * outside the body span (so `#set-name` / `#feed` ID selectors never
 * count). Custom-property values (`--token: #fff`) are skipped; `var()`
 * fallbacks like `color: var(--x, #fff)` ARE counted so they cannot sneak
 * past the gate. `white`/`black` keywords are not hex.
 */
function countHexInDeclarationValues(line, lineStart, rule) {
  const from = Math.max(0, rule.bodyStart - lineStart)
  const to = Math.min(line.length, rule.bodyEnd < 0 ? line.length : rule.bodyEnd - lineStart)
  if (from >= to) return 0
  const body = line.slice(from, to)
  const tokenDefSpans = [...body.matchAll(/--[\w-]+\s*:/g)].map((m) => {
    const semi = body.indexOf(';', m.index)
    return { start: m.index, end: semi === -1 ? body.length : semi }
  })
  let count = 0
  for (const m of body.matchAll(HEX_COLOR_RE)) {
    if (tokenDefSpans.some((s) => m.index >= s.start && m.index < s.end)) continue
    count += 1
  }
  return count
}

const DURATION_RE = /(?<![\d.])\d+(?:\.\d+)?(?:ms|s)\b/g
const EASING_RE = /cubic-bezier\([^)]*\)/g
const KEYWORD_COLORS = { white: 'rgb(255 255 255)', black: 'rgb(0 0 0)' }

/* Spacing declarations (padding/margin/gap longhands + shorthands).
 * Dynamic values (var/calc/clamp/…) are stripped before measuring, so only
 * bare lengths remain; a length counts when no --space-* token holds that
 * value (px is normalized at 16px/rem, sign ignored, 0 always on-scale). */
const SPACING_PROP_RE = /(?:^|[;{])\s*(?:padding(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?|margin(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?|(?:row-|column-)?gap)\s*:\s*([^;}]+)/g
const SPACING_FUNC_RE = /(?:var|calc|clamp|min|max|minmax|repeat)\([^)]*\)/g
const SPACING_LENGTH_RE = /^-?(\d*\.?\d+)(rem|px)$/

function countOffScaleSpacing(line, spaceScale) {
  let count = 0
  for (const m of line.matchAll(SPACING_PROP_RE)) {
    const value = m[1].replace(SPACING_FUNC_RE, ' ')
    for (const token of value.split(/[\s,]+/)) {
      const len = token.match(SPACING_LENGTH_RE)
      if (!len) continue
      const rem = len[2] === 'px' ? Number(len[1]) / 16 : Number(len[1])
      if (rem === 0 || spaceScale.has(rem)) continue
      count += 1
    }
  }
  return count
}

function isSourceAccentSelector(selector) {
  const first = splitSelectors(selector)[0] ?? ''
  // Per-source skins: tile themes, source chips/dots, source color-coded
  // compact rows (`.compact-row--github`, `.compact-row--ted`, …).
  return first.startsWith('.tile-') || first.startsWith('.source-') || /^\.compact-row--/.test(first)
}

/* ── Per-file CSS analysis ──────────────────────────────────────────── */
/**
 * Analyze one stylesheet. Returns:
 *  - maxAdhoc: legacy counters (identical semantics to the Wave-0 gate)
 *  - radius / motion / colors: residual report items (drift + informational)
 *  - whitelisted: counts of explicitly allowed exceptions
 *  - printColors: colors skipped due to @media print (informational count)
 */
export function analyzeCssFile(fileName, cssText, tokenIndex, radiusTokenIndex, spaceScale = new Set()) {
  const originalLines = cssText.split('\n')
  const noComments = stripComments(cssText)
  const rules = scanCssRules(noComments)
  const ownerByLine = ruleOwnerByLine(noComments, rules)
  const lines = noComments.split('\n')
  const tokensFile = isTokensStylesheet(fileName)

  const maxAdhoc = emptyMaxAdhoc()
  const radius = []
  const motion = []
  const colors = []
  const customPropertyColors = []
  const whitelisted = { circle50: 0, radiusToken: 0, radiusNeutral: 0, tokenDefinition: 0, dynamicFallback: 0, sourceAccent: 0, localPalette: 0 }

  let lineStart = 0
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]
    const originalLine = originalLines[li] ?? ''
    const lineNo = li + 1
    const rule = ownerByLine[li]
    const isCustomPropLine = CUSTOM_PROP_LINE_RE.test(line)
    const propSpans = [...line.matchAll(/--[\w-]+\s*:/g)].map((m) => {
      const semi = line.indexOf(';', m.index)
      return { start: m.index, end: semi === -1 ? line.length : semi }
    })

    /* Legacy maxAdhoc counters — rgb/hex inside --token: … are not rgbValues.
     * Anchors are `(?:^|[;{])` (same as SPACING_PROP_RE), not `^\s*`: a
     * one-line rule `.x { color: red; font-size: 1rem }` must not evade the
     * ratchet just because the declaration does not open the line (R9-03). */
    if (!isCustomPropLine) {
      if (/(?:^|[;{])\s*(transition|transition-duration|animation|animation-duration)\s*:/.test(line)) {
        const ms = line.match(/(?<![\d.])\d+ms/g)
        if (ms) maxAdhoc.literalMs += ms.length
      }
      if (/(?:^|[;{])\s*font-weight\s*:\s*\d/.test(line)) maxAdhoc.literalFontWeight += 1
      if (/(?:^|[;{])\s*font-size\s*:\s*[\d.]+rem/.test(line)) maxAdhoc.literalFontSize += 1
      /* R9-06: line-height was the largest ungated dimension — numeric
         literals must sit on the --leading-* scale or carry an off-scale
         comment on the same source line (the spacing model's escape
         hatch; `line` is comment-stripped, so check `originalLine`). */
      if (/(?:^|[;{])\s*line-height\s*:\s*[\d.]+(?:rem)?\b/.test(line) && !/\*\s*off-scale:/.test(originalLine)) {
        maxAdhoc.literalLineHeight += 1
      }
      maxAdhoc.spacing += countOffScaleSpacing(line, spaceScale)
    }
    for (const m of line.matchAll(RGB_HSL_RE)) {
      const inProp = propSpans.some((s) => m.index >= s.start && m.index < s.end)
      if (!inProp) {
        maxAdhoc.rgbValues += 1
        continue
      }
      if (tokensFile || (rule && rule.print)) continue
      const category = classifyCustomPropertyColor(fileName, rule, originalLine)
      if (category === 'localPalette') {
        whitelisted.localPalette += 1
        continue
      }
      maxAdhoc.customPropertyRgb += 1
      const full = line.slice(m.index).match(/^(?:rgb|hsl)a?\([^)]*\)/)
      customPropertyColors.push({
        file: fileName,
        line: lineNo,
        selector: rule?.selector ?? fileName,
        category,
        value: full ? full[0] : m[0],
      })
    }

    /* Hex ratchet: declaration values only; print skipped. Token-def hex
     * is customPropertyHex unless tokens.css / local-palette / print. */
    if (rule && !rule.print) {
      maxAdhoc.hexValues += countHexInDeclarationValues(line, lineStart, rule)
      if (!tokensFile) {
        const bodyFrom = Math.max(0, rule.bodyStart - lineStart)
        const bodyTo = Math.min(line.length, rule.bodyEnd < 0 ? line.length : rule.bodyEnd - lineStart)
        const body = line.slice(bodyFrom, bodyTo)
        const category = classifyCustomPropertyColor(fileName, rule, originalLine)
        for (const hex of body.matchAll(HEX_COLOR_RE)) {
          const abs = bodyFrom + hex.index
          const inProp = propSpans.some((s) => abs >= s.start && abs < s.end)
          if (!inProp) continue
          if (category === 'localPalette') {
            whitelisted.localPalette += 1
            continue
          }
          maxAdhoc.customPropertyHex += 1
          customPropertyColors.push({
            file: fileName,
            line: lineNo,
            selector: rule.selector,
            category,
            value: hex[0],
          })
        }
      }
    }

    lineStart += line.length + 1

    /* Residual report dimensions. */
    if (!rule || rule.print) continue
    const selector = rule.selector

    /* Non-token radius (declarations may share a line with other props). */
    for (const radiusDecl of line.matchAll(/border-radius\s*:\s*([^;]+)/g)) {
      const value = normalizeSelector(radiusDecl[1]).replace(/\s*!important\s*$/, '')
      if (value.includes('var(--radius')) {
        whitelisted.radiusToken += 1
      } else if (/^50%(\s+50%)*$/.test(value)) {
        whitelisted.circle50 += 1
      } else if (/^(0|inherit|initial|unset)(\s+(0|inherit|initial|unset))*$/.test(value)) {
        whitelisted.radiusNeutral += 1
      } else {
        const token = radiusTokenIndex.get(value)
        radius.push({ file: fileName, line: lineNo, selector, kind: token ? 'tokenMatch' : 'drift', value, token: token ?? null })
      }
    }

    /* Literal durations / easings (dynamic var() fallbacks excluded; the
     * canonical `prefers-reduced-motion` override block is whitelisted). */
    if (!rule.reducedMotion) {
      for (const m of line.matchAll(/(?:transition|transition-duration|animation|animation-duration|transition-timing-function|animation-timing-function)\s*:/g)) {
        const semi = line.indexOf(';', m.index)
        const decl = line.slice(m.index + m[0].length, semi === -1 ? line.length : semi)
        const noVars = decl.replace(/var\([^)]*\)/g, '')
        for (const d of noVars.matchAll(DURATION_RE)) {
          motion.push({ file: fileName, line: lineNo, selector, kind: 'duration', value: d[0] })
        }
        for (const e of noVars.matchAll(EASING_RE)) {
          motion.push({ file: fileName, line: lineNo, selector, kind: 'easing', value: e[0] })
        }
      }
    }

    /* Hardcoded colors, categorized. */
    const tokenDefSpans = [...line.matchAll(/--[\w-]+\s*:/g)].map((m) => {
      const semi = line.indexOf(';', m.index)
      return { start: m.index, end: semi === -1 ? line.length : semi }
    })
    const varSpans = [...line.matchAll(/var\([^)]*\)/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
    for (const m of line.matchAll(COLOR_LITERAL_RE)) {
      const raw = m[0]
      const inTokenDef = tokenDefSpans.some((s) => m.index >= s.start && m.index < s.end)
      const inVar = varSpans.some((s) => m.index >= s.start && m.index < s.end)
      if (inTokenDef) {
        whitelisted.tokenDefinition += 1
      } else if (inVar) {
        whitelisted.dynamicFallback += 1
      } else if (isSourceAccentSelector(selector)) {
        whitelisted.sourceAccent += 1
      } else {
        const normalized = normalizeColor(KEYWORD_COLORS[raw] ?? raw)
        const token = tokenIndex.get(normalized)
        colors.push({ file: fileName, line: lineNo, selector, category: token ? 'semanticMatch' : 'unknown', value: raw, token: token ?? null })
      }
    }
  }

  return { maxAdhoc, radius, motion, colors, customPropertyColors, whitelisted }
}

/* ── TSX static inline style analysis ───────────────────────────────── */
/** Split an object literal body into top-level `key: value` props. */
function splitStyleProps(objText) {
  const props = []
  let depth = 0
  let cur = ''
  let quote = null
  for (const ch of objText) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      props.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) props.push(cur)
  return props
}

const STRING_LITERAL_RE = /^['"][^'"]*['"]$/
const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|fr|deg)?$/

/**
 * Extract the JSX expression after `style={` across lines; returns
 * { text, endLine, endCol } or null when unbalanced. Braces are kept so
 * nested object literals (`style={cond ? { marginTop: '1rem' } : undefined}`)
 * stay findable.
 */
function extractStyleExpression(lines, startLine, startCol) {
  let depth = 0
  let li = startLine
  let k = startCol
  let text = ''
  while (li < lines.length) {
    const line = lines[li]
    for (; k < line.length; k += 1) {
      const ch = line[k]
      if (ch === '{') {
        depth += 1
        text += ch
      } else if (ch === '}') {
        if (depth === 0) return { text, endLine: li, endCol: k + 1 }
        depth -= 1
        text += ch
      } else {
        text += ch
      }
    }
    li += 1
    k = 0
  }
  return null
}

/** Balanced `{…}` slices inside an expression text → candidate object bodies. */
function objectLiteralBodies(exprText) {
  const bodies = []
  for (let i = 0; i < exprText.length; i += 1) {
    if (exprText[i] !== '{') continue
    let depth = 0
    let body = ''
    let j = i + 1
    for (; j < exprText.length; j += 1) {
      const ch = exprText[j]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        if (depth === 0) break
        depth -= 1
      }
      body += ch
    }
    bodies.push(body)
    i = j // nested objects are part of this literal's values, not siblings
  }
  return bodies
}

/** True when every prop is a plain literal (`key: 'x'` / `key: 1rem`). */
function isStaticStyleObject(objText) {
  const props = splitStyleProps(objText)
  if (props.length === 0) return false
  for (const p of props) {
    const m = p.match(/^\s*([\w-]+)\s*:/)
    const key = m ? m[1] : ''
    const val = m ? p.slice(m[0].length).trim() : ''
    if (!m || key.startsWith('--') || !(STRING_LITERAL_RE.test(val) || NUMBER_LITERAL_RE.test(val))) {
      return false
    }
  }
  return true
}

const STYLE_ATTR_RE = /style=\s*\{/g

/** Analyze one TSX file for static inline styles. Any `style={…}`
 * expression is opened (R9-03 — the old `style={{` indexOf missed
 * `style={expr}` and `style={` + newline + `{` forms); every object
 * literal inside it is checked, and only all-literal ones are reported.
 * Dynamic styles (expressions, spreads, custom properties) are skipped. */
export function analyzeTsxFile(fileName, text) {
  const out = []
  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li += 1) {
    STYLE_ATTR_RE.lastIndex = 0
    let m
    while ((m = STYLE_ATTR_RE.exec(lines[li])) !== null) {
      // `style` must be a bare attribute — not `data-style=` / `fooStyle=`.
      if (m.index > 0 && /[\w$-]/.test(lines[li][m.index - 1])) continue
      const expr = extractStyleExpression(lines, li, m.index + m[0].length)
      if (!expr) break
      for (const body of objectLiteralBodies(expr.text)) {
        if (isStaticStyleObject(body)) {
          out.push({ file: fileName, line: li + 1, style: body.trim() })
        }
      }
      li = expr.endLine
      STYLE_ATTR_RE.lastIndex = expr.endCol
      if (li >= lines.length) break
    }
  }
  return out
}

/* ── Undefined var() reference gate (R9-05) ───────────────────────────
 * A `var(--x)` whose --x is never declared in a stylesheet nor written
 * from JS ('--x' style-object keys / `el.style.setProperty('--x', …)`)
 * silently resolves to its fallback — or invalidates the declaration
 * entirely when there is none. Both halves of the contract are indexed:
 * scoped declarations count (`.tile-ssh { --ssh-* }`, desk-themes
 * re-scopes, `@property`, `:root` media overrides), and JS-written props
 * count (`--vl-*`, `--progress`, `--canvas-bg-*`, …). Test files are
 * skipped on both sides — fixture strings like `var(--source-*)` are not
 * production code. A genuinely dynamic name goes in the whitelist below
 * with a one-line reason. */
const CUSTOM_PROP_DECL_RE = /(?<![\w-])(--[\w-]+)\s*:|@property\s+(--[\w-]+)/g
const VAR_REF_RE = /var\(\s*(--[\w-]+)/g
const TSX_PROP_WRITE_RE = /setProperty\(\s*['"](--[\w-]+)['"]|['"](--[\w-]+)['"](?:\s+as\s+[\w<>]+)?\s*\]?\s*:/g
const TEST_FILE_RE = /\.(?:test|spec|test-helper)\./
/* Registered escape hatch — prefer fixing the reference; every entry
 * must carry a one-line reason comment. */
const UNDEFINED_VAR_WHITELIST = new Set([
])

export function collectUndefinedVarRefs(dir) {
  const files = walk(dir)
  const declared = new Set()
  const refs = [] // { file, line, name }
  for (const file of files) {
    const name = relName(dir, file)
    if (file.endsWith('.css')) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      for (let li = 0; li < lines.length; li += 1) {
        for (const m of lines[li].matchAll(CUSTOM_PROP_DECL_RE)) declared.add(m[1] ?? m[2])
        for (const m of lines[li].matchAll(VAR_REF_RE)) refs.push({ file: name, line: li + 1, name: m[1] })
      }
    } else if ((file.endsWith('.ts') || file.endsWith('.tsx')) && !TEST_FILE_RE.test(name)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let li = 0; li < lines.length; li += 1) {
        for (const m of lines[li].matchAll(VAR_REF_RE)) refs.push({ file: name, line: li + 1, name: m[1] })
      }
    }
  }
  for (const file of files) {
    if (!(file.endsWith('.ts') || file.endsWith('.tsx')) || TEST_FILE_RE.test(relName(dir, file))) continue
    for (const m of readFileSync(file, 'utf8').matchAll(TSX_PROP_WRITE_RE)) declared.add(m[1] ?? m[2])
  }
  const out = []
  const seen = new Set()
  for (const r of refs) {
    if (declared.has(r.name) || UNDEFINED_VAR_WHITELIST.has(r.name)) continue
    const key = `${r.file}\0${r.line}\0${r.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/* ── Directory analysis ─────────────────────────────────────────────── */
export function analyzeDirectory(dir, { css = true, tsx = true } = {}) {
  const files = walk(dir)
  const cssFiles = css ? files.filter((f) => f.endsWith('.css')).sort() : []
  const tsxFiles = tsx ? files.filter((f) => f.endsWith('.tsx')).sort() : []

  /* Token indexes come from tokens.css inside the scanned tree. */
  let tokenIndex = new Map()
  let radiusTokenIndex = new Map()
  let spaceScale = new Set()
  const tokensFile = cssFiles.find((f) => relName(dir, f).endsWith('tokens.css'))
  if (tokensFile) {
    const tokensText = readFileSync(tokensFile, 'utf8')
    tokenIndex = extractColorTokens(tokensText)
    radiusTokenIndex = extractRadiusTokens(tokensText)
    spaceScale = extractSpaceTokens(tokensText)
  }

  /* Cross-file duplicate selectors (unchanged Wave-0 semantics). */
  const selectorFiles = new Map()
  for (const file of cssFiles) {
    const text = readFileSync(file, 'utf8')
    const name = relName(dir, file)
    for (const rule of scanCssRules(text)) {
      for (const sel of splitSelectors(rule.selector)) {
        if (!selectorFiles.has(sel)) selectorFiles.set(sel, new Set())
        selectorFiles.get(sel).add(name)
      }
    }
  }
  const duplicateSelectors = []
  for (const [sel, files] of selectorFiles) {
    if (files.size > 1) duplicateSelectors.push(`${sel} :: ${[...files].sort().join(', ')}`)
  }
  duplicateSelectors.sort()

  const crossLayerOverlaps = css ? collectCrossLayerOverlaps(dir).keys : []

  /* Residual report dimensions, per file. */
  const maxAdhoc = emptyMaxAdhoc()
  const radius = []
  const motion = []
  const colors = []
  const customPropertyColors = []
  const whitelisted = { circle50: 0, radiusToken: 0, radiusNeutral: 0, tokenDefinition: 0, dynamicFallback: 0, sourceAccent: 0, localPalette: 0 }

  for (const file of cssFiles) {
    const name = relName(dir, file)
    const res = analyzeCssFile(name, readFileSync(file, 'utf8'), tokenIndex, radiusTokenIndex, spaceScale)
    for (const key of Object.keys(maxAdhoc)) maxAdhoc[key] += res.maxAdhoc[key]
    radius.push(...res.radius)
    motion.push(...res.motion)
    colors.push(...res.colors)
    customPropertyColors.push(...(res.customPropertyColors ?? []))
    for (const key of Object.keys(whitelisted)) whitelisted[key] += res.whitelisted[key] ?? 0
  }

  const staticInlineStyles = []
  for (const file of tsxFiles) {
    staticInlineStyles.push(...analyzeTsxFile(relName(dir, file), readFileSync(file, 'utf8')))
  }

  const sortItems = (arr) => arr.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line))
  return {
    duplicateSelectors,
    crossLayerOverlaps,
    maxAdhoc,
    report: {
      radius: sortItems(radius),
      motion: sortItems(motion),
      colors: sortItems(colors),
      customPropertyColors: sortItems(customPropertyColors),
      staticInlineStyles: sortItems(staticInlineStyles),
      forbidden: css ? collectForbiddenPatterns(dir) : { items: [], counts: Object.fromEntries(FORBIDDEN_KINDS.map((k) => [k, 0])) },
      whitelisted,
    },
  }
}

/* ── G02 ratchet gate ───────────────────────────────────────────────── */
/** Stable identity of a residual item: file + selector + value. The line
 * number is intentionally excluded so that moving a declaration within a
 * file does not look like new debt; moving it to another file or selector
 * does. */
export function dimensionKey(dim, item) {
  switch (dim) {
    case 'radius': return `${item.file}\u0000${item.selector}\u0000${item.value}`
    case 'motion': return `${item.file}\u0000${item.selector}\u0000${item.kind}\u0000${item.value}`
    case 'staticInlineStyles': return `${item.file}\u0000${item.style}`
    case 'colors': return `${item.file}\u0000${item.selector}\u0000${item.category}\u0000${item.value}`
    default: throw new Error(`unknown residual dimension: ${dim}`)
  }
}

function countByKey(items, dim) {
  const counts = new Map()
  for (const item of items) {
    const key = dimensionKey(dim, item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Dimensions enforced by the G02 ratchet (colors stay informational). */
export const RESIDUAL_GATES = ['radius', 'motion', 'staticInlineStyles']

function valueText(dim, item) {
  return dim === 'staticInlineStyles' ? `style={{ ${item.style} }}` : item.value
}

function whereText(dim, item) {
  return dim === 'staticInlineStyles' ? `${item.file}:${item.line}` : `${item.file}:${item.line} (${item.selector})`
}

function suggestionFor(dim, item, hints) {
  if (dim === 'radius') {
    if (item.kind === 'tokenMatch') return `equals ${item.token}, use var(${item.token})`
    const list = (hints?.radiusTokens ?? []).map((t) => `${t.value} (${t.token})`).join(', ')
    return list ? `use a --radius-* token from tokens.css: ${list}` : 'use a --radius-* token from tokens.css'
  }
  if (dim === 'motion') {
    const prefix = item.kind === 'duration' ? '--duration' : '--ease'
    const list = (hints?.motionTokens ?? [])
      .filter((t) => t.token.startsWith(prefix))
      .map((t) => `${t.value} (${t.token})`)
      .join(', ')
    return list ? `use a ${prefix}-* token from tokens.css: ${list}` : `use a ${prefix}-* token from tokens.css`
  }
  if (dim === 'staticInlineStyles') {
    return 'move to the owning CSS file or declare it in scripts/inline-style-fixtures.json — see ARCHITECTURE.md "Inline Style Boundary (L03)"'
  }
  return ''
}

/**
 * G02 ratchet gate over a scanned tree vs the baseline. Returns
 * { failed, failures, improvements }:
 *  - failures: NEW residual items (radius / motion / static inline styles),
 *    per-key count increases, NEW cross-file duplicate selectors and
 *    maxAdhoc counter increases;
 *  - improvements: baseline items that are gone or shrank (informational).
 */
export function gateCheck(current, baseline, hints) {
  const failures = []
  const improvements = []

  const baselineDups = new Set(baseline.duplicateSelectors ?? [])
  const currentDups = new Set(current.duplicateSelectors)
  for (const d of current.duplicateSelectors) {
    if (!baselineDups.has(d)) failures.push(`duplicate selector without declared owner: ${d} — define it in exactly one stylesheet`)
  }
  for (const d of baseline.duplicateSelectors) {
    if (!currentDups.has(d)) improvements.push(`duplicate selector resolved: ${d}`)
  }

  /* Hard gate (no baseline): a var(--x) reference to a name no stylesheet
   * declares and no JS writes is always a violation — the fallback hides
   * the miss (or invalidates the declaration when there is none). */
  for (const ref of current.undefinedVarRefs ?? []) {
    failures.push(
      `var() references a never-defined custom property: ${ref.file}:${ref.line} var(${ref.name}) — declare ${ref.name} in the owning stylesheet or write it from JS; whitelist via UNDEFINED_VAR_WHITELIST with a reason`,
    )
  }

  const currentOverlaps = current.crossLayerOverlaps ?? []
  const baselineOverlaps = new Set(baseline.crossLayerOverlaps ?? [])
  const trackingOverlaps = baseline.crossLayerOverlaps != null
  if (trackingOverlaps) {
    for (const d of currentOverlaps) {
      if (!baselineOverlaps.has(d)) {
        failures.push(`cross-layer overlap: ${d} — shadowed declaration never wins (higher layer or later same-layer import); delete it or move it to the winning file/layer`)
      }
    }
    for (const d of baseline.crossLayerOverlaps) {
      if (!currentOverlaps.includes(d)) improvements.push(`cross-layer overlap resolved: ${d}`)
    }
  }

  for (const key of Object.keys(current.maxAdhoc)) {
    const before = baseline.maxAdhoc?.[key] ?? 0
    const after = current.maxAdhoc[key]
    if (after > before) {
      failures.push(`maxAdhoc.${key} increased: ${before} -> ${after} — use design tokens (tokens.css) instead of new literals`)
    } else if (after < before) {
      improvements.push(`maxAdhoc.${key} improved: ${before} -> ${after}`)
    }
  }

  for (const dim of RESIDUAL_GATES) {
    const baseCounts = countByKey(baseline.residualReport?.[dim] ?? [], dim)
    const curCounts = countByKey(current.report[dim] ?? [], dim)
    const curByKey = new Map()
    for (const item of current.report[dim] ?? []) {
      const key = dimensionKey(dim, item)
      if (!curByKey.has(key)) curByKey.set(key, item)
    }
    for (const [key, count] of curCounts) {
      const base = baseCounts.get(key) ?? 0
      const item = curByKey.get(key)
      if (base === 0) {
        failures.push(`new ${dim}: ${whereText(dim, item)} ${valueText(dim, item)} — ${suggestionFor(dim, item, hints)}`)
      } else if (count > base) {
        failures.push(`${dim} count increased: ${whereText(dim, item)} ${valueText(dim, item)} — ${base} -> ${count}, existing debt may only shrink`)
      }
    }
    for (const [key, count] of baseCounts) {
      const cur = curCounts.get(key)
      const label = key.replace(/\u0000/g, ' :: ')
      if (cur === undefined) {
        improvements.push(`${dim} resolved: ${label}`)
      } else if (cur < count) {
        improvements.push(`${dim} reduced: ${label} ${count} -> ${cur}`)
      }
    }
  }

  const curForbidden = current.report.forbidden ?? { items: [], counts: {} }
  const baseForbidden = baseline.residualReport?.forbidden
  const baseItems = new Set(baseForbidden?.items ?? [])
  for (const item of curForbidden.items) {
    if (!baseItems.has(item)) {
      const [kind, file, selector] = item.split(' :: ')
      failures.push(`${file} :: ${selector} :: ${kind} — ${FORBIDDEN_HINTS[kind] ?? ''}`)
    }
  }
  for (const item of baseItems) {
    if (!curForbidden.items.includes(item)) improvements.push(`forbidden resolved: ${item}`)
  }
  const baseCountsForbidden = baseForbidden?.counts ?? {}
  for (const kind of FORBIDDEN_KINDS) {
    const before = baseCountsForbidden[kind] ?? 0
    const after = curForbidden.counts?.[kind] ?? 0
    if (after > before) {
      failures.push(`forbidden ${kind} count increased: ${before} -> ${after} — ${FORBIDDEN_HINTS[kind]}`)
    } else if (after < before) {
      improvements.push(`forbidden ${kind} improved: ${before} -> ${after}`)
    }
  }

  return { failed: failures.length > 0, failures, improvements }
}

/** Dimensions whose count would GROW if `current` were written as the new
 * baseline. `--write-baseline` uses this to refuse growing the baseline. */
export function baselineGrowth(current, baseline) {
  const grown = []
  const cmp = (label, cur, base) => {
    if (cur > base) grown.push(`${label}: ${base} -> ${cur}`)
  }
  cmp('duplicateSelectors', current.duplicateSelectors.length, (baseline.duplicateSelectors ?? []).length)
  if (baseline.crossLayerOverlaps) {
    cmp('crossLayerOverlaps', (current.crossLayerOverlaps ?? []).length, baseline.crossLayerOverlaps.length)
  }
  for (const key of Object.keys(current.maxAdhoc)) {
    cmp(`maxAdhoc.${key}`, current.maxAdhoc[key], baseline.maxAdhoc?.[key] ?? 0)
  }
  for (const dim of [...RESIDUAL_GATES, 'colors']) {
    cmp(`residual.${dim}`, (current.report[dim] ?? []).length, (baseline.residualReport?.[dim] ?? []).length)
  }
  const prevForbidden = baseline.residualReport?.forbidden
  if (prevForbidden !== undefined) {
    cmp('residual.forbidden.items', (current.report.forbidden?.items ?? []).length, prevForbidden.items.length)
    for (const kind of FORBIDDEN_KINDS) {
      cmp(`residual.forbidden.counts.${kind}`, current.report.forbidden?.counts?.[kind] ?? 0, prevForbidden.counts?.[kind] ?? 0)
    }
  }
  return grown
}

/* ── CLI ────────────────────────────────────────────────────────────── */
function printGroup(title, items, describe) {
  if (items.length === 0) {
    console.log(`[style-drift]   ─ ${title}: 0`)
    return
  }
  const byFile = new Map()
  for (const item of items) {
    if (!byFile.has(item.file)) byFile.set(item.file, [])
    byFile.get(item.file).push(item)
  }
  console.log(`[style-drift]   ─ ${title}: ${items.length}`)
  for (const [file, list] of [...byFile.entries()].sort()) {
    for (const item of list) console.log(`[style-drift]       ${describe(item)}`)
  }
}

function printResidualReport(report) {
  console.log('[style-drift] ── residual report (G02 — radius/motion/inline are ratchet-gated; colors informational)')
  printGroup('non-token border-radius', report.radius, (i) => {
    const hint = i.kind === 'tokenMatch' ? `  → equals ${i.token}, use var(${i.token})` : '  [drift]'
    return `${i.file}:${i.line} (${i.selector}) ${i.value}${hint}`
  })
  printGroup('literal motion', report.motion, (i) => `${i.file}:${i.line} (${i.selector}) ${i.kind} ${i.value}`)
  printGroup('hardcoded colors (semantic-token match / unknown)', report.colors, (i) => {
    const hint = i.category === 'semanticMatch' ? `  → matches ${i.token}, use var(${i.token})` : '  [unknown]'
    return `${i.file}:${i.line} (${i.selector}) ${i.value}${hint}`
  })
  printGroup('static TSX inline styles', report.staticInlineStyles, (i) => `${i.file}:${i.line} style={{ ${i.style} }}`)
  printGroup('custom-property colors (classified; tokens.css omitted)', report.customPropertyColors ?? [], (i) => {
    return `${i.file}:${i.line} (${i.selector}) ${i.value}  [${i.category}]`
  })
  const forbidden = report.forbidden ?? { items: [], counts: {} }
  console.log(`[style-drift]   ─ forbidden §0.2: ${forbidden.items.length} (${FORBIDDEN_KINDS.map((k) => `${k} ${forbidden.counts?.[k] ?? 0}`).join(', ')})`)
  const w = report.whitelisted
  console.log(
    `[style-drift]   ─ whitelisted: radius 50%: ${w.circle50}, token radius: ${w.radiusToken}, radius neutral: ${w.radiusNeutral}; ` +
      `colors: token defs ${w.tokenDefinition}, dynamic var fallbacks ${w.dynamicFallback}, source accents ${w.sourceAccent}, local-palette ${w.localPalette ?? 0}`,
  )
}

function printDeltas(report, baselineReport) {
  const parts = []
  for (const dim of [...RESIDUAL_GATES, 'colors']) {
    const curCounts = countByKey(report[dim] ?? [], dim)
    const baseCounts = countByKey(baselineReport[dim] ?? [], dim)
    let added = 0
    let resolved = 0
    for (const [key, count] of curCounts) {
      const base = baseCounts.get(key) ?? 0
      if (base === 0) added += count
      else if (count > base) added += count - base
    }
    for (const [key, count] of baseCounts) {
      const cur = curCounts.get(key)
      if (cur === undefined) resolved += count
      else if (cur < count) resolved += count - cur
    }
    parts.push(`${dim} +${added}/-${resolved}`)
  }
  console.log(`[style-drift] residual delta vs baseline (ratchet-gated): ${parts.join(', ')}`)
}

function loadHints(dir) {
  const cssFiles = walk(dir).filter((f) => f.endsWith('.css'))
  const tokensFile = cssFiles.find((f) => relName(dir, f).endsWith('tokens.css'))
  if (!tokensFile) return { radiusTokens: [], motionTokens: [] }
  return buildTokenHints(readFileSync(tokensFile, 'utf8'))
}

function runGate(current, baseline, hints) {
  const gate = gateCheck(current, baseline, hints)
  for (const i of gate.improvements) console.log(`[style-drift] ${i}`)
  for (const f of gate.failures) console.error(`[style-drift] FAIL: ${f}`)
  return gate
}

function main() {
  const args = process.argv.slice(2)

  const scanIdx = args.indexOf('--scan')
  if (scanIdx !== -1) {
    const dir = args[scanIdx + 1]
    if (!dir) {
      console.error('[style-drift] --scan requires a directory argument')
      process.exit(1)
    }
    const report = analyzeDirectory(dir)
    const undefinedVarRefs = collectUndefinedVarRefs(dir)
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({ duplicateSelectors: report.duplicateSelectors, crossLayerOverlaps: report.crossLayerOverlaps, maxAdhoc: report.maxAdhoc, undefinedVarRefs, report: report.report }, null, 2) + '\n')
    } else {
      console.log(`[style-drift] scan of ${dir}: ${report.duplicateSelectors.length} duplicate selectors, ${report.crossLayerOverlaps.length} cross-layer overlaps, ${undefinedVarRefs.length} undefined var() refs, adhoc=${JSON.stringify(report.maxAdhoc)}`)
      printResidualReport(report.report)
    }
    process.exit(0)
  }

  const verifyIdx = args.indexOf('--verify')
  if (verifyIdx !== -1) {
    const dir = args[verifyIdx + 1]
    if (!dir) {
      console.error('[style-drift] --verify requires a directory argument')
      process.exit(1)
    }
    const baseIdx = args.indexOf('--baseline')
    const baselineFile = baseIdx !== -1 ? args[baseIdx + 1] : baselinePath
    if (!existsSync(baselineFile)) {
      console.error(`style-drift baseline missing: ${baselineFile}`)
      process.exit(1)
    }
    const current = analyzeDirectory(dir)
    current.undefinedVarRefs = collectUndefinedVarRefs(dir)
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
    const hints = loadHints(dir)
    printResidualReport(current.report)
    printDeltas(current.report, baseline.residualReport ?? {})
    const gate = runGate(current, baseline, hints)
    if (gate.failed) {
      console.error('\n[style-drift] FAILED — see above. Fix the violations; the baseline may only shrink (--write-baseline refuses to grow it).')
      process.exit(1)
    }
    console.log(`[style-drift] OK — ${current.duplicateSelectors.length} known duplicate selector(s) within baseline, adhoc counters not increased, no new residual drift`)
    process.exit(0)
  }

  const cssReport = analyzeDirectory(stylesDir, { tsx: false })
  const tsxReport = analyzeDirectory(srcDir, { css: false })
  const current = {
    duplicateSelectors: cssReport.duplicateSelectors,
    crossLayerOverlaps: cssReport.crossLayerOverlaps,
    maxAdhoc: cssReport.maxAdhoc,
    undefinedVarRefs: collectUndefinedVarRefs(srcDir),
    report: {
      ...cssReport.report,
      staticInlineStyles: tsxReport.report.staticInlineStyles,
    },
  }

  if (args.includes('--write-baseline')) {
    if (existsSync(baselinePath)) {
      const previous = JSON.parse(readFileSync(baselinePath, 'utf8'))
      const grown = baselineGrowth(current, previous)
      if (grown.length > 0) {
        console.error('[style-drift] refusing to write a LARGER baseline — these dimensions grew:')
        for (const g of grown) console.error(`  + ${g}`)
        console.error('clean up the drift first; the baseline may only shrink or stay flat.')
        process.exit(1)
      }
    }
    const payload = {
      duplicateSelectors: current.duplicateSelectors,
      crossLayerOverlaps: current.crossLayerOverlaps,
      maxAdhoc: current.maxAdhoc,
      residualReport: {
        radius: current.report.radius,
        motion: current.report.motion,
        colors: current.report.colors,
        staticInlineStyles: current.report.staticInlineStyles,
        forbidden: current.report.forbidden,
      },
    }
    writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n')
    console.log(`baseline written: ${current.duplicateSelectors.length} duplicate selectors, ${current.crossLayerOverlaps.length} cross-layer overlaps, adhoc=${JSON.stringify(current.maxAdhoc)}`)
    printResidualReport(current.report)
    process.exit(0)
  }

  if (!existsSync(baselinePath)) {
    console.error(`style-drift baseline missing: ${baselinePath}`)
    console.error('run: node scripts/check-style-drift.mjs --write-baseline')
    process.exit(1)
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const hints = loadHints(stylesDir)
  printResidualReport(current.report)
  printDeltas(current.report, baseline.residualReport ?? {})
  const gate = runGate(current, baseline, hints)

  if (gate.failed) {
    console.error('\n[style-drift] FAILED — see above. Clean up the new drift; the baseline may only shrink (--write-baseline refuses to grow it).')
    process.exit(1)
  }
  console.log(`[style-drift] OK — ${current.duplicateSelectors.length} known duplicate selector(s) within baseline, adhoc counters not increased, no new residual drift. NOTE: passing does not mean zero debt — review the residual report above and scripts/style-drift-baseline.json.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
