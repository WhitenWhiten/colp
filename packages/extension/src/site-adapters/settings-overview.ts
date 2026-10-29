import type { LocalSourceProgress } from './local-progress.js';
import { t, tn } from '../i18n.js';
import type { SiteDefinition } from './registry-types.js';
import type { SourceOverview, CollectionOverview } from './overview.js';
import { siteFeatures } from './capabilities.js';

export interface OverviewStatus {
  pipeline?: LocalSourceProgress;
  accountLabel?: string;
  enabled?: boolean; connected?: boolean; candidateAccount?: string | null; documents?: number;
  archive?: { config: { state: string; root: { nativeId: string }; collectionIds: readonly string[]; live: boolean } | null;
    overview?: SourceOverview | null; overviewError?: string | null; catalog?: { id: string; title: string }[] };
  catalog?: { items: { id: string; title: string }[] } | null;
}
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const set = (id: string, copy: string) => { element(id).textContent = copy; };
const count = (n: number) => n.toLocaleString();

export function paintSourceOverview(status: OverviewStatus, definition: SiteDefinition, folderNames: ReadonlyMap<string, string>,
  edit: (part: 'collections' | 'destination' | 'connection', collectionId?: string) => void, folderPaths?: ReadonlyMap<string, string>) {
  const config = status.archive?.config, overview = status.archive?.overview, features = siteFeatures(definition);
  const pipeline = document.getElementById('source-pipeline-status'), progress = status.pipeline;
  const retry = document.getElementById('source-pipeline-retry');
  if (retry) retry.hidden = !progress?.attention;
  if (pipeline) pipeline.textContent = !progress ? '' : !progress.available ? t('sites_localProgressUnavailable', 'Save progress could not be verified')
    : progress.pendingConfirmation ? t('sites_localConfirming', 'Checking the website favorite')
    : progress.localAttention ? t('sites_localSaveReview', 'Local saving needs review')
    : progress.pendingLocal ? t('sites_localSaving', 'Waiting for local bookmark saving')
    : progress.reason === 'source_copy_convergence_review' ? t('sites_localConvergenceReview', 'Saved locally · copies with personal changes need review before combining')
    : progress.reason === 'sourceSyncUpgradeRequired' ? t('sites_localServerUpgrade', 'Saved locally · update COLP Server to share copy associations')
    : progress.attention ? t('sites_localAssociationReview', 'Saved locally · shared association needs review')
    : progress.pendingSync ? t('sites_localPendingSync', 'Saved locally · waiting for sync and association')
    : overview?.saved ? t('sites_localSavingComplete', 'Local bookmark saving complete') : '';

  element('source-overview').hidden = !config;
  element('source-identification').hidden = features.archive;
  const identify = element<HTMLButtonElement>('overview-identify');
  identify.hidden = !features.resolve; identify.disabled = !status.documents || !status.connected;
  set('source-identification-copy', features.resolve ? t('sites_identifyOnly', 'This source identifies the current page. It does not enumerate or automatically save items.')
    : t('sites_noSavingCapability', 'This adapter does not offer collection reading or automatic saving.'));
  if (!config) return;
  const rootName = folderNames.get(config.root.nativeId) ?? t('sites_theChosenRoot', 'the chosen root');
  set('overview-source', definition.connectionKind === 'page' ? t('sites_pageSource', 'Source: $1', definition.label)
    : status.connected && !status.candidateAccount ? status.accountLabel ? t('sites_accountDisplayName', '$1 · $2', definition.label, status.accountLabel)
      : t('sites_connectedSource', '$1 account connected', definition.label) : t('sites_sourceNeedsConnection', '$1 connection needs attention', definition.label));
  set('overview-destination', t('sites_savedUnder', 'Save into: $1', folderPaths?.get(config.root.nativeId) ?? rootName));
  const folderLink = element<HTMLAnchorElement>('overview-open-folder');
  folderLink.href = chrome.runtime.getURL(`options.html#bookmarks?folder=${encodeURIComponent(config.root.nativeId)}`);
  const total = config.collectionIds.length;
  set('overview-policy', [definition.defaultCollection ? t('sites_oneSourceList', 'One source list') : tn('sites_scopeCount', total, '$1 collection selected', '$1 collections selected'),
    !features.liveArchive ? t('sites_manualChecks', 'Saved through reviewed checks') : config.live && config.state === 'active' && status.enabled
      ? t('sites_newItemsOn', 'New favorites save automatically') : t('sites_newItemsOff', 'New favorites are not saved automatically')].join(' · '));
  set('overview-result', overview?.pendingWrites ? t('sites_updatingSavedResults', 'Updating confirmed save results…') : overview ? tn('sites_confirmedSaved', overview.saved, '$2 bookmark saved in this mapping', '$2 bookmarks saved in this mapping', count(overview.saved))
    : t('sites_savedCountUnknown', 'Saved results could not be verified yet.'));
  set('overview-scope-heading', definition.defaultCollection ? t('sites_sourceList', 'Source list') : t('sites_yourCollections', 'Your collections'));
  const catalog = new Map((status.catalog?.items ?? status.archive?.catalog ?? []).map(c => [c.id, c.title]));
  const rows: CollectionOverview[] = config.collectionIds.map(id => overview?.collections.find(c => c.id === id) ?? {
    id, title: catalog.get(id) ?? t('sites_collectionUnknown', 'Collection name not available'), destinationTitle: catalog.get(id) ?? '',
    destinationId: null, folder: 'pending', saved: 0, changed: 0, keptDeleted: 0,
  });
  const list = element('overview-mappings'), key = JSON.stringify([rows, !!overview, !!overview?.pendingWrites, rootName]);
  if (list.dataset.rows === key) return; list.dataset.rows = key;
  list.replaceChildren(...rows.map(row => {
    const item = document.createElement('div'); item.className = 'set-row sites-mapping-row'; item.setAttribute('role', 'row');
    const source = document.createElement('button'); source.type = 'button'; source.className = 'sites-mapping-source';
    source.textContent = row.title || catalog.get(row.id) || t('sites_collectionUnknown', 'Collection name not available');
    source.title = t('sites_configureCollection', 'Configure this collection'); source.onclick = () => edit('collections', row.id);
    const destination = document.createElement('div'); destination.className = 'sites-mapping-destination'; destination.setAttribute('role', 'cell');
    const parent = row.destinationParentId && row.destinationParentId !== config.root.nativeId
      ? folderPaths?.get(row.destinationParentId) ?? row.destinationParentTitle ?? t('sites_otherLocation', 'Another local folder') : rootName;
    const preserved = row.preservedLocation;
    const path = preserved ? preserved.firstTitle ? folderPaths?.get(preserved.firstId!) ?? preserved.firstTitle
      : t('sites_preservedLocations', 'Kept in existing locations') : `${parent} / ${row.destinationTitle || source.textContent}`;
    const destinationId = preserved?.firstId ?? (!preserved ? row.destinationId : null);
    if (destinationId) {
      const link = document.createElement('a'); link.textContent = path;
      link.href = chrome.runtime.getURL(`options.html#bookmarks?folder=${encodeURIComponent(destinationId)}`); destination.append(link);
    } else destination.textContent = path;
    const note = document.createElement('span'); note.className = 'set-row-hint';
    note.textContent = !overview ? t('sites_mappingUnknown', 'Not verified') : overview.pendingWrites ? t('sites_mappingUpdating', 'Updating the destination result')
      : preserved ? t('sites_existingCopyLocation', 'Existing copies keep their locations under your copy policy') : row.folder === 'pending' ? t('sites_folderAfterSave', 'Folder is created when items are saved')
      : row.folder === 'missing' ? t('sites_folderMissing', 'Folder is missing; check the mapping') : row.folder === 'review' ? t('sites_folderReview', 'Folder association needs review') : '';
    if (note.textContent) destination.append(note);
    const result = document.createElement('span'); result.className = 'set-row-value sites-mapping-result';
    result.textContent = !overview ? '—' : overview.pendingWrites ? t('sites_mappingSaving', 'Saving…') : row.changed ? t('sites_mappingChanged', '$1 saved · $2 changed locally', count(row.saved), count(row.changed))
      : row.saved ? t('sites_mappingSaved', '$1 saved', count(row.saved)) : row.keptDeleted ? t('sites_mappingKeptDeleted', 'Kept deleted locally') : t('sites_mappingNotSaved', 'Not saved yet');
    const sourceCell = document.createElement('div'); sourceCell.setAttribute('role', 'cell'); sourceCell.append(source); result.setAttribute('role', 'cell');
    item.append(sourceCell, destination, result); return item;
  }));
}
