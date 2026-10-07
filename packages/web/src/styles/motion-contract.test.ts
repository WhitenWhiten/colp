/**
 * M03 — Motion contract for every stylesheet under src/styles.
 *
 * Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the JS half of the exit-animation lockstep. `useExitAnimation`
 *    exports the durations it hands to `window.setTimeout`, and those are the
 *    real runtime values, so the comparison against the CSS tier is made from
 *    the module, not from a regex over its text.
 *
 * 2. Architecture — the CSS half. Stylesheets are never executed by vitest
 *    (no layout engine, no cascade resolution in happy-dom), so "every
 *    stylesheet uses only semantic motion tokens", "one motion owner per
 *    selector", "the reduced-motion sheet is instantiated exactly here" and
 *    "an animated element is never parked at opacity 0 outside
 *    no-preference" are static properties of the sources. They are kept in a
 *    separate describe and each one names what it protects.
 *
 * Enforces:
 *  1. tokens.css defines the semantic motion vocabulary
 *     (--duration-fast/state/spatial/enter/loop/ambient + --ease-out/quart/spring).
 *  2. Every CSS file except tokens.css uses ONLY those tokens for
 *     transition/animation durations, delays and easings. Any literal is
 *     an error unless it carries a `motion-exempt:` comment:
 *       - immediately before the rule, or
 *       - anywhere in the file for `animation-delay` on `:nth-child`
 *         rules (stagger cascades are inherently incremental).
 *  3. The legacy aliases --duration / --duration-slow are not used.
 *  4. No selector declares `transition`/`animation` in BOTH motion files
 *     (interactions.css vs polish.css — single owner per selector).
 *  5. Reduced-motion contract lives in polish.css (global instantiation)
 *     plus interactions.css (hover/press suppression). Other files must
 *     not copy the global reduced-motion sheet unless their animation
 *     escapes `html *`.
 *  6. Any rule that parks an element at `opacity: 0` with an animation
 *     must live inside `@media (prefers-reduced-motion: no-preference)`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT_DURATION_FAST_MS, EXIT_DURATION_MS } from '../lib/useExitAnimation'

// NOTE: `?raw` imports of CSS return empty strings in this vitest setup
// (the CSS pipeline intercepts them), so the sources are read from disk.
// `resolve(import.meta.dirname, …)` rather than `new URL(…, import.meta.url)`:
// the URL form is node-env only and throws under happy-dom.
const read = (file: string) => readFileSync(resolve(import.meta.dirname, file), 'utf8')
const tokensSource = read('tokens.css')
const interactionsSource = read('interactions.css')
const polishSource = read('polish.css')
const cssFiles = readdirSync(resolve(import.meta.dirname)).filter((f) => f.endsWith('.css'))
const stylesheetSources = Object.fromEntries(cssFiles.map((f) => [f, read(f)]))

const DURATION_TOKENS = [
  '--duration-fast',
  '--duration-state',
  '--duration-spatial',
  '--duration-enter',
  '--duration-loop',
  '--duration-ambient',
]
const EASING_TOKENS = ['--ease-out', '--ease-quart', '--ease-spring']
const MOTION_PROPS = new Set(['transition', 'transition-duration', 'animation', 'animation-duration'])

/* ── tiny CSS scanner ─────────────────────────────────────────────────── */

interface CssRule {
  selector: string
  container: string
  precedingComment: string
  body: string
}

/** Split a stylesheet into [text, comment, text, …] tokens. */
function tokenize(source: string): { text: string; comment: string }[] {
  const parts = source.split(/(\/\*[\s\S]*?\*\/)/)
  const tokens: { text: string; comment: string }[] = []
  for (const part of parts) {
    if (part.startsWith('/*')) tokens.push({ text: '', comment: part })
    else if (part) tokens.push({ text: part, comment: '' })
  }
  return tokens
}

/** Walk the token stream and collect plain CSS rules (inside at-rules). */
function parseRules(source: string): CssRule[] {
  type Frame = { kind: 'at' | 'rule'; header: string; body: string; comment: string }
  const stack: Frame[] = []
  const rules: CssRule[] = []
  let lastComment = ''
  for (const token of tokenize(source)) {
    if (token.comment) {
      lastComment = token.comment
      continue
    }
    let buf = ''
    for (const ch of token.text) {
      if (ch === '{') {
        const header = buf.trim()
        buf = ''
        stack.push({ kind: header.startsWith('@') ? 'at' : 'rule', header, body: '', comment: lastComment })
      } else if (ch === '}') {
        const frame = stack.pop()
        if (!frame) continue
        if (frame.kind === 'rule') {
          const container = stack
            .filter((f) => f.kind === 'at')
            .map((f) => f.header)
            .join(' | ')
          rules.push({ selector: frame.header, container, precedingComment: frame.comment, body: frame.body })
        }
      } else if (ch === ';') {
        if (stack.length && stack[stack.length - 1]!.kind === 'rule') {
          stack[stack.length - 1]!.body += ';'
        }
        buf = ''
      } else if (stack.length) {
        stack[stack.length - 1]!.body += ch
        buf += ch
      } else {
        buf += ch
      }
    }
  }
  return rules
}

