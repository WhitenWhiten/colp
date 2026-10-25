import { localized, t } from '../i18n.js';
import type { Mapping, SourcePage, SourceRef, SourceView, ProjectionNode, SnapshotDescriptor } from '../bookmark-subscriptions/contracts.js';
import type { Draft, LocalMapping } from '../bookmark-subscriptions/local-types.js';
import type { BookmarkPreferencesResponse } from '../types.js';
import type { ListResult } from './list.js';
import type { DirectoryDefaults } from './directories.js';
import type { MountInput, Send } from './client.js';
import { button, el, errorCopy, facts, field, heading, link, rssTile, select, status } from './dom.js';
import { emptyBlock, searchCompact, selectOf, selectPill } from '../library-dom.js';
import { contentSettings, renderProjection, type ContentSettings } from './content-settings.js';
import { createNativePicker, type FolderSelection } from './native-picker.js';
type Preview = { descriptor: SnapshotDescriptor; nodes: ProjectionNode[] };
let visibility: Record<string, string>;
localized(() => {
  visibility = { private: t('subscription_visibility_private', 'Private'), protected: t('subscription_visibility_protected', 'Members only'), unlisted: t('subscription_visibility_unlisted', 'Unlisted'), public: t('subscription_visibility_public', 'Public') };
});
type MountPreview = Preview & { token: string; expiresAt: string | number; input: MountInput };
export function createWizard(host: HTMLElement, send: Send, navigate: (hash: string) => void, initial?: SourceRef, externalDraftId?: string) {
  let defaultInsertIndex: number | undefined; let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, step = 0, source: SourceView | undefined, selection: FolderSelection | undefined, alias = '', parentDraftTitle = '', busy = false;
  let settings: ContentSettings = { digestMode: 'latest', editionLimit: 1, checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'inherit' } };
  let preview: Preview | undefined, confirmation: MountPreview | undefined, confirmRequestId = crypto.randomUUID();
  let accountPolicy: { onUnfollow?: 'keep'|'remove'; onUnsubscribe?: 'keep'|'remove' } = {}, policyUnconfirmed = false;
  let picker: ReturnType<typeof createNativePicker> | undefined;
  const feedback = status(), body = el('div', undefined, 'subscription-wizard-body'), progress = el('ol', undefined, 'subscription-steps'), actions = el('div', undefined, 'section-commands');
  let saving = Promise.resolve();
  function persist() {
    if (!source) return saving;
    const value: Partial<MountInput> = { sourceType: source.sourceType, sourceId: source.sourceId, ...settings, localAlias: alias, ...(parentDraftTitle.trim() ? { parentDraft: { title: parentDraftTitle.trim() } } : {}), ...(selection ? { parentNativeId: selection.id, ...(selection.index === undefined ? {} : { index: selection.index }) } : {}) };
    const version = generation; saving = saving.catch(() => undefined).then(() => alive(version) ? send({ kind: 'wizardDraft', value }) : undefined).then(() => undefined);
    void saving.catch(error => { if (alive(version)) feedback.textContent = errorCopy(error); }); return saving;
  }
  const previous = button(t('subscription_back', 'Back'), () => { if (step > 0 && !busy) { const value = readSettings?.(); if (value) settings = value; void persist(); step--; paint(); } });
  const cancel = button(t('common_cancel', 'Cancel'), () => { if (!busy) void guarded(async () => { const value = readSettings?.(); if (value) settings = value; await saving.catch(() => undefined); await send({ kind: 'wizardDraft', value: null }); navigate('#subscriptions/list'); }); });
  cancel.className = 'btn btn-ghost';
  const next = button(t('subscription_next', 'Next'), () => { void advance(); }, true);
  const footer = el('div', undefined, 'subscription-wizard-actions'); actions.append(previous, cancel); footer.append(actions, next);
  host.replaceChildren(progress, feedback, body, footer);
  let readSettings: (() => ContentSettings | null) | undefined;
  const alive = (version: number) => generation === version;
  function setBusy(value: boolean) { busy = value; next.disabled = value || step === 1 && (!preview || expire(preview.descriptor.expiresAt)); previous.disabled = value || step === 0; cancel.disabled = value; }
  function expire(value: string | number) { return new Date(value).getTime() <= Date.now(); }
  async function guarded(run: () => Promise<void>) { if (busy) return; setBusy(true); const version = generation; try { await run(); } catch (error) { if (alive(version)) feedback.textContent = errorCopy(error); } finally { if (alive(version)) setBusy(false); } }
  async function existing(ref: SourceRef) {
    let cursor: string | undefined; let count = 0; const visited = new Set<string>();
    do {
      const page = await send<ListResult>(cursor ? { kind: 'list', cursor } : { kind: 'list', scope: 'this_browser', status: 'live' });
      const mapping = page.mappings.items.find(item => item.sourceRef.sourceType === ref.sourceType && item.sourceRef.sourceId === ref.sourceId);
      if (mapping) return mapping.mappingId;
      count += page.mappings.items.length; cursor = page.mappings.nextCursor ?? undefined;
      if (cursor && (visited.has(cursor) || count >= 50)) throw new Error('mapping_page_limit'); if (cursor) visited.add(cursor);
    } while (cursor);
    return null;
  }
  async function pick(ref: SourceRef) {
    const version = generation;
    const mappingId = await existing(ref); if (!alive(version)) return; if (mappingId) { navigate('#subscriptions/detail?mapping=' + mappingId); return; }
    const value = await send<SourceView>({ kind: 'source', sourceType: ref.sourceType, sourceId: ref.sourceId }); if (!alive(version)) return;
    source = value; alias = value.title; preview = undefined; confirmation = undefined;
    settings = { ...settings, digestMode: value.sourceType === 'digest_series' ? settings.digestMode ?? 'latest' : null, editionLimit: value.sourceType === 'digest_series' ? settings.digestMode === 'recent' ? settings.editionLimit ?? 10 : 1 : null };
    step = 1; await persist(); if (!alive(version)) return; try { preview = await sourcePreview(); if (alive(version)) paint(); } catch (error) { if (alive(version)) { paint(); throw error; } }
  }
  function paint() {
    clearTimeout(previewTimer); picker?.dispose(); picker = undefined; readSettings = undefined; body.replaceChildren(); body.dataset.step = String(step); feedback.textContent = '';
    progress.replaceChildren(...[t('subscription_stepSource', 'Choose source'), t('subscription_stepContent', 'Choose content'), t('subscription_stepLocation', 'Choose location'), t('subscription_stepReview', 'Review and add')].map((label, index) => { const row = el('li'); row.append(el('span', String(index + 1), 'subscription-step-index'), el('span', label)); if (step === index) row.setAttribute('aria-current', 'step'); else if (index < step) row.dataset.state = 'done'; return row; }));
    previous.disabled = step === 0; previous.hidden = step === 0; next.hidden = step === 0; next.textContent = step === 3 ? t('subscription_enable', 'Add folder') : t('subscription_next', 'Next');
    if (step === 0) renderSources();
    if (step === 1 && source) {
      body.append(heading('h3', source.title), el('p', t('subscription_readOnlyHint', 'Read-only. Save your own bookmarks in your own folders.'), 'subscription-card-meta'));
      const fields = el('div', undefined, 'subscription-fields'); body.append(fields);
      readSettings = contentSettings(fields, source.sourceType === 'digest_series', settings, () => { preview = undefined; confirmation = undefined; next.disabled = true; clearTimeout(previewTimer); const value = readSettings?.(); if (value) { settings = value; void persist(); } feedback.textContent = t('subscription_refreshPreviewHint', 'Refresh the preview to see the new content.'); });
      const projection = el('div');
      const refresh = button(t('subscription_refreshPreview', 'Refresh preview'), () => { void guarded(async () => { const value = readSettings?.(); if (!value) return; settings = value; const version = generation; const result = await sourcePreview(); if (alive(version)) { preview = result; paint(); } }); }); refresh.classList.add('btn-sm'); const previewRow = el('div', undefined, 'subscription-preview-row'); previewRow.append(el('h4', t('subscription_contentPreview', 'What will be added')), refresh); body.append(previewRow, projection);
      if (preview) renderProjection(projection, preview);
      if (preview && !expire(preview.descriptor.expiresAt)) previewTimer = setTimeout(() => { if (step !== 1) return; preview = undefined; next.disabled = true; feedback.textContent = t('subscription_refreshPreviewHint', 'Refresh the preview to see the new content.'); }, Math.max(0, new Date(preview.descriptor.expiresAt).getTime() - Date.now()));
      next.disabled = busy || !preview || expire(preview.descriptor.expiresAt);
    }
    if (step === 2 && source) {
      body.append(el('p', t('subscription_mountHint', 'Know-N creates a new read-only folder when you confirm. Your existing folders are never taken over.'), 'subscription-note'));
      const names = el('div', undefined, 'subscription-fields'); body.append(names);
      const name = el('input'); name.value = alias; name.maxLength = 255; name.required = true; name.addEventListener('input', () => { alias = name.value; confirmation = undefined; void persist(); });
      names.append(field(t('subscription_folderName', 'Folder name'), name));
      const parentName = el('input'); parentName.value = parentDraftTitle; parentName.maxLength = 255; parentName.addEventListener('input', () => { parentDraftTitle = parentName.value; confirmation = undefined; void persist(); }); const parentField = field(t('subscription_newParent', 'New folder inside it (optional)'), parentName); parentField.append(el('p', t('subscription_newParentDraft', 'Leave empty to use the folder you picked. The new folder is only created when you confirm.'), 'field-hint')); names.append(parentField);
      const pickerHost = el('div'); body.append(pickerHost); picker = createNativePicker(pickerHost, send, value => { selection = value; confirmation = undefined; void persist(); }, selection, defaultInsertIndex);
    }
    if (step === 3 && source && selection) {
      body.append(heading('h3', source.title), el('p', t('subscription_readOnly', 'Read-only') + ' · ' + (source.owner?.displayName ?? t('subscription_authorUnknown', 'Author unavailable')), 'subscription-card-meta'),
        facts([[t('subscription_newFolder', 'New folder'), selection.path + (parentDraftTitle.trim() ? ' › ' + parentDraftTitle.trim() : '') + ' › ' + alias], [t('subscription_interval', 'Check interval'), settings.checkIntervalMinutes === null ? t('common_manual', 'Manual') : t('subscription_minutesShort', '$1 min', settings.checkIntervalMinutes)]], 'facts'));
      const projection = el('div'); if (confirmation ?? preview) renderProjection(projection, (confirmation ?? preview)!); body.append(projection);
      const policies = el('details', undefined, 'disclosure subscription-disclosure'), effective = el('p', undefined, 'field-hint'); policies.append(el('summary', t('subscription_overrides', 'When you leave this subscription')));
      const options = [['inherit', t('subscription_inherit', 'Use my default')], ['keep', t('subscription_keep', 'Keep the bookmarks as your own')], ['remove', t('subscription_remove', 'Delete the folder')]] as const;
      const unfollow = select(options, settings.exitPolicy.onUnfollow), unsubscribe = select(options, settings.exitPolicy.onUnsubscribe);
      const policyText = (value: 'inherit'|'keep'|'remove', inherited?: 'keep'|'remove') => (value === 'inherit' ? t('subscription_inherit', 'Use my default') + ': ' : '') + ((value === 'inherit' ? inherited : value) === 'keep' ? t('subscription_keep', 'Keep the bookmarks as your own') : (value === 'inherit' ? inherited : value) === 'remove' ? t('subscription_remove', 'Delete the folder') : t('common_unknown', 'Unknown'));
      const paintPolicy = () => { effective.textContent = t('subscription_afterUnfollow', 'When you unfollow') + ': ' + policyText(settings.exitPolicy.onUnfollow, accountPolicy.onUnfollow) + ' · ' + t('subscription_afterUnsubscribe', 'When you unsubscribe') + ': ' + policyText(settings.exitPolicy.onUnsubscribe, accountPolicy.onUnsubscribe) + (policyUnconfirmed ? ' · ' + t('subscription_policyUnconfirmed', "your default hasn't finished syncing") : ''); };
      const changePolicy = () => { settings.exitPolicy = { onUnfollow: unfollow.value as 'inherit'|'keep'|'remove', onUnsubscribe: unsubscribe.value as 'inherit'|'keep'|'remove' }; confirmation = undefined; paintPolicy(); next.textContent = t('subscription_reviewChanges', 'Review changes'); void persist(); };
      unfollow.addEventListener('change', changePolicy); unsubscribe.addEventListener('change', changePolicy); paintPolicy();
      policies.append(field(t('subscription_afterUnfollow', 'When you unfollow'), unfollow), field(t('subscription_afterUnsubscribe', 'When you unsubscribe'), unsubscribe));
      const globals = link(t('subscription_globalPreferences', 'Default settings'), '#subscriptions/list'); globals.classList.add('btn-sm');
      body.append(policies, effective, globals, el('p', t('subscription_nativeSyncWarning', "If your browser also syncs bookmarks, private content can appear in your other profiles. Don't add the same subscription in two synced profiles."), 'subscription-note'));

    }
  }
  function renderSources() {
    const search = searchCompact(t('subscription_sourceSearch', 'Search title or author')); search.input.maxLength = 100;
    const type = selectOf([['', t('subscription_allTypes', 'All source types')], ['collection', t('subscription_collections', 'Collections')], ['digest_series', t('subscription_digest', 'Digest')]], '');
    const relation = selectOf([['', t('subscription_allRelations', 'Followed and shared')], ['followed', t('subscription_followed', 'Followed')], ['shared', t('subscription_shared', 'Shared with me')]], '');
    const form = el('form', undefined, 'toolbar'), rows = el('div', undefined, 'list-card subscription-source-list'), more = button(t('subscription_showMore', 'Show more'), () => { void load(cursor); }); let cursor: string | null = null, sourceQuery = 0; more.className = 'btn btn-ghost btn-sm';
    form.append(search.field, selectPill(t('subscription_sourceType', 'Source type'), type), selectPill(t('subscription_relationship', 'Relationship'), relation));
    form.addEventListener('submit', event => { event.preventDefault(); void load(); });
    let typing: ReturnType<typeof setTimeout> | undefined; search.input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { void load(); }, 300); });
    for (const control of [type, relation]) control.addEventListener('change', () => { void load(); });
    body.append(form, rows, more, el('p', t('subscription_acceptedShare', "Don't see a shared collection? Accept the invitation on the Know-N website first."), 'field-hint'));
    async function load(nextCursor?: string | null) { const version = generation, queryVersion = ++sourceQuery; more.disabled = true; try {
      const page = await send<SourcePage>(nextCursor ? { kind: 'sources', cursor: nextCursor } : { kind: 'sources', ...(search.input.value.trim() ? { q: search.input.value.trim() } : {}), ...(type.value ? { sourceType: type.value as SourceRef['sourceType'] } : {}), ...(relation.value ? { relation: relation.value as 'followed'|'shared' } : {}) });
      if (!alive(version) || step !== 0 || queryVersion !== sourceQuery) return; if (!nextCursor) rows.replaceChildren(); cursor = page.nextCursor; more.hidden = !cursor;
      for (const item of page.items) {
        const row = el('div', undefined, 'subscription-source-row'), copy = el('div', undefined, 'list-row-main');
        copy.append(el('span', item.title, 'list-row-title'), el('span', [item.owner?.displayName ?? t('subscription_authorUnknown', 'Author unavailable'), item.sourceType === 'digest_series' ? t('subscription_digest', 'Digest') : t('common_collection', 'Collection'), visibility[item.visibility] ?? item.visibility].join(' · '), 'list-row-meta'));
        const pick_ = button(t('subscription_choose', 'Choose'), () => { void guarded(() => pick(item)); }); pick_.classList.add('btn-sm'); row.append(rssTile(), copy, pick_); rows.append(row);
      }
      if (!rows.children.length) rows.append(emptyBlock({ icon: 'search', title: t('subscription_noSources', 'Nothing matches. Try a different search or filter.') }));
    } catch (error) { if (alive(version)) feedback.textContent = errorCopy(error); } finally { if (alive(version)) more.disabled = false; } }
    void load();
  }
  async function sourcePreview(): Promise<Preview> {
    if (!source) throw new Error('source_required');
    const contentKey = JSON.stringify([source.sourceType, source.sourceId, settings]);
    const result = await send<Preview>({ kind: 'sourcePreview', sourceType: source.sourceType, sourceId: source.sourceId, digestMode: settings.digestMode, editionLimit: settings.editionLimit });
    if (contentKey !== JSON.stringify([source.sourceType, source.sourceId, settings])) throw new Error('preview_changed');
    if (expire(result.descriptor.expiresAt) || result.nodes.length !== result.descriptor.counts.nodes) throw new Error('snapshot_expired'); return result;
  }
  async function advance() { await guarded(async () => {
    const version = generation;
    if (step === 1) { const value = readSettings?.(); if (!value) return; settings = value; await persist(); if (!alive(version)) return; if (!preview || expire(preview.descriptor.expiresAt)) { preview = undefined; feedback.textContent = t('subscription_refreshPreviewHint', 'Refresh the preview to see the new content.'); return; } if (alive(version)) { step = 2; paint(); } }
    else if (step === 2 && source) {
      if (!selection || !alias.trim()) { feedback.textContent = t('subscription_locationRequired', 'Pick a folder and enter a name.'); return; }
      const result = await send<MountPreview>({ kind: 'mountPreview', sourceType: source.sourceType, sourceId: source.sourceId, ...settings, parentNativeId: selection.id, ...(selection.index === undefined ? {} : { index: selection.index }), localAlias: alias.trim(), ...(parentDraftTitle.trim() ? { parentDraft: { title: parentDraftTitle.trim() } } : {}), profileLabel: t('common_thisBrowser', 'This browser') });
      if (alive(version)) { confirmation = result; confirmRequestId = crypto.randomUUID(); step = 3; paint(); }
    } else if (step === 3 && source && selection) {
      if (!confirmation) { const result = await send<MountPreview>({ kind: 'mountPreview', sourceType: source.sourceType, sourceId: source.sourceId, ...settings, parentNativeId: selection.id, ...(selection.index === undefined ? {} : { index: selection.index }), localAlias: alias.trim(), ...(parentDraftTitle.trim() ? { parentDraft: { title: parentDraftTitle.trim() } } : {}), profileLabel: t('common_thisBrowser', 'This browser') }); if (alive(version)) { confirmation = result; confirmRequestId = crypto.randomUUID(); paint(); } return; }
      if (expire(confirmation.expiresAt)) { confirmation = undefined; step = 2; paint(); feedback.textContent = t('subscription_previewExpired', 'The preview expired. Review the location again.'); return; }
      const result = await send<{ mapping: Mapping; local: LocalMapping }>({ kind: 'mountConfirm', token: confirmation.token }, confirmRequestId);
      if (alive(version)) { await saving.catch(() => undefined); await send({ kind: 'wizardDraft', value: null }); navigate('#subscriptions/detail?mapping=' + encodeURIComponent(result.mapping.mappingId)); }
    }
  }); }
  const initialization = generation; feedback.textContent = t('common_loading', 'Loading…');
  void (async () => {
    const version = generation;
    const [prefs, saved, defaults, external] = await Promise.all([
      chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }).catch(() => null) as Promise<BookmarkPreferencesResponse | null>,
      send<Partial<MountInput> | null>({ kind: 'wizardDraft' }).catch(() => null),
      send<DirectoryDefaults>({ kind: 'directoryDefaults' }).catch(() => null),
      initial ? Promise.resolve(initial) : externalDraftId ? send<Draft | null>({ kind: 'draft' }).then(draft => draft?.requestId === externalDraftId ? draft : null).catch(() => null) : Promise.resolve(null),
    ]);
    if (!alive(version)) return;
    if (prefs?.ok) { const p = prefs.preferences; defaultInsertIndex = p.bookmarkInsertPosition === 'top' ? 0 : undefined; accountPolicy = { onUnfollow: p.subscriptionOnUnfollow, onUnsubscribe: p.subscriptionOnUnsubscribe }; policyUnconfirmed = !!(prefs.pending || prefs.conflict); settings = { ...settings, checkIntervalMinutes: p.subscriptionDefaultCheckIntervalMinutes === undefined ? 15 : p.subscriptionDefaultCheckIntervalMinutes, digestMode: p.subscriptionDefaultDigestMode ?? 'latest', editionLimit: p.subscriptionDefaultDigestMode === 'recent' ? p.subscriptionDefaultEditionLimit ?? 10 : 1 }; }
    const restore = saved?.sourceType && saved.sourceId && (!external || external.sourceId === saved.sourceId && external.sourceType === saved.sourceType) ? saved : null;
    const ref = external ?? (restore ? { sourceType: restore.sourceType!, sourceId: restore.sourceId! } : undefined);
    if (ref) {
      const mappingId = await existing(ref); if (!alive(version)) return; if (mappingId) { navigate('#subscriptions/detail?mapping=' + mappingId); return; }
      source = await send<SourceView>({ kind: 'source', sourceType: ref.sourceType, sourceId: ref.sourceId }); if (!alive(version)) return;
      alias = restore?.localAlias ?? source.title; parentDraftTitle = restore?.parentDraft?.title ?? '';
      settings = { digestMode: source.sourceType === 'digest_series' ? restore?.digestMode ?? settings.digestMode : null, editionLimit: source.sourceType === 'digest_series' ? restore?.editionLimit ?? settings.editionLimit : null, checkIntervalMinutes: restore?.checkIntervalMinutes === undefined ? settings.checkIntervalMinutes : restore.checkIntervalMinutes, exitPolicy: restore?.exitPolicy ?? settings.exitPolicy };
      step = 1;
    }
    const parent = restore?.parentNativeId ?? defaults?.mountParentNativeId;
    if (parent) selection = { id: parent, path: t('subscription_savedLocation', 'Your saved default (checked before adding)'), ...((restore ? restore.index : defaultInsertIndex) === undefined ? {} : { index: restore ? restore.index : defaultInsertIndex }) };
    if (source && step === 1) { try { preview = await sourcePreview(); } catch (error) { if (alive(version)) { paint(); feedback.textContent = errorCopy(error); } return; } }
    if (alive(version)) paint();
  })().catch(error => { if (alive(initialization)) { paint(); feedback.textContent = errorCopy(error); } });
  return { dispose() { generation++; clearTimeout(previewTimer); picker?.dispose(); host.replaceChildren(); } };
}
