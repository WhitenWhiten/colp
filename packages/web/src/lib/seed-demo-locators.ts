/**
 * Minted demo-seed locators for live product routes.
 * Must stay in lockstep with Known-Backend `seedOpaqueId` /
 * `seedCollectionId('col-u01-01')` / `seedNodeId('nd-col-u01-01-001')`.
 */
export const SEED_DEMO_FLAGSHIP_COLLECTION_ID = 'col-uQ8qw6gOg1ExVpqEEg'
export const SEED_DEMO_FLAGSHIP_NODE_001_ID = 'nd-col-Lo7a4NCymz9jOHw'
export const SEED_DEMO_FLAGSHIP_SLUG = 'llm-learning-path'

export function seedDemoLibraryEditorPath(): string {
  return `/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}?collection=edit`
}

export function seedDemoLibraryHistoryPath(): string {
  return `/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}/history`
}

export function seedDemoLibraryCollaboratorsPath(): string {
  return `/library/${SEED_DEMO_FLAGSHIP_COLLECTION_ID}/collaborators`
}

export function seedDemoReaderPath(): string {
  return `/read/${SEED_DEMO_FLAGSHIP_NODE_001_ID}?collectionId=${SEED_DEMO_FLAGSHIP_COLLECTION_ID}&subjectType=node&slug=${SEED_DEMO_FLAGSHIP_SLUG}`
}

export const SEED_DEMO_REPORT_FLAGSHIP_SLUG = 'ai-weekly-field-notes'
export const SEED_DEMO_REPORT_FLAGSHIP_EDITION_ID = 'seed-rpt-edition-ai-2026-36'

export function seedDemoReportSeriesPath(): string {
  return `/reports/${SEED_DEMO_REPORT_FLAGSHIP_SLUG}`
}

export function seedDemoReportIssuePath(): string {
  return `/reports/${SEED_DEMO_REPORT_FLAGSHIP_SLUG}/issues/${SEED_DEMO_REPORT_FLAGSHIP_EDITION_ID}`
}

export const SEED_DEMO_HIDDEN_COLLECTION_SLUG = 'indie-toolbox'
export const SEED_DEMO_DELISTED_COLLECTION_SLUG = 'sasha-brutalism'
export const SEED_DEMO_CURATOR_LOCKED_SLUG = 'frontend-engineering'
export const SEED_DEMO_OFFICIAL_LOCKED_SLUG = 'sre-runbook'
export const SEED_DEMO_HIDDEN_SERIES_SLUG = 'climate-plain-digest'

export function seedDemoHiddenCollectionPath(): string {
  return `/c/${SEED_DEMO_HIDDEN_COLLECTION_SLUG}`
}

export function seedDemoDelistedCollectionPath(): string {
  return `/c/${SEED_DEMO_DELISTED_COLLECTION_SLUG}`
}

export function seedDemoMyReportsPath(): string {
  return '/moderation/reports'
}

export function seedDemoOfficialCasesPath(): string {
  return '/admin/moderation/cases'
}
