import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  pageModulesImportedFromApp,
  pageSetsDocumentTitle,
  reachablePageSurface,
  routedPageModules,
} from '../lib/routeDocumentTitles'

const appPath = resolve(import.meta.dirname, '../App.tsx')
const pagesDir = resolve(import.meta.dirname)
const appSource = readFileSync(appPath, 'utf8')

function pageFile(spec: string): string {
  const tsx = resolve(pagesDir, `${spec}.tsx`)
  if (existsSync(tsx)) return tsx
  const ts = resolve(pagesDir, `${spec}.ts`)
  if (existsSync(ts)) return ts
  throw new Error(`App.tsx imports ./pages/${spec} but ${spec}.tsx/.ts is missing`)
}

describe('route document titles', () => {
  it('treats a page without a title hook or documentTitle prop as uncovered', () => {
    expect(pageSetsDocumentTitle('export function NewPage() { return <h1>Hi</h1> }')).toBe(false)
    expect(pageSetsDocumentTitle("import { PageHead } from '../components/PageHead'\nexport function NewPage() { return <PageHead title=\"Hi\" /> }")).toBe(false)
    expect(pageSetsDocumentTitle("useDocumentTitle('Inbox')")).toBe(true)
    expect(pageSetsDocumentTitle('<PageHead title="Inbox" documentTitle="Inbox" />')).toBe(true)
  })

  it('maps App.tsx route elements to ./pages modules and skips Navigate', () => {
    const snippet = `
      import { Landing } from './pages/Landing'
      const Inbox = lazy(async () => ({ default: (await import('./pages/Inbox')).Inbox }))
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="old" element={<Navigate to="/inbox" replace />} />
      </Route>
    `
    expect(routedPageModules(snippet)).toEqual(['Inbox', 'Landing'])
  })

  it('fails when a route element is not a ./pages import', () => {
    expect(() => routedPageModules('<Route path="x" element={<Mystery />} />')).toThrow(/Mystery/)
  })

  it('requires every routed App.tsx page module to set a document title', () => {
    const routed = routedPageModules(appSource)
    const imported = pageModulesImportedFromApp(appSource)
    expect(routed.length).toBeGreaterThanOrEqual(40)
    expect(imported.sort()).toEqual(routed)

    const missing = routed.filter((spec) => !pageSetsDocumentTitle(reachablePageSurface(pageFile(spec))))
    expect(missing, 'add useDocumentTitle(...) or PageHead documentTitle= in the route page surface (root or a colocated module)').toEqual([])
  })
})
