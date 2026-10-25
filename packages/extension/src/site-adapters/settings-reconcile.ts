import { t } from '../i18n.js';
import type { ReconcileDifference, ReconcilePreview } from './reconcile-model.js';
const labels = () => ({ present: t('sites_diffPresent', 'Already mapped'), add: t('sites_diffAdd', 'New favorite'), candidate: t('sites_diffCandidate', 'Existing bookmark can be linked'),
  localDeleted: t('sites_diffDeleted', 'Deleted locally; kept deleted'), moved: t('sites_diffMoved', 'Moved or changed locally'), sourceRemoved: t('sites_diffRemoved', 'No longer in the source collection'),
  unverified: t('sites_diffUnverified', 'Source membership could not be verified'), title: t('sites_diffTitle', 'Source title changed'), personal: t('sites_diffPersonal', 'Unassociated personal item'),
  protected: t('sites_diffProtected', 'Used by another mapping or semantic copy') });
let shown = 100, signature = '';
export function paintReconciliation(preview: ReconcilePreview | null | undefined) {
  const section = document.getElementById('reconcile-preview'); if (!section) return;
  section.hidden = !preview; if (!preview) return;
  if (signature !== preview.digest) { signature = preview.digest; shown = 100; }
  const counts = new Map<string, number>(); for (const row of preview.differences) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const names = labels();
  document.getElementById('reconcile-summary')!.textContent = [...counts].map(([kind, count]) => `${names[kind as ReconcileDifference['kind']]}: ${count}`).join(' · ');
  const rows = preview.differences.filter(d => d.kind !== 'present');
  document.getElementById('reconcile-list')!.replaceChildren(...rows.slice(0, shown).map(row => {
    const element = document.createElement('div'); element.className = 'set-row';
    const copy = document.createElement('div'); copy.className = 'set-row-text';
    const title = document.createElement('p'); title.className = 'set-row-title'; title.textContent = row.title;
    const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = names[row.kind]; copy.append(title, hint); element.append(copy);
    return element;
  }));
  const more = document.getElementById('reconcile-more')! as HTMLButtonElement; more.hidden = shown >= rows.length;
  more.onclick = () => { shown += 100; paintReconciliation(preview); };
}