/** Split a rule body into `prop: value` declarations. */
function parseDeclarations(body: string): { prop: string; value: string }[] {
  const decls: { prop: string; value: string }[] = []
  for (const raw of body.split(';')) {
    const idx = raw.indexOf(':')
    if (idx < 0) continue
    decls.push({ prop: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() })
  }
  return decls
}

function splitSelectors(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth += 1
    if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim().replace(/\s+/g, ' '))
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim().replace(/\s+/g, ' '))
  return parts
}

const VAR_RE = /var\(--[a-z0-9-]+(?:,[^)]*)?\)/g
const DURATION_LITERAL_RE = /\d+(?:\.\d+)?(?:ms|s)\b/g
const EASING_LITERAL_RE = /\b(?:linear|ease|ease-in|ease-in-out|ease-out|steps|step-start|step-end|cubic-bezier)\b/g

function isExempt(rule: CssRule, prop: string, source: string): boolean {
  if (rule.precedingComment.includes('motion-exempt')) return true
  // Stagger cascades: incremental nth-child delays carry a file-level marker.
  if (prop === 'animation-delay' && rule.selector.includes(':nth-child')) {
    return source.includes('motion-exempt: stagger cascade')
  }
  return false
}

/** Collect every motion declaration that violates the vocabulary. */
function violations(source: string, file: string): string[] {
  const out: string[] = []
  for (const rule of parseRules(source)) {
    if (rule.container.includes('@keyframes')) continue
    for (const decl of parseDeclarations(rule.body)) {
      if (!MOTION_PROPS.has(decl.prop) && decl.prop !== 'animation-delay' && decl.prop !== 'transition-delay') continue
      if (isExempt(rule, decl.prop, source)) continue
      const clean = decl.value.replace(VAR_RE, '')
      for (const m of clean.match(DURATION_LITERAL_RE) ?? []) {
        out.push(`${file}: ${rule.selector} — ${decl.prop} has literal duration "${m}" (${decl.value})`)
      }
      for (const m of clean.match(EASING_LITERAL_RE) ?? []) {
        out.push(`${file}: ${rule.selector} — ${decl.prop} has literal easing "${m}" (${decl.value})`)
      }
      const tokens = decl.value.match(/var\((--[a-z0-9-]+)\)/g) ?? []
      for (const t of tokens) {
        const name = t.slice(4, -1)
        if (![...DURATION_TOKENS, ...EASING_TOKENS].includes(name)) {
          out.push(`${file}: ${rule.selector} — ${decl.prop} uses unknown motion token ${t}`)
        }
      }
    }
  }
  return out
}

function tokenValue(source: string, name: string): string | null {
  const m = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  return m ? m[1]!.trim() : null
}

