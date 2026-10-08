import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESK_WIDGET_STYLESHEETS } from './dashboard-stack-cascade.test-helper'

/**
 * F00 cascade-layer contract.
 *
 * Asserts the stable layer order, the explicit token entry, the file → layer
 * owner map and the reserved page-layouts file. If this test fails, the CSS
 * cascade priority silently changed — do not edit the test to match a reorder;
 * re-run the cross-file duplicate-selector audit instead.
 */

const stylesDir = resolve(import.meta.dirname)
const entryPath = resolve(import.meta.dirname, '../main.tsx')

/** Stable layer order, declared once at the top of tokens.css. */
const LAYER_ORDER = ['tokens', 'base', 'components', 'pages', 'patterns', 'utilities', 'print']

/** File → layer owner(s) (mirrors ARCHITECTURE.md). Most files own exactly
 *  one layer; search.css carries the ⌘K palette (components) and the search
 *  product page (pages) as two sibling top-level @layer blocks. */
const OWNER_MAP: Record<string, string | string[]> = {
  'tokens.css': 'tokens',
  'global.css': 'base',
  'nav.css': 'base',
  'skeleton.css': 'base',
  'page-chrome.css': 'base',
  'overlays.css': 'base',
  'shared-chrome.css': 'base',
  'landing.css': 'pages',
  'explore.css': 'pages',
  'collection.css': 'pages',
  'profile.css': 'pages',
  'dashboard.css': 'pages',
  'graph.css': 'pages',
  'sync.css': 'pages',
  'write-approvals.css': 'pages',
  'agents.css': 'pages',
  'classify.css': 'pages',
  'classification-settings.css': 'pages',
  'classification-batch.css': 'pages',
  'extension.css': 'pages',
  'pages-shared.css': 'pages',
  'library.css': 'pages',
  'workbench-chrome.css': 'pages',
  'auth.css': 'pages',
  'auth-pages.css': 'pages',
  'studio.css': 'pages',
  'share.css': 'pages',
  'demos.css': 'pages',
  'today.css': 'pages',
  'collection-history.css': 'pages',
  'reader.css': 'pages',
  'resource-detail.css': 'pages',
  'path-reader.css': 'pages',
  'library-health.css': 'pages',
  'moderation.css': 'pages',
  'credits.css': 'pages',
  'data-export.css': 'pages',
  'import.css': 'pages',
  'saved-resources.css': 'pages',
  'not-found.css': 'pages',
  'reports.css': 'pages',
  'collab.css': 'pages',
  'digest-manage.css': 'pages',
  'page-layouts.css': 'pages',
  'polish.css': 'patterns',
  'search.css': ['components', 'pages'],
  'interactions.css': 'patterns',
  'cards.css': 'components',
  'source-skins.css': 'components',
  'capture.css': 'components',
  'cards-ui.css': 'components',
  'data-table.css': 'components',
  'stepper.css': 'components',
  'reading.css': 'components',
  'desk-themes.css': 'components',
  'dashboard-desk.css': 'components',
  ...Object.fromEntries(DESK_WIDGET_STYLESHEETS.map((file) => [file, 'components'])),
  'canvas-background.css': 'components',
  'utilities.css': 'utilities',
  'print.css': 'print',
}

/** Import order expected in main.tsx (source order inside each layer). */
const EXPECTED_ENTRY_IMPORTS = [
  './styles/tokens.css',
  './styles/global.css',
  './styles/nav.css',
  './styles/skeleton.css',
  './styles/page-chrome.css',
  './styles/overlays.css',
  './styles/shared-chrome.css',
  './styles/cards.css',
  './styles/source-skins.css',
  './styles/capture.css',
  './styles/landing.css',
  './styles/explore.css',
  './styles/collection.css',
  './styles/pages-shared.css',
  './styles/workbench-chrome.css',
  './styles/auth.css',
  './styles/polish.css',
  './styles/search.css',
  './styles/studio.css',
  './styles/cards-ui.css',
  './styles/data-table.css',
  './styles/stepper.css',
  './styles/reading.css',
  './styles/page-layouts.css',
  './styles/interactions.css',
  './styles/utilities.css',
]

/** Route-owned stylesheets: imported by exactly one lazy page module (relative
 *  to src/pages) so they ship in that route's chunk. Order inside a page is
 *  the cascade order within the shared layer. */
