import { confirmMetadataTransfer } from './metadata-transfer.js';
import type { MetadataPolicyStatus } from './metadata-policy-status.js';
import { PERSONAL_SYNC_PREFIX } from './personal-sync-policy.js';
import { avatarLetter } from './account-label.js';
import { COLLECTIONS_CACHE, parseCollectionsCache, selectPrivateBookmarkLibraries } from './collections-cache.js';
import { createIcon } from './icons.js';
import { t } from './i18n.js';
import { el } from './library-dom.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import type { ExtensionRequest, ExtensionResponse } from './types.js';

export const COLLECTION_BINDING = 'known.sync.collection.v1';

interface CollectionChoice { readonly id: string; readonly title: string; readonly kind: string }

export interface CollectionsHost {
  readonly isConnected: () => boolean;
  /** The signed-in account's label, or the "not signed in" words; used to scope the cached list. */
  readonly accountLabel: () => string;
  readonly request: (message: ExtensionRequest) => Promise<ExtensionResponse>;
  readonly serverOrigin: () => string;
  /** The first-run copy for an empty list; it also opens the create form. */
  readonly emptyCopy: (signedIn: boolean) => string;
  readonly onSelected: (id: string) => void;
  /** The chosen collection's name, or '' while none is chosen. */
  readonly onTitle: (title: string) => void;
  readonly showAccount: () => void;
  readonly openFolders: () => void;
}

