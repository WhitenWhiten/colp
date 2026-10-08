import { describe, expect, it } from 'vitest'
import {
  SEED_DEMO_FLAGSHIP_COLLECTION_ID,
  SEED_DEMO_FLAGSHIP_NODE_001_ID,
  SEED_DEMO_REPORT_FLAGSHIP_EDITION_ID,
  SEED_DEMO_REPORT_FLAGSHIP_SLUG,
  seedDemoLibraryCollaboratorsPath,
  seedDemoLibraryEditorPath,
  seedDemoLibraryHistoryPath,
  seedDemoReaderPath,
  seedDemoReportIssuePath,
  seedDemoReportSeriesPath,
  SEED_DEMO_HIDDEN_COLLECTION_SLUG,
  SEED_DEMO_DELISTED_COLLECTION_SLUG,
  seedDemoHiddenCollectionPath,
  seedDemoDelistedCollectionPath,
  seedDemoMyReportsPath,
  seedDemoOfficialCasesPath,
} from './seed-demo-locators'

describe('seed demo locators', () => {
  it('uses minted flagship ids, not legacy col-u01-01 / nd-col-u01-01-001', () => {
    expect(SEED_DEMO_FLAGSHIP_COLLECTION_ID).toBe('col-uQ8qw6gOg1ExVpqEEg')
    expect(SEED_DEMO_FLAGSHIP_NODE_001_ID).toBe('nd-col-Lo7a4NCymz9jOHw')
    expect(SEED_DEMO_FLAGSHIP_COLLECTION_ID).not.toBe('col-u01-01')
    expect(SEED_DEMO_FLAGSHIP_NODE_001_ID).not.toContain('nd-col-u01-01-001')

    expect(seedDemoLibraryEditorPath()).toBe(`/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}?collection=edit`)
    expect(seedDemoLibraryHistoryPath()).toBe(`/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}/history`)
    expect(seedDemoLibraryCollaboratorsPath()).toBe(
      `/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}/collaborators`,
    )
    expect(seedDemoReaderPath()).toContain(`/read/${SEED_DEMO_FLAGSHIP_NODE_001_ID}`)
    expect(seedDemoReaderPath()).toContain(`collectionId=${SEED_DEMO_FLAGSHIP_COLLECTION_ID}`)
    expect(seedDemoReaderPath()).toContain('slug=llm-learning-path')
  })

  it('pins the flagship News Digest series and latest issue on /reports', () => {
    expect(SEED_DEMO_REPORT_FLAGSHIP_SLUG).toBe('ai-weekly-field-notes')
    expect(SEED_DEMO_REPORT_FLAGSHIP_EDITION_ID).toBe('seed-rpt-edition-ai-2026-36')
    expect(seedDemoReportSeriesPath()).toBe('/reports/ai-weekly-field-notes')
    expect(seedDemoReportIssuePath()).toBe(
      '/reports/ai-weekly-field-notes/issues/seed-rpt-edition-ai-2026-36',
    )
  })

  it('pins Wave 17 governance locators on public slugs and official routes', () => {
    expect(SEED_DEMO_HIDDEN_COLLECTION_SLUG).toBe('indie-toolbox')
    expect(SEED_DEMO_DELISTED_COLLECTION_SLUG).toBe('sasha-brutalism')
    expect(seedDemoHiddenCollectionPath()).toBe('/c/indie-toolbox')
    expect(seedDemoDelistedCollectionPath()).toBe('/c/sasha-brutalism')
    expect(seedDemoMyReportsPath()).toBe('/moderation/reports')
    expect(seedDemoOfficialCasesPath()).toBe('/admin/moderation/cases')
  })
})