const ROUTE_STYLESHEETS: Record<string, string[]> = {
  'Profile.tsx': ['profile.css'],
  'Graph.tsx': ['graph.css'],
  'Sync.tsx': ['sync.css'],
  'WriteApprovals.tsx': ['write-approvals.css'],
  'Agents.tsx': ['agents.css'],
  'Classify.tsx': ['classify.css'],
  'ClassificationBatch.tsx': ['classification-batch.css'],
  'library-desk/CollectionSettingsSheet.tsx': ['classification-settings.css'],
  'DemoHub.tsx': ['demos.css'],
  'Dashboard.tsx': [
    'dashboard.css',
    'desk-themes.css',
    'dashboard-desk.css',
    ...DESK_WIDGET_STYLESHEETS,
    'canvas-background.css',
  ],
  // Former loops.css, split per route so each chunk carries only its own rules.
  'Reader.tsx': ['reader.css'],
  'PathReader.tsx': ['path-reader.css'],
  'Today.tsx': ['today.css'],
  'LibraryHealth.tsx': ['library-health.css'],
  'Credits.tsx': ['credits.css'],
  'DataExport.tsx': ['data-export.css'],
  'CollectionHistory.tsx': ['collection-history.css'],
  'Import.tsx': ['import.css'],
  'Library.tsx': ['saved-resources.css'],
  // Resource detail chapter split out of the entry-loaded studio.css.
  'ResourceDetail.tsx': ['resource-detail.css'],
}

/** Shared route stylesheets: one file imported by several lazy page modules
 *  (Vite emits a single shared CSS chunk). Every listed page must import it,
 *  nothing outside the list may, and it must stay out of the entry. */