/** Sync › Collection: one row per collection you own, a new-collection row and the web link. */
export function bindCollections(host: CollectionsHost) {
  const grid = required('collection-grid');
  const empty = required('collection-empty');
  const emptyCopy = required('collection-empty-copy');
  const signIn = document.getElementById('collection-signin-link') as HTMLAnchorElement | null;
  const feedback = required('collection-feedback');
  const refresh = required('refresh-collections') as HTMLButtonElement;
  const openWeb = required('open-collections') as HTMLAnchorElement;
  const gotoFolders = required('goto-folders') as HTMLButtonElement;
  const fresh = required('library-new');
  const form = required('library-create') as HTMLFormElement;
  const formTitle = required('library-create-title') as HTMLInputElement;
  let loaded = false;
  let selectedTitle = '';
  let policyVersion = 0;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    // A disconnect clears the binding; an earlier "Collection selected." no longer describes this browser.
    if (COLLECTION_BINDING in changes && changes[COLLECTION_BINDING]!.newValue === undefined) say('');
    if (Object.keys(changes).some(key => key === COLLECTION_BINDING || key.startsWith(PERSONAL_SYNC_PREFIX))) void renderSelected();
  });

  refresh.addEventListener('click', () => { void load(true); });
  gotoFolders.addEventListener('click', host.openFolders);
  signIn?.addEventListener('click', (event) => { event.preventDefault(); host.showAccount(); });
  openWeb.addEventListener('click', (event) => { event.preventDefault(); void openMine(); });
  required('library-create-open').addEventListener('click', () => { form.hidden = false; formTitle.focus(); });
  required('library-create-cancel').addEventListener('click', () => { form.hidden = true; formTitle.value = ''; required('library-create-open').focus(); });

  async function openMine(): Promise<void> {
    const base = host.serverOrigin().replace(/\/$/u, '');
    await chrome.tabs.create({ url: `${base}/library` });
    say(t('options_createOpenCollectionOwn', 'Create or open a collection you own on the web, then refresh this list.'));
  }
  function say(message: string, tone: '' | 'ok' | 'error' = ''): void {
    feedback.dataset.tone = tone;
    feedback.textContent = message;
  }
  function showEmpty(copy: string): void {
    emptyCopy.textContent = copy;
    empty.hidden = false;
    grid.hidden = true;
    if (signIn) signIn.hidden = host.isConnected() || !copy.includes(t('common_signIn', 'Sign in'));
  }
  function signedInHint(): string {
    const status = document.body.dataset.state;
    return status === 'connected' || status === 'connecting' || status === 'refreshing'
      ? t('options_loadingYourCollections', 'Loading your collections…')
      : t('firstRun_signSeeCollectionsOwn', 'Sign in to see collections you own.');
  }

  function renderGrid(collections: readonly CollectionChoice[]): void {
    grid.replaceChildren();
    for (const collection of collections) {
      const name = collection.title || collection.id;
      const row = el('div', undefined, 'set-row collection-row');
      row.dataset.id = collection.id; row.dataset.title = name;
      const mark = el('span', avatarLetter(name), 'avatar'); mark.setAttribute('aria-hidden', 'true');
      const text = el('div', undefined, 'set-row-text'); text.append(el('p', name, 'set-row-title'));
      const policy = el('p', undefined, 'set-row-hint'); policy.dataset.role = 'metadata-policy'; policy.hidden = true;
      text.append(policy);
      const control = el('div', undefined, 'set-row-control');
      const here = el('span', undefined, 'set-row-value'); here.dataset.role = 'here'; here.hidden = true;
      const hereLabel = el('span', t('sync_syncingHere', 'Syncing here')); hereLabel.dataset.role = 'here-label';
      here.append(createIcon('check', 16), hereLabel);
      const choose = el('button', t('sync_useCollection', 'Use this collection'), 'btn btn-secondary btn-sm collection-choice');
      choose.type = 'button'; choose.dataset.id = collection.id; choose.dataset.title = name;
      choose.setAttribute('aria-label', t('sync_useNamed', 'Use $1 as the collection', name));
      choose.addEventListener('click', () => { void pick(collection.id); });
      const metadata = el('button', t('metadata_transferTitle', 'Connect browser metadata'), 'btn btn-ghost btn-sm');
      metadata.type = 'button'; metadata.dataset.role = 'metadata'; metadata.hidden = true;
      metadata.addEventListener('click', () => { void pick(collection.id); });
      control.append(here, choose, metadata);
      row.append(mark, text, control);
      grid.append(row);
    }
    empty.hidden = true;
    grid.hidden = false;
    void renderSelected();
  }

  async function pick(id: string): Promise<void> {
    const previous = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
    const migrateMetadata = await confirmMetadataTransfer().catch(() => undefined);
    if (migrateMetadata === undefined) return;
    const response = await host.request({ kind: 'known.collection.select', collectionId: id, userGesture: true,
      ...(migrateMetadata ? { migrateMetadata: true } : {}) });
    say(response.ok ? t('common_collectionSelected', 'Collection selected.')
      : t('options_couldntSelectCollectionRefresh', "Couldn't select this collection. Refresh the list and try again."), response.ok ? 'ok' : 'error');
    if (response.ok) host.onSelected(id);
    await renderSelected();
    // Nothing syncs until folders are chosen, so a new connection continues there; a metadata change stays here.
    if (response.ok && previous !== id && !await firstSyncStarted()) host.openFolders();
  }

  /** Marks the chosen row, shows the folders shortcut and tells the page which collection is in use. */
  async function renderSelected(): Promise<void> {
    const version = ++policyVersion;
    const value = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
    const valid = isProtocolOpaqueId(value);
    const id = typeof value === 'string' ? value : '';
    selectedTitle = '';
    for (const row of Array.from(grid.querySelectorAll<HTMLElement>('.collection-row'))) {
      const chosen = row.dataset.id === id;
      if (chosen) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      row.querySelector<HTMLElement>('[data-role="here"]')!.hidden = !chosen;
      row.querySelector<HTMLElement>('.collection-choice')!.hidden = chosen;
      row.querySelector<HTMLElement>('[data-role="metadata"]')!.hidden = !chosen;
      row.querySelector<HTMLElement>('[data-role="metadata-policy"]')!.hidden = !chosen;
      if (chosen) selectedTitle = row.dataset.title ?? '';
    }
    document.body.dataset.collection = valid ? 'ready' : '';
    gotoFolders.hidden = !valid;
    host.onTitle(valid ? selectedTitle : '');
    if (!valid) return;
    const result = await chrome.runtime.sendMessage({ kind: 'known.metadataSync.status' }).catch(() => undefined) as MetadataPolicyStatus | undefined;
    const personal = await chrome.runtime.sendMessage({ kind: 'known.personalSync.status' }).catch(() => undefined) as
      { policy?: { mode?: string }; collectionId?: string } | undefined;
    const started = await firstSyncStarted();
    if (version !== policyVersion) return;
    if (personal?.collectionId === id && personal.policy?.mode === 'target-unavailable') {
      document.body.dataset.collection = ''; gotoFolders.hidden = true;
    }
    const row = Array.from(grid.querySelectorAll<HTMLElement>('.collection-row')).find(row => row.dataset.id === id);
    const hereLabel = row?.querySelector<HTMLElement>('[data-role="here-label"]');
    const paused = personal?.collectionId === id && personal.policy?.mode === 'paused';
    if (hereLabel) {
      hereLabel.textContent = paused ? t('sync_pausedHere', 'Paused here') : started ? t('sync_syncingHere', 'Syncing here') : t('sync_selectedHere', 'Selected');
      // A tick says all is well; a paused collection shows the pause it is in.
      hereLabel.previousElementSibling?.replaceWith(createIcon(paused ? 'pause' : 'check', 16));
    }
    const hint = row?.querySelector<HTMLElement>('[data-role="metadata-policy"]');
    if (hint) hint.textContent = !result?.ok || result.collectionId !== id
      ? t('metadata_statusUnavailable', 'Browser metadata sync status could not be read. Refresh to try again.')
      : result.consentRequired
        ? t('metadata_consentRequired', 'Browser metadata stays local until you explicitly choose to connect it. Existing connections need this choice after upgrading.')
        : result.mode === 'sync'
          ? t('metadata_statusSync', 'Browser metadata sync is enabled. Use Connect browser metadata to change this choice.')
          : t('metadata_statusLocal', 'Browser metadata stays local. Use Connect browser metadata to change this choice.');
  }

  async function firstSyncStarted(): Promise<boolean> {
    const status = await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }).catch(() => undefined) as { ok?: boolean; firstRun?: string } | undefined;
    return !status?.ok || (status.firstRun !== 'none' && status.firstRun !== 'deferred');
  }

  async function load(force = false): Promise<void> {
    refresh.disabled = !host.isConnected();
    fresh.hidden = !host.isConnected();
    if (!host.isConnected()) {
      loaded = false;
      showEmpty(signedInHint());
      return;
    }
    if (loaded && !force) return;
    if (!force) {
      const label = host.accountLabel();
      const cached = selectPrivateBookmarkLibraries(parseCollectionsCache(
        (await chrome.storage.local.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE],
        label && label !== t('sync_notSignedIn', 'Not signed in') && label !== t('common_signedIn', 'Signed in') ? { accountLabel: label } : undefined,
      ) ?? []);
      if (cached.length > 0) { renderGrid(cached); loaded = true; }
      else showEmpty(t('options_loadingYourCollections', 'Loading your collections…'));
    } else {
      showEmpty(t('options_loadingYourCollections', 'Loading your collections…'));
    }
    loaded = true;
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.collections.list' }) as
        { readonly ok: true; readonly collections: readonly CollectionChoice[] }
        | { readonly ok: false; readonly error: string } | undefined;
      if (!response?.ok) {
        if (grid.childElementCount > 0) { loaded = true; return; }
        loaded = false;
        showEmpty(response?.error === 'authentication_required' && document.body.dataset.state !== 'connected'
          ? t('firstRun_signSeeCollectionsOwn', 'Sign in to see collections you own.')
          : t('options_collectionsCouldNotLoaded', 'Collections could not be loaded. Refresh the list to try again.'));
        return;
      }
      if (!response.collections || response.collections.length === 0) {
        grid.replaceChildren();
        grid.hidden = true;
        showEmpty(host.emptyCopy(true));
        await renderSelected();
        return;
      }
      renderGrid(response.collections);
    } catch {
      if (grid.childElementCount > 0) { loaded = true; return; }
      loaded = false;
      showEmpty(t('options_collectionsCouldNotLoaded', 'Collections could not be loaded. Refresh the list to try again.'));
    }
  }

  return {
    load,
    renderSelected,
    hasRows: () => grid.childElementCount > 0,
    /** Signed out (or signing in): forget the list and say why it is empty. */
    reset(signedInView: boolean): void {
      policyVersion++;
      loaded = false; selectedTitle = ''; grid.replaceChildren(); grid.hidden = true; fresh.hidden = true;
      refresh.disabled = true;
      showEmpty(signedInView ? t('options_loadingYourCollections', 'Loading your collections…') : t('firstRun_signSeeCollectionsOwn', 'Sign in to see collections you own.'));
    },
    setConnected(connected: boolean, origin: string): void {
      refresh.disabled = !connected; fresh.hidden = !connected;
      openWeb.href = `${origin.replace(/\/$/u, '')}/library`;
    },
  };
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('options_markup_invalid');
  return value;
}
