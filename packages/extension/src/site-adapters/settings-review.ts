import { t } from '../i18n.js';
import { siteProblem } from './problem-view.js';
import { problemFamily } from './activity.js';
import type { ImportStatus } from './settings-import.js';
import type { SiteDefinition } from './registry-types.js';
import { importBlocker } from './import-problems.js';

/** Planning refusals belong in the same review disclosure as bookmark differences, with no new configuration surface. */
export function paintImportReview(job: ImportStatus | null, definition: SiteDefinition, hasDifferences: boolean) {
  const section = document.getElementById('import-review')!;
  const samples = (job?.preview?.reviewSamples ?? []).filter(s => !hasDifferences || s.reason !== 'sourceReconcileCandidate');
  const count = job?.preview?.counts.review ?? 0;
  const blocker = importBlocker(job);
  section.hidden = !count || !job || !['preview', 'attention'].includes(job.phase) || hasDifferences && !samples.length && !blocker;
  if (section.hidden) return false;
  document.getElementById('import-review-summary')!.textContent = blocker
    ? t('sites_reviewMappingBlocked', '$1 items were not saved because the save location is unavailable. Resolve this mapping once, then prepare the import again; individual videos do not need review.', count.toLocaleString())
    : !samples.length
    ? t('sites_reviewSamplesUnavailable', 'Item details are unavailable for this older check. Copy its problem report or make the list again.')
    : t('sites_reviewSamplesShown', '$1 items need review. Showing $2 examples; bookmarks already saved are kept.', count.toLocaleString(), samples.length.toLocaleString());
  const list = document.getElementById('import-review-list')!, key = JSON.stringify(samples);
  document.getElementById('import-review-settings')!.textContent = blocker ? t('sites_confirmSaveLocation', 'Confirm save location') : t('sites_syncSettings', 'Sync settings');
  if (blocker) {
    const view = siteProblem(blocker, definition.label), row = document.createElement('div'); row.className = 'set-row';
    const text = document.createElement('div'); text.className = 'set-row-text';
    const title = document.createElement('p'); title.className = 'set-row-title'; title.textContent = view.what;
    const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = view.next;
    text.append(title, hint); row.append(text); list.replaceChildren(row); delete list.dataset.rows;
    document.getElementById('import-review-check')!.hidden = true; return true;
  }
  if (list.dataset.rows !== key) {
    list.dataset.rows = key;
    list.replaceChildren(...samples.map(sample => {
      const row = document.createElement('div'); row.className = 'set-row';
      const text = document.createElement('div'); text.className = 'set-row-text';
      const title = document.createElement('p'); title.className = 'set-row-title';
      const label = sample.itemTitle ?? t('sites_sourceItem', 'Source item'), url = definition.itemUrl(sample.itemId);
      if (url) { const link = document.createElement('a'); link.textContent = label; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; title.append(link); }
      else title.textContent = label;
      const problem = siteProblem(sample.reason, definition.label);
      const what = sample.reason === 'suppressed' ? t('sites_reviewLocalChange', 'This copy was deleted or changed locally. Your change has been preserved.')
        : sample.reason === 'policySkipped' || sample.reason === 'noMatch' ? t('sites_reviewPolicySkip', 'The current saving policy leaves this item as it is.')
        : sample.reason === 'primarySourceCollectionRequired' ? t('sites_reviewPrimary', 'This item belongs to several selected collections. Choose its primary collection in the copy settings.')
        : sample.reason === 'sourceReconcileCandidate' ? t('sites_reviewDifference', 'This item has a bookmark difference that needs to be reviewed before saving.')
        : problem.what;
      const next = sample.reason === 'primarySourceCollectionRequired' ? '' : ['suppressed', 'policySkipped', 'noMatch', 'sourceReconcileCandidate'].includes(sample.reason)
        ? t('sites_reviewPreservedNext', 'Review the bookmark changes or saving settings, then make the list again when ready.') : problem.next;
      const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = [sample.collectionTitle, what, next].filter(Boolean).join(' · ');
      text.append(title, hint); row.append(text); return row;
    }));
  }
  document.getElementById('import-review-check')!.hidden = !samples.some(s => problemFamily(s.reason) === 'unconfirmed');
  return true;
}