const SHARED_ROUTE_STYLESHEETS: Record<string, string[]> = {
  // Collection and Digest reuse the embed card and appearance composer.
  'share.css': ['Share.tsx', 'Collection.tsx', 'ReportSeries.tsx', 'ReportIssue.tsx'],
  // Extension product page + the popup preview: .benefit-list / .extension-*
  // sections live next to the ext-popup-* chrome so both routes share them.
  'extension.css': ['Extension.tsx', 'ExtensionPopup.tsx'],
  // Digest nameplate / masthead / archive chrome shared by the /reports
  // pages, the Explore digests rail, and the member digest reader (which
  // renders the same .digest-entry-*/.report-* rows).
  'reports.css': ['Reports.tsx', 'ReportSeries.tsx', 'ReportIssue.tsx', 'Explore.tsx', 'MemberDigestReader.tsx'],
  // Library domain (R9-04 split): the product desk, the demo stack at
  // /demo/library, the public collection page, and the digest issue reader —
  // both render the .library-bookmark*/.library-folder-*/.library-dest-* rows
  // through components/ResourceList, FolderEntries and
  // CollectionDestinationPicker.
  // DigestManage reuses the picker to attach a collection as an issue.
  // Cross-route workbench selectors (.tree-*, .edit-*, .toggle*,
  // .node-drawer-annotation*) are NOT here — they are entry-loaded in
  // workbench-chrome.css because the settings dialog and
  // NodeAnnotationFields mount them outside these routes.
  // Classify reuses the picker as the manual folder destination.
  'library.css': ['Library.tsx', 'LegacyLibrary.tsx', 'Collection.tsx', 'DigestManage.tsx', 'Classify.tsx'],
  // Moderation lists (components/ModerationTable): the member and the
  // official reviewer pages share one row anatomy.
  'moderation.css': ['ModerationReports.tsx', 'ModerationAppeals.tsx', 'admin/ModerationCases.tsx', 'admin/ModerationAppeals.tsx'],
  // Auth page chrome (R9-33): the seven lazy auth routes. The shared
  // .auth-card/.auth-notice/.auth-alert/.auth-action-row/.auth-cta-stack/
  // .auth-otp-row/.auth-otp-send/.security-* rules stay entry-loaded in
  // auth.css — the settings dialog's account-security sections
  // (components/auth/*) mount them on any route.
  'auth-pages.css': [
    'Login.tsx',
    'Register.tsx',
    'PasswordReset.tsx',
    'EmailVerification.tsx',
    'AuthRecovery.tsx',
    'Consent.tsx',
    'Onboarding.tsx',
    'SelfHostedLogin.tsx',
    'SelfHostedRegister.tsx',
  ],
  // Collaboration + update review (.collab-*), notification list (.notif-*)
  // and the editor inspector's publication block (.publication-*). Digest
  // manage reuses the members table (.collab-invite / .collab-member*).
  'collab.css': ['Collaborators.tsx', 'Notifications.tsx', 'library-desk/CollectionSettingsSheet.tsx', 'DigestManage.tsx'],
  // Curator digest management (R10-05/36): the Mine board and the
  // per-series manage workbench share the digest-*/my-digest-* rules.
  'digest-manage.css': ['MyDigests.tsx', 'DigestManage.tsx'],
  // Absence poster (404 digits + unavailable subjects). Loaded by each route
  // that paints the stage, not by the entry.
  'not-found.css': [
    'NotFound.tsx',
    'Collection.tsx',
    'Graph.tsx',
    'PathReader.tsx',
    'Share.tsx',
    'Profile.tsx',
    'ReportSeries.tsx',
    'ReportIssue.tsx',
    'Reader.tsx',
    'ResourceDetail.tsx',
    'CommunityCommentRedirect.tsx',
    'DigestManage.tsx',
  ],
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Layer name of the first top-level @layer block of a stylesheet. */
function firstLayerName(source: string): string | null {
  // Skip a leading `@layer a, b, …;` statement (tokens.css declares the order
  // before its own block).
  let text = stripComments(source).trimStart()
  text = text.replace(/^@layer\s+[\w-]+(?:\s*,\s*[\w-]+)*;\s*/, '')
  const match = text.match(/^@layer\s+([\w-]+)\s*\{/)
  return match ? match[1]! : null
}

describe('CSS cascade layer contract (F00)', () => {
  it('declares the stable layer order at the top of tokens.css', () => {
    const tokens = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')
    const statement = `@layer ${LAYER_ORDER.join(', ')};`
    // The statement must be the first rule of the entry's first stylesheet.
    expect(stripComments(tokens).trimStart().startsWith(statement)).toBe(true)
    expect(stripComments(tokens).match(/@layer/g)).toHaveLength(2) // statement + block
  })

  it('loads tokens.css explicitly from the entry, before global.css', () => {
    const entry = readFileSync(entryPath, 'utf8')
    const imports = [...entry.matchAll(/^import\s+['"](\.\/styles\/[^'"]+\.css)['"]/gmu)].map((m) => m[1])
    expect(imports).toEqual(EXPECTED_ENTRY_IMPORTS)
    // Explicit token entry: first import is tokens.css; global.css no longer
    // carries the implicit `@import './tokens.css'`.
    expect(imports[0]).toBe('./styles/tokens.css')
    expect(imports[1]).toBe('./styles/global.css')
    expect(imports).not.toContain('./styles/print.css')
    const global = readFileSync(resolve(stylesDir, 'global.css'), 'utf8')
    expect(global).not.toMatch(/@import/)
  })

  it('imports every route-owned stylesheet from exactly its owner page', () => {
    const pagesDir = resolve(stylesDir, '../pages')
    const entryStylesheets = new Set(EXPECTED_ENTRY_IMPORTS.map((spec) => spec.split('/').pop()))
    const routeOwned = new Map<string, string>()
    const pageImports = (page: string) => {
      const source = readFileSync(resolve(pagesDir, page), 'utf8')
      return [...source.matchAll(/^import\s+['"](?:\.\.?\/)+styles\/([^'"]+\.css)['"]/gmu)].map((m) => m[1])
    }
    const sharedFiles = new Set(Object.keys(SHARED_ROUTE_STYLESHEETS))
    for (const [page, files] of Object.entries(ROUTE_STYLESHEETS)) {
      const imports = pageImports(page).filter((file) => !sharedFiles.has(file!))
      expect(imports, `${page} must import its route stylesheets in cascade order`).toEqual(files)
      for (const file of files) {
        expect(entryStylesheets.has(file), `${file} must not also load from main.tsx`).toBe(false)
        expect(routeOwned.has(file), `${file} must have a single owner page`).toBe(false)
        routeOwned.set(file, page)
      }
    }
    const sharedOwners = new Map<string, Set<string>>()
    for (const [file, pages] of Object.entries(SHARED_ROUTE_STYLESHEETS)) {
      expect(entryStylesheets.has(file), `${file} must not also load from main.tsx`).toBe(false)
      expect(routeOwned.has(file), `${file} cannot be both route-owned and shared`).toBe(false)
      for (const page of pages) {
        expect(pageImports(page), `${page} must import the shared ${file}`).toContain(file)
      }
      sharedOwners.set(file, new Set(pages))
    }
    // Every stylesheet is either an entry import, route-owned, shared, or print.
    const accounted = new Set([...entryStylesheets, ...routeOwned.keys(), ...sharedOwners.keys(), 'print.css'])
    expect([...accounted].sort()).toEqual(Object.keys(OWNER_MAP).sort())
    // No other production module imports a route-owned or shared stylesheet.
    for (const path of walkProductionTs(resolve(stylesDir, '..'))) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/^import\s+['"](?:\.\.?\/)+styles\/([^'"]+\.css)['"]/gmu)) {
        const file = match[1]
        if (path.endsWith('main.tsx')) continue
        const shared = sharedOwners.get(file!)
        if (shared) {
          const page = path.split('/pages/')[1]
          expect(page !== undefined && shared.has(page), `${file} may only be imported by its listed pages, not ${path}`).toBe(true)
          continue
        }
        const owner = routeOwned.get(file!)
        expect(owner, `${file} is imported from ${path} but is not route-owned`).toBeTruthy()
        expect(path.endsWith(`/pages/${owner}`), `${file} may only be imported by ${owner}`).toBe(true)
      }
    }
  })

  it('loads print.css from index.html as a print-only stylesheet', () => {
    const html = readFileSync(resolve(stylesDir, '../../index.html'), 'utf8')
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="\/src\/styles\/print\.css"\s+media="print"\s*\/?>/)
  })

  it('does not ship screen data-URIs into print and clears grain tokens', () => {
    const print = readFileSync(resolve(stylesDir, 'print.css'), 'utf8')
    expect(print).not.toMatch(/data:image|base64/i)
    expect(print).toMatch(/--grain:\s*none/)
    expect(print).toMatch(/--dither:\s*none/)
    expect(print).toMatch(/--dither-paper:\s*none/)
    expect(print).toMatch(/--select-chevron:\s*none/)
  })

  it('wraps every index.html author <style> block in a known cascade layer', () => {
    const html = readFileSync(resolve(stylesDir, '../../index.html'), 'utf8')
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      const text = stripComments(block!).trimStart()
      expect(text.startsWith('@layer '), 'index.html <style> must open inside a known @layer').toBe(true)
      const name = text.match(/^@layer\s+([\w-]+)\s*\{/)?.[1]
      expect(name, 'index.html <style> must name a known layer').toBeTruthy()
      expect(LAYER_ORDER).toContain(name)
    }
  })

  it('self-hosts Latin fonts and keeps Noto SC off the first-paint document', () => {
    const html = readFileSync(resolve(stylesDir, '../../index.html'), 'utf8')
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|Noto\+(Sans|Serif)\+SC/)
    const entry = readFileSync(entryPath, 'utf8')
    const fontImports = [...entry.matchAll(/^import\s+['"](@fontsource-variable\/[^'"]+)['"]/gmu)].map((m) => m[1])
    expect(fontImports).toEqual([
      // R15-31: weight-only files; nothing uses the width axis.
      '@fontsource-variable/instrument-sans/index.css',
      '@fontsource-variable/instrument-sans/wght-italic.css',
      '@fontsource-variable/newsreader/opsz.css',
      '@fontsource-variable/newsreader/opsz-italic.css',
    ])
    expect(entry.indexOf(fontImports[0]!)).toBeLessThan(entry.indexOf("./styles/tokens.css"))
    const tokens = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/--font-sans:\s*"Instrument Sans Variable".*"PingFang SC".*"Noto Sans SC"/)
    expect(tokens).toMatch(/--font-serif:\s*"Newsreader Variable".*"Songti SC".*"Noto Serif SC"/)
    expect(tokens).not.toMatch(/--font-sans:\s*"Instrument Sans",\s*"Noto Sans SC"/)
    // R15-31: a metric-matched fallback sits second in each stack.
    expect(tokens).toMatch(/--font-sans:\s*"Instrument Sans Variable",\s*"Instrument Sans Fallback"/)
    expect(tokens).toMatch(/--font-serif:\s*"Newsreader Variable",\s*"Newsreader Fallback"/)
    expect(tokens).toMatch(/font-family: "Instrument Sans Fallback";[\s\S]*?size-adjust:/)
  })

  it('wraps every stylesheet in the @layer block(s) of its registered owner(s)', () => {
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css'))
    expect(cssFiles.sort()).toEqual(Object.keys(OWNER_MAP).sort())
    for (const file of cssFiles) {
      const source = readFileSync(resolve(stylesDir, file), 'utf8')
      const owners = [OWNER_MAP[file]].flat()
      const layerNames = [...stripComments(source).matchAll(/@layer\s+([\w-]+)\s*\{/g)].map((m) => m[1])
      expect(layerNames, `${file} must declare exactly its owner layer blocks, in order`).toEqual(owners)
      expect(firstLayerName(source), `${file} must open with its owner layer`).toBe(owners[0])
      expect(source.trimEnd().endsWith('}'), `${file} must close its layer block`).toBe(true)
    }
  })

  it('keeps every rule inside its owner layer — nothing after a layer block closes', () => {
    // Unlayered CSS outranks every layer, so a rule appended after the
    // layer's closing brace silently beats patterns/utilities (R12-19).
    for (const file of readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
      const source = readFileSync(resolve(stylesDir, file), 'utf8')
      const preludes = topLevelBlockPreludes(source)
      expect(preludes, `${file} may only contain its owner @layer block(s) at the top level`).toEqual(
        [OWNER_MAP[file]].flat().map((layer) => `@layer ${layer}`),
      )
    }
  })

  it('reserves page-layouts.css in the pages layer', () => {
    const file = 'page-layouts.css'
    expect(readdirSync(stylesDir)).toContain(file)
    const source = readFileSync(resolve(stylesDir, file), 'utf8')
    expect(OWNER_MAP[file]).toBe('pages')
    expect(firstLayerName(source)).toBe('pages')
  })
})

