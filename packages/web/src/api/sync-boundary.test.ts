import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Product Sync generated boundary', () => {
  it('uses the P3-36 generated schemas as the only Sync DTO authority', () => {
    const generated = readFileSync(resolve(import.meta.dirname, '../../../server/generated/openapi/product-v1.ts'), 'utf8')
    const aliases = readFileSync(resolve(import.meta.dirname, 'types.ts'), 'utf8')
    const client = readFileSync(resolve(import.meta.dirname, 'productClient.ts'), 'utf8')

    for (const schema of [
      'SyncStatusView', 'SyncConflictSummary', 'SyncConflictPage',
      'ProductSyncConflictResolution', 'ProductSyncConflictResolutionView',
      'SyncTrashListItem', 'SyncTrashPage', 'SyncTrashDetail', 'SyncTrashRestoreView',
      'SyncTrashRestoreBatchRequest', 'SyncTrashRestoreBatchView', 'SyncTrashEmptyRequest', 'SyncTrashEmptyView',
    ]) {
      expect(generated).toContain(`${schema}:`)
      expect(aliases).toContain(`Schemas['${schema}']`)
    }
    expect(client).not.toMatch(/interface\s+(?:Product)?Sync(?:Status|Conflict|Replica|Device)/u)
    expect(client).not.toContain("'pending' | 'local' | 'cloud'")
  })
})
