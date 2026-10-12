import { t, tn } from '../i18n.js';
import type { CreateMapping, ProjectionNode, SnapshotDescriptor } from '../bookmark-subscriptions/contracts.js';
import { counted, el, field, select } from './dom.js';
export type ContentSettings = Pick<CreateMapping, 'digestMode'|'editionLimit'|'checkIntervalMinutes'|'exitPolicy'>;
export function contentSettings(host: HTMLElement, digest: boolean, initial: ContentSettings, changed: () => void) {
  const mode = select([['latest', t('subscription_latest', 'Latest readable issue')], ['recent', t('subscription_recent', 'Recent issues (maximum 20)')]], initial.digestMode ?? 'latest');
  const limit = el('input'); limit.type = 'number'; limit.min = '1'; limit.max = '20'; limit.step = '1'; limit.value = String(initial.digestMode === 'recent' ? initial.editionLimit ?? 10 : 10);
  const error = el('p', t('subscription_limitHint', 'Choose a whole number from 1 to 20.'), 'field-hint'); error.id = 'edition-limit-error-' + crypto.randomUUID(); limit.setAttribute('aria-describedby', error.id);
  const limitRow = field(t('subscription_issueCount', 'Number of recent issues'), limit); limitRow.append(error);
  const interval = select([['5', t('subscription_fiveMinutes', '5 minutes')], ['15', t('subscription_fifteenMinutes', '15 minutes')], ['60', t('subscription_oneHour', '1 hour')], ['manual', t('common_manual', 'Manual')]], initial.checkIntervalMinutes === null ? 'manual' : String(initial.checkIntervalMinutes));
  const modeRow = field(t('subscription_digestContent', 'Digest content'), mode); modeRow.hidden = !digest; const paint = () => { limitRow.hidden = !digest || mode.value !== 'recent'; };
  mode.addEventListener('change', () => { paint(); changed(); }); limit.addEventListener('input', changed); interval.addEventListener('change', changed); paint();
  host.append(modeRow, limitRow, field(t('subscription_checkInterval', 'Check interval'), interval));
  return () => {
    const editionLimit = !digest ? null : mode.value === 'latest' ? 1 : Number(limit.value);
    const valid = editionLimit === null || Number.isInteger(editionLimit) && editionLimit >= 1 && editionLimit <= 20; limit.setAttribute('aria-invalid', String(!valid));
    if (!valid) { limit.focus(); return null; }
    return { digestMode: digest ? mode.value as 'latest'|'recent' : null, editionLimit,
      checkIntervalMinutes: interval.value === 'manual' ? null : Number(interval.value) as 5|15|60, exitPolicy: initial.exitPolicy };
  };
}
export function renderProjection(host: HTMLElement, preview: { descriptor: SnapshotDescriptor; nodes: ProjectionNode[] }) {
  const { descriptor, nodes } = preview;
  host.className = 'subscription-preview';
  const counts = el('p', undefined, 'subscription-preview-counts'); counts.append(...counted(tn('subscription_bookmarkTotal', descriptor.counts.bookmarks, '$1 bookmark', '$1 bookmarks'), descriptor.counts.bookmarks), ' · ', ...counted(tn('subscription_issueTotal', descriptor.counts.editions, '$1 issue', '$1 issues'), descriptor.counts.editions));
  host.replaceChildren(counts);
  for (const skip of descriptor.skippedByReason) host.append(el('p', t('subscription_skippedReason', '$1 skipped: $2', skip.count, skip.reason), 'field-hint'));
  if (descriptor.editions.length) { const editions = el('ul', undefined, 'subscription-preview-editions'); for (const edition of descriptor.editions) editions.append(el('li', edition.title)); host.append(editions); }
  const details = el('details', undefined, 'subscription-disclosure'); details.append(el('summary', t('subscription_treePreview', 'Show what will be added')));
  // A finite initial view keeps large snapshots usable; the complete snapshot is validated by the worker.
  const list = el('ul', undefined, 'subscription-preview-tree'), parents = new Map<string, HTMLUListElement>(); let rendered = 0;
  const more = el('button', t('subscription_showMore', 'Show more')); more.type = 'button'; more.className = 'btn btn-ghost';
  const append = () => { const end = Math.min(nodes.length, rendered + 200); for (; rendered < end; rendered++) { const node = nodes[rendered]!; const item = el('li', node.title); (node.parentKey ? parents.get(node.parentKey) ?? list : list).append(item); if (node.kind === 'folder') { const children = el('ul'); item.append(children); parents.set(node.key, children); } } more.hidden = rendered >= nodes.length; };
  more.addEventListener('click', append); append(); details.append(list, more); host.append(details);
}
