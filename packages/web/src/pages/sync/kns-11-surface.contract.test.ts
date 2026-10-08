/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const webSrc = resolve(import.meta.dirname, '../..')

function read(relative: string): string {
  return readFileSync(resolve(webSrc, relative), 'utf8')
}

describe('KNS-11 trash surface boundary', () => {
  it('exposes bulk restore and empty trash only behind confirmation, not as a silent loop of single restores', () => {
    const surface = [
      read('pages/sync/trash.tsx'),
      read('pages/sync/view.tsx'),
      read('pages/sync/trash-batch.ts'),
      read('pages/Sync.tsx'),
    ].join('\n')
    expect(surface).toMatch(/Empty trash/u)
    expect(surface).toMatch(/Permanently delete/u)
    expect(surface).toMatch(/Restore selected/u)
    expect(surface).toContain('at least 30 days')
    expect(surface).toContain("restoreSyncTrashBatch")
    expect(surface).toContain("emptySyncTrash")
    expect(surface).not.toMatch(/for\s*\(.*of\s+selected[\s\S]*restoreSyncTrashItem/u)
    expect(surface).not.toMatch(/purgeAll|bulkPurge/u)
    expect(read('pages/sync/view.tsx')).toContain("from './trash'")
  })

  it('keeps trash out of popup save targets, public share, and normal search', () => {
    const popup = read('pages/ExtensionPopup.tsx')
    const search = read('pages/Search.tsx')
    const share = read('pages/share/CollectionShare.tsx')
    expect(popup).not.toMatch(/sync\/trash|Deleted items|Show URL/u)
    expect(search).not.toMatch(/trash|Deleted items/u)
    expect(search).toContain("value: 'collection'")
    expect(search).toContain("value: 'node'")
    expect(share).not.toMatch(/sync\/trash|Deleted items/u)
  })
})
