import { siteFeatures } from './capabilities.js';
import type { SiteDefinition } from './registry-types.js';
import { t } from '../i18n.js';
/** Apply after rendering dynamic job state, so unavailable operations cannot reappear on refresh. */
export function renderSiteCapabilities(document: Document, definition: SiteDefinition, hasImportJob = false, hasArchiveConfig = false) {
  const features = siteFeatures(definition);
  const hideAction = (id: string, available: boolean, row = false) => {
    const button = document.querySelector<HTMLButtonElement>(`#${id}`); if (!button) return;
    if (!available) { button.hidden = true; button.disabled = true; }
    if (row) { const parent = button.closest<HTMLElement>('.set-row'); if (parent) parent.hidden = !available; }
  };
  hideAction('read-catalog', features.collections);
  hideAction('read-item', features.resolve, true); hideAction('retry-confirmation', features.confirmation, true);
  hideAction('archive-live', features.liveArchive, true); hideAction('configure-archive', features.archive); hideAction('grant-archive', features.archive);
  for (const id of ['start-import', 'resume-import', 'retry-import', 'freeze-import', 'approve-import']) hideAction(id, features.import);
  const archive = document.querySelector<HTMLElement>('[aria-labelledby="sites-archive-heading"]'); if (archive) archive.hidden = !features.archive && !hasArchiveConfig;
  const section = document.querySelector<HTMLElement>('#step-import'); if (section) section.hidden = !features.import && !hasImportJob;
  const summary = document.querySelector('#capability-summary');
  const labels = [features.liveArchive && t('sites_liveArchiving', 'Live archiving'), features.collections && t('sites_featureCatalog', 'Read collections'),
    features.resolve && t('sites_featureResolution', 'Identify content'), features.import && t('sites_featureImport', 'Import with preview'),
    features.confirmation && definition.negativeReadback && t('sites_featureNegativeReadback', 'Verify membership removals')].filter(Boolean);
  if (summary) summary.textContent = labels.length ? t('sites_availableFeatures', 'Available: $1.', labels.join(' · ')) : t('sites_noSourceActions', 'No source actions are available.');
}