describe('motion exit behaviour', () => {
  it('keeps the JS exit durations in lockstep with the CSS tokens', () => {
    /* The JS half is read from the module, not from its text: `useExitAnimation`
       unmounts closing surfaces on a JS timer while `.is-closing` CSS plays on
       --duration-state/--duration-fast. The two clocks live in different files
       and the JS side is a real runtime export, so this half fails on a value
       change regardless of how the constant is spelled or reordered.
       (The CSS half has to stay textual — vitest never resolves a stylesheet —
       so the token values are read out of tokens.css above.) */
    expect(EXIT_DURATION_MS, 'EXIT_DURATION_MS must equal --duration-state').toBe(
      Number.parseFloat(tokenValue(tokensSource, '--duration-state') ?? ''),
    )
    expect(EXIT_DURATION_FAST_MS, 'EXIT_DURATION_FAST_MS must equal --duration-fast').toBe(
      Number.parseFloat(tokenValue(tokensSource, '--duration-fast') ?? ''),
    )
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  /* Every test below reads a stylesheet as text. That is unavoidable rather
     than lazy: vitest has no CSS pipeline and happy-dom does not resolve the
     cascade, so "which declarations exist in which file" is not observable by
     running any code. Each test says what it protects. */
  it('defines the semantic motion vocabulary in tokens.css', () => {
    /* The vocabulary itself is the contract: consumers outside CSS (the
       useExitAnimation constants proven behaviourally above) are calibrated to
       these exact millisecond values, and a token silently retuned to a
       different number changes every animation at once with no renderable
       symptom. */
    const expected: Record<string, string> = {
      '--duration-fast': '120ms',
      '--duration-state': '180ms',
      '--duration-spatial': '320ms',
      '--duration-enter': '400ms',
      '--duration-loop': '1.2s',
      '--duration-ambient': '3s',
    }
    for (const [token, value] of Object.entries(expected)) {
      expect(tokenValue(tokensSource, token), `${token} must be defined`).toBe(value)
    }
    for (const token of EASING_TOKENS) {
      expect(tokenValue(tokensSource, token), `${token} must be defined`).toMatch(/cubic-bezier/)
    }
    // The legacy --duration / --duration-slow aliases were removed; nothing
    // may reintroduce them (see the alias test below).
    expect(tokenValue(tokensSource, 'duration')).toBeNull()
    expect(tokenValue(tokensSource, 'duration-slow')).toBeNull()
  })

  it('uses only semantic tokens for motion in every stylesheet except tokens.css', () => {
    /* Protects the motion vocabulary from erosion: a literal `200ms` or `ease`
       reaching a sheet today animates identically to the token it replaces, so
       nothing rendered can tell them apart — the drift only surfaces later,
       when retuning the token leaves that one rule behind. */
    const found: string[] = []
    for (const [file, source] of Object.entries(stylesheetSources)) {
      if (file === 'tokens.css') continue
      found.push(...violations(source, file))
    }
    expect(found).toEqual([])
  })

  it('does not use the legacy duration aliases outside tokens.css', () => {
    /* R8-07 removed --duration/--duration-slow. An undefined `var(--duration)`
       makes the declaration invalid at computed-value time, which happy-dom
       does not implement, so a reintroduced alias renders "fine" in every test
       and loses its transition in a browser. */
    for (const [file, source] of Object.entries(stylesheetSources)) {
      if (file === 'tokens.css') continue
      const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(clean, file).not.toMatch(/var\(--duration\)/)
      expect(clean, file).not.toMatch(/var\(--duration-slow\)/)
    }
  })

  it('declares transition/animation for one selector in at most one motion file', () => {
    /* Single-owner rule: when interactions.css and polish.css both animate one
       selector, the winner depends on stylesheet import order, so the loser is
       silently dead code. Which file "wins" is not observable from the DOM. */
    const owners = new Map<string, string[]>()
    for (const [file, source] of [
      ['interactions.css', interactionsSource],
      ['polish.css', polishSource],
    ] as const) {
      for (const rule of parseRules(source)) {
        if (rule.container.includes('@keyframes')) continue
        const hasMotion = parseDeclarations(rule.body).some((d) => MOTION_PROPS.has(d.prop))
        if (!hasMotion) continue
        for (const sel of splitSelectors(rule.selector)) {
          if (!owners.has(sel)) owners.set(sel, [])
          if (!owners.get(sel)!.includes(file)) owners.get(sel)!.push(file)
        }
      }
    }
    const duplicated = [...owners.entries()].filter(([, files]) => files.length > 1)
    expect(duplicated).toEqual([])
  })

  it('never parks an animated element at opacity 0 outside no-preference', () => {
    /* If the keyframe animation is suppressed (reduced motion, or a browser
       that never applies it) an `opacity: 0` outside a no-preference guard
       leaves the content permanently invisible. The failure mode needs a real
       media-query evaluation, which jsdom/happy-dom do not perform. */
    for (const [file, source] of [
      ['interactions.css', interactionsSource],
      ['polish.css', polishSource],
    ] as const) {
      for (const rule of parseRules(source)) {
        if (rule.container.includes('@keyframes')) continue
        const decls = parseDeclarations(rule.body)
        const parked = decls.some((d) => d.prop === 'opacity' && /^0(?!\.)/.test(d.value))
        const animated = decls.some((d) => d.prop === 'animation' || d.prop === 'animation-duration')
        if (parked && animated) {
          expect(rule.container, `${file}: ${rule.selector} parks at opacity 0 outside no-preference`).toContain(
            'no-preference',
          )
        }
      }
    }
  })

  it('enforces the reduced-motion contract', () => {
    /* The reduced-motion sheet must exist exactly once, must actually zero the
       durations with `!important`, and must not be countered by a later
       hover/press transform. `matchMedia('(prefers-reduced-motion: reduce)')`
       in happy-dom is a stub, so no render can exercise this branch. */
    // polish.css — single owner: instant completion, zeroed delays,
    // instant transitions, no hover lift, loop kills.
    expect(polishSource).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    const reduceBlock = polishSource.slice(polishSource.indexOf('@media (prefers-reduced-motion: reduce)'))
    // R15-38: no element is exempt, the Landing caret included.
    expect(reduceBlock).toMatch(/html \*,\s*html \*::before,\s*html \*::after/)
    expect(polishSource).not.toMatch(/:not\(\.typewriter-cursor\)/)
    expect(reduceBlock).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(reduceBlock).toMatch(/animation-delay:\s*0ms\s*!important/)
    expect(reduceBlock).toMatch(/animation-iteration-count:\s*1\s*!important/)
    expect(reduceBlock).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
    expect(reduceBlock).toMatch(/scroll-behavior:\s*auto\s*!important/)
    expect(reduceBlock).toMatch(/::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*animation:\s*none\s*!important;/)

    // interactions.css — hover/press transforms suppressed next to their owners.
    // The opt-in .panel--interactive lift hook was removed as dead code (R8-07)
    // and must not return; static .panel never translates on hover.
    const interactionsLive = interactionsSource.slice(0, interactionsSource.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(interactionsLive).not.toMatch(/\.panel--interactive/)
    expect(interactionsLive).not.toMatch(/\.panel:hover/)
    const interactionsReduce = interactionsSource.slice(interactionsSource.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(interactionsReduce).toMatch(/\.btn-primary:hover[^}]*transform:\s*none;/)
    expect(interactionsReduce).not.toMatch(/\.panel--interactive/)
    expect(interactionsReduce).not.toMatch(/\.panel:hover/)
    expect(interactionsReduce).not.toMatch(/\.typewriter-cursor[^{]*\{[^}]*animation:\s*none/)
    expect(interactionsSource).toMatch(/\.typewriter-cursor\s*\{[^}]*animation:\s*cursor-blink[^;]*infinite/)
  })

  it('keeps the JS duration table in lockstep with the CSS tokens', () => {
    // JS clocks (exit unmount timers, status flashes) read lib/durations.ts
    // while CSS plays on --duration-*. The two clocks live in different
    // files; retuning a token must fail here instead of silently truncating
    // (or stalling) every animation synced to it.
    const durationsSource = read('../lib/durations.ts')
    const tokenMs = (token: string) => {
      const raw = tokenValue(tokensSource, token) ?? ''
      const value = Number.parseFloat(raw)
      return raw.endsWith('ms') ? value : value * 1000
    }
    for (const [jsName, token] of [
      ['DURATION_FAST_MS', '--duration-fast'],
      ['DURATION_STATE_MS', '--duration-state'],
      ['DURATION_SPATIAL_MS', '--duration-spatial'],
      ['DURATION_ENTER_MS', '--duration-enter'],
      ['DURATION_LOOP_MS', '--duration-loop'],
      ['DURATION_AMBIENT_MS', '--duration-ambient'],
    ] as const) {
      const declared = durationsSource.match(new RegExp(`${jsName} = (\\d+)`))
      expect(Number(declared?.[1]), `${jsName} must equal ${token}`).toBe(tokenMs(token))
    }
    // The exit aliases must ride the table, not restate the numbers.
    const hookSource = read('../lib/useExitAnimation.ts')
    expect(hookSource, 'EXIT_DURATION_MS must alias DURATION_STATE_MS').toMatch(
      /EXIT_DURATION_MS = DURATION_STATE_MS/,
    )
    expect(hookSource, 'EXIT_DURATION_FAST_MS must alias DURATION_FAST_MS').toMatch(
      /EXIT_DURATION_FAST_MS = DURATION_FAST_MS/,
    )
  })

  it('documents every motion-exempt marker with a reason', () => {
    /* `motion-exempt:` is the only escape hatch from the token scan above; an
       unexplained marker is indistinguishable from a real violation that was
       silenced, and nothing at runtime records why the literal is allowed. */
    for (const [file, source] of Object.entries(stylesheetSources)) {
      const markers = source.match(/motion-exempt:([^*]*)\*\//g) ?? []
      for (const marker of markers) {
        const reason = marker.replace(/^motion-exempt:/, '').replace(/\*\/$/, '').trim()
        expect(reason.length, `${file} marker without a reason: ${marker}`).toBeGreaterThan(0)
      }
    }
  })
})
