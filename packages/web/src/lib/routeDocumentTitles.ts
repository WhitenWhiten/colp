import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/**
 * Static checks that every App.tsx route page sets a tab title.
 * Used by route-document-title.contract.test.ts — keep this module test-only
 * in spirit: no runtime import from pages.
 */

const SKIP_ROUTE_ELEMENTS = new Set(['Navigate', 'Layout', 'SettingsRedirect'])

export function pageModulesImportedFromApp(source: string): string[] {
  const files = new Set<string>()
  for (const match of source.matchAll(/(?:from\s+|import\(\s*)['"]\.\/pages\/([^'"]+)['"]/g)) {
    const spec = match[1]
    if (spec) files.add(spec)
  }
  return [...files].sort()
}

/** Local binding → `pages/` specifier (no extension). */
export function routeElementPageModules(source: string): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const match of source.matchAll(/import\s+\{\s*(\w+)\s*\}\s+from\s+['"]\.\/pages\/([^'"]+)['"]/g)) {
    const name = match[1]
    const spec = match[2]
    if (name && spec) bindings.set(name, spec)
  }
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*(?:\w+\s*\?\s*)?lazy(?:WithRetry)?\([\s\S]*?import\(\s*['"]\.\/pages\/([^'"]+)['"]/g)) {
    const name = match[1]
    const spec = match[2]
    if (name && spec) bindings.set(name, spec)
  }
  return bindings
}

export function routedPageModules(source: string): string[] {
  const bindings = routeElementPageModules(source)
  const specs = new Set<string>()
  const unknown: string[] = []
  for (const match of source.matchAll(/element=\{<(\w+)/g)) {
    const name = match[1]
    if (!name || SKIP_ROUTE_ELEMENTS.has(name)) continue
    const spec = bindings.get(name)
    if (!spec) {
      unknown.push(name)
      continue
    }
    specs.add(spec)
  }
  if (unknown.length > 0) {
    throw new Error(
      `App.tsx routes <${unknown.join('>, <')}> but those names are not imported from ./pages/. `
      + 'Redirects must use Navigate; chrome must stay in Layout.',
    )
  }
  return [...specs].sort()
}

/** True when the page module itself sets the tab title (not merely importing PageHead). */
export function pageSetsDocumentTitle(source: string): boolean {
  return /\buseDocumentTitle\s*\(/.test(source) || /\bdocumentTitle\s*=/.test(source)
}

/**
 * Concatenate the route module with its colocated submodule tree
 * (pages/<kebab-name>/**\/*.ts(x)). Split pages keep the title hook in a
 * view/state module — the guarantee is about the reachable surface, not the
 * root file's text (mirrors the page-head-adoption contract's walk).
 */
export function reachablePageSurface(pageFile: string): string {
  const parts = [readFileSync(pageFile, 'utf8')]
  const dir = join(dirname(pageFile), pageFile.replace(/\.tsx?$/, '').split(sep).pop()!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^-/, ''))
  if (existsSync(dir)) {
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name.includes('.test.') || entry.name.includes('.test-')) continue
        const p = join(d, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(entry.name)) parts.push(readFileSync(p, 'utf8'))
      }
    }
    walk(dir)
  }
  return parts.join('\n')
}
