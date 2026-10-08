import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'

/**
 * RP3-claude-04: product pages with an editorial page head must use PageHead.
 * Auth / landing / share heroes stay on the allowlist — do not pin those
 * surfaces to PageHead.
 *
 * The owner may live in a colocated view module (e.g. library-desk/view.tsx)
 * imported by the route file. Do not require a dummy import on the
 * composition root.
 */

const pagesDir = resolve(import.meta.dirname)

/** Route modules whose reachable page surface must import PageHead. */
const MUST_USE_PAGEHEAD = ['library-desk/LibraryDesk.tsx', 'WriteApprovals.tsx', 'Reader.tsx'] as const

/**
 * Files that still ship a display h1 without PageHead. Auth/onboarding stay
 * on auth.css; Landing/Share are true heroes (R10-03: shrink-only to this
 * set). A new page that wants a display h1 must adopt PageHead instead of
 * joining this list.
 */
const INTENTIONAL_H1_DISPLAY_WITHOUT_PAGEHEAD = [
  'AuthRecovery.tsx',
  'EmailVerification.tsx',
  'Landing.tsx',
  'Login.tsx',
  'Onboarding.tsx',
  'PasswordReset.tsx',
  'Register.tsx',
  'Share.tsx',
] as const

function pageFiles(): string[] {
  return readdirSync(pagesDir).filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
}

/** PageHead import from any depth under pages/ (`../` or `../../`). */
function importsPageHead(source: string): boolean {
  return /from\s+['"](?:\.\.\/)+components\/PageHead['"]/.test(source)
}

function isUnderPages(file: string): boolean {
  const rel = relative(pagesDir, file)
  return rel !== '' && !rel.startsWith('..')
}

function resolveLocalImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && isUnderPages(candidate)) return candidate
  }
  return null
}

/** Concatenate the route module and every relative import that stays under pages/. */
function reachablePageSurface(entryName: string): string {
  const entry = resolve(pagesDir, entryName)
  const seen = new Set<string>()
  const queue = [entry]
  const parts: string[] = []
  while (queue.length > 0) {
    const file = queue.shift()
    if (!file || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    parts.push(source)
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const next = resolveLocalImport(file, match[1] ?? '')
      if (next) queue.push(next)
    }
  }
  return parts.join('\n')
}

/** Hand-rolled page title using the editorial display scale (not section h2). */
function hasHandRolledDisplayH1(source: string): boolean {
  return /<h1\b[\s\S]*?\bdisplay\b/.test(source)
}

describe('PageHead adoption (RP3-claude-04)', () => {
  it('requires Library, WriteApprovals, and Reader surfaces to import PageHead', () => {
    for (const name of MUST_USE_PAGEHEAD) {
      const source = reachablePageSurface(name)
      expect(importsPageHead(source), `${name} surface must import PageHead`).toBe(true)
    }
    const libraryRoot = readFileSync(resolve(pagesDir, 'library-desk/LibraryDesk.tsx'), 'utf8')
    expect(
      importsPageHead(libraryRoot),
      'do not add a dummy PageHead import to the LibraryDesk composition root',
    ).toBe(false)
  })

  it('does not pin auth or landing heroes to PageHead', () => {
    for (const name of ['Login.tsx', 'Register.tsx', 'Landing.tsx', 'Onboarding.tsx']) {
      const source = readFileSync(resolve(pagesDir, name), 'utf8')
      expect(importsPageHead(source), `${name} must stay off PageHead`).toBe(false)
    }
  })

  it('allows only listed chrome to keep a hand-rolled display h1', () => {
    const allow = new Set<string>(INTENTIONAL_H1_DISPLAY_WITHOUT_PAGEHEAD)
    const unexpected: string[] = []
    for (const name of pageFiles()) {
      if (allow.has(name)) continue
      const source = readFileSync(resolve(pagesDir, name), 'utf8')
      if (importsPageHead(source)) continue
      if (hasHandRolledDisplayH1(source)) unexpected.push(name)
    }
    expect(unexpected, 'migrate the editorial head to PageHead or add to the chrome allowlist').toEqual([])
  })

  it('does not clamp editorial page-head ledes at 639px', () => {
    const ledeClamps = collectLayeredRules(readStyle('page-chrome.css')).filter(
      (rule) =>
        rule.media?.max === 639 &&
        /\.lede\b/.test(rule.selector) &&
        /-webkit-line-clamp\s*:\s*(?!none)\d+/.test(rule.body),
    )
    expect(ledeClamps.length, 'split heads keep the two-line first-screen lede').toBeGreaterThan(0)
    for (const rule of ledeClamps) {
      expect(rule.selector, 'the 639px lede clamp must not match .page-head--editorial .lede').toMatch(
        /page-head--split/,
      )
      expect(rule.selector).not.toBe('.page-head .lede')
    }
  })
})
