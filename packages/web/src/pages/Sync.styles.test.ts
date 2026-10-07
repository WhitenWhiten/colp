import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Sync Center production presentation boundary', () => {
  it('styles the authoritative workspace and leaves legacy telemetry out of the page', () => {
    const page = readFileSync(resolve(import.meta.dirname, 'Sync.tsx'), 'utf8')
    const styles = readFileSync(resolve(import.meta.dirname, '../styles/sync.css'), 'utf8')
    for (const selector of ['.sync-page', '.replica-list', '.replica-actions', '.sync-recovery', '.conflict-comparison', '.conflict-options', '.custom-editor', '.trash-list', '.trash-row']) {
      expect(styles).toContain(selector)
    }
    expect(page).not.toMatch(/syncConflictsSeed|syncFolders|syncLog|sync-status|sync-log|Sync now|FEATURE_FLAGS\.sync|isLive\(['"]sync['"]\)|window\.confirm|legacySyncFolders/u)
  })
})