/** Preludes of the top-level blocks of a stylesheet, in order. Any stray
 *  top-level declaration text surfaces as its own entry, so a rule outside
 *  every block fails the comparison. The tokens.css layer-order statement is
 *  the one top-level statement allowed. */
function topLevelBlockPreludes(source: string): string[] {
  const text = stripComments(source).replace(/^\s*@layer\s+[\w-]+(?:\s*,\s*[\w-]+)*;/, '')
  const preludes: string[] = []
  let depth = 0
  let quote: string | null = null
  let prelude = ''
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      if (depth === 0) prelude += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      if (depth === 0) prelude += char
      continue
    }
    if (char === '{') {
      if (depth === 0) preludes.push(prelude.trim().replace(/\s+/g, ' '))
      depth += 1
      prelude = ''
      continue
    }
    if (char === '}') {
      depth -= 1
      continue
    }
    if (depth === 0) prelude += char
  }
  if (prelude.trim()) preludes.push(prelude.trim())
  return preludes
}

function walkProductionTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') continue
      walkProductionTs(path, acc)
      continue
    }
    if (/\.(ts|tsx)$/.test(name) && !/\.(?:test|spec)\./.test(name)) acc.push(path)
  }
  return acc
}

function classNameTokens(source: string): Set<string> {
  const tokens = new Set<string>()
  for (const attr of source.matchAll(/className\s*=\s*(?:\{[\s\S]*?\}|"[^"]*"|'[^']*')/g)) {
    for (const token of attr[0].matchAll(/\b[a-z][a-z0-9-]*\b/g)) tokens.add(token[0])
  }
  return tokens
}

describe('utilities.css live-set ratchet', () => {
  it('declares only spacing helpers referenced from production className', () => {
    const css = readFileSync(resolve(stylesDir, 'utilities.css'), 'utf8')
    const declared = [...css.matchAll(/^\.([a-z0-9-]+)\s*\{/gm)].map((m) => m[1]).sort()
    const used = new Set<string>()
    const srcRoot = resolve(stylesDir, '..')
    for (const file of walkProductionTs(srcRoot)) {
      const tokens = classNameTokens(readFileSync(file, 'utf8'))
      for (const cls of declared) {
        if (tokens.has(cls!)) used.add(cls!)
      }
    }
    expect(declared, 'utilities.css must not grow unused helpers').toEqual([...used].sort())
  })
})
