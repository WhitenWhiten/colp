#!/usr/bin/env node
/**
 * Homepage entry-chunk gzip budget gate.
 *
 * Reads dist/index.html, finds the module script (prefers assets/index-*.js),
 * gzips that file, and fails if the result exceeds the budget (default 148 KB).
 *
 *   node scripts/check-bundle-budget.mjs
 *   node scripts/check-bundle-budget.mjs --dist ./dist --budget 148000
 */
import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Vite reports kB as 1000-byte units. The contract is gzip ≤ 148 KB:
    R15-27 measured 137.5 KB after its diet, plus 10 KB of headroom. */
export const DEFAULT_ENTRY_GZIP_BUDGET = 148_000
export const DEFAULT_STYLESHEET_GZIP_BUDGET = 50_000

export function entryScriptSrc(html) {
  const tags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1])
  const modules = []
  for (const attrs of tags) {
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) continue
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
    if (src) modules.push(src)
  }
  if (modules.length === 0) {
    throw new Error('dist/index.html has no <script type="module" src="…">')
  }
  return modules.find((src) => /(?:^|\/)index-[^/]+\.js$/i.test(src)) ?? modules[0]
}

export function measureEntryGzip(distDir) {
  const htmlPath = join(distDir, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(`missing ${htmlPath} — run \`npm run build\` first`)
  }
  const src = entryScriptSrc(readFileSync(htmlPath, 'utf8'))
  const file = join(distDir, src.replace(/^\.\//, '').replace(/^\//, ''))
  if (!existsSync(file)) {
    throw new Error(`entry script listed in index.html is missing: ${file}`)
  }
  const raw = readFileSync(file)
  return { src, file, raw: raw.length, gzip: gzipSync(raw).length }
}

export function checkEntryBudget(distDir, budget = DEFAULT_ENTRY_GZIP_BUDGET) {
  const measured = measureEntryGzip(distDir)
  return { ...measured, budget, ok: measured.gzip <= budget }
}

/** Sum every unique stylesheet linked by the entry document, including split CSS. */
export function checkStylesheetBudget(distDir, budget = DEFAULT_STYLESHEET_GZIP_BUDGET) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const sources = new Set()
  for (const tag of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag[1])) continue
    const href = tag[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
      throw new Error('entry stylesheets must be local build artifacts')
    }
    sources.add(href.split(/[?#]/)[0])
  }
  let gzip = 0
  for (const src of sources) {
    gzip += gzipSync(readFileSync(join(distDir, src.replace(/^\.\//, '').replace(/^\//, '')))).length
  }
  return { gzip, budget, ok: gzip <= budget, files: sources.size }
}

/** Stylesheets linked from index.html must be real files: an inlined data:
 *  URI ships the whole sheet inside the HTML on every visit. */
export function inlinedStylesheets(html) {
  return [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => /\bhref\s*=\s*["']data:/i.test(tag))
}

function parseArgs(argv) {
  let distDir = join(webRoot, 'dist')
  let budget = DEFAULT_ENTRY_GZIP_BUDGET
  let cssBudget = DEFAULT_STYLESHEET_GZIP_BUDGET
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dist') {
      distDir = resolve(argv[++i] ?? '')
    } else if (flag === '--budget') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--budget must be a positive number of bytes')
      }
      budget = value
    } else if (flag === '--css-budget') {
      cssBudget = Number(argv[++i])
      if (!Number.isSafeInteger(cssBudget) || cssBudget <= 0) throw new Error('--css-budget must be positive bytes')
    } else if (flag === '--help') {
      process.stdout.write('Usage: node scripts/check-bundle-budget.mjs [--dist dir] [--budget bytes] [--css-budget bytes]\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return { distDir, budget, cssBudget }
}

function main() {
  const { distDir, budget, cssBudget } = parseArgs(process.argv.slice(2))
  const result = checkEntryBudget(distDir, budget)
  const line = `[bundle-budget] entry gzip ${result.gzip} / ${result.budget} bytes (${result.src})`
  if (!result.ok) {
    console.error(`${line} — over budget. Split or shrink the homepage chunk. See docs/PERF-BUDGET.md.`)
    process.exit(1)
  }
  console.log(line)
  const inlined = inlinedStylesheets(readFileSync(join(distDir, 'index.html'), 'utf8'))
  if (inlined.length > 0) {
    console.error(`[bundle-budget] ${inlined.length} stylesheet(s) inlined into index.html as data: URIs — keep build.assetsInlineLimit excluding .css`)
    process.exit(1)
  }
  console.log('[bundle-budget] no stylesheet inlined into index.html')
  const css = checkStylesheetBudget(distDir, cssBudget)
  console.log(`[bundle-budget] entry CSS gzip ${css.gzip} / ${css.budget} bytes (${css.files} files)`)
  if (!css.ok) throw new Error('entry CSS over budget')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (error) {
    console.error(`[bundle-budget] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
