import { t } from '../i18n.js';
import type { ExitBatch, ExitPreview, Mapping, MappingListItem, SourceView, SourceRef, ProjectionNode, SnapshotDescriptor } from '../bookmark-subscriptions/contracts.js';
import { appendRuntimeNotes, appendRuntimeSummary, runtimeChanging, runtimeFacts, type LocalSummary } from './runtime-summary.js';
import { createIcon } from '../icons.js';
import type { BookmarkPreferencesResponse } from '../types.js';
import type { Send } from './client.js';
import { button, date, el, errorCopy, facts, field, heading, link, modal, pill, section, select, status } from './dom.js';
import { openRecovery } from './recovery.js';
import { stateLabel, stateTone } from './list.js';
import { contentSettings, renderProjection } from './content-settings.js';
import { createNativePicker, type FolderSelection } from './native-picker.js';
export type MappingDetail = { mapping: Mapping | MappingListItem; etag: string; local: LocalSummary | null; source?: SourceView | null; sourceRef?: SourceRef };
export function createMappingDetail(host: HTMLElement, send: Send, mappingId: string, _navigate: (hash: string) => void, returnTo = 'subscriptions/list') {
  let timer: ReturnType<typeof setTimeout> | undefined; let disposed = false;
  let generation = 0, current: MappingDetail | undefined;
  const feedback = status(), body = el('div', undefined, 'subscription-detail'), back = link(t('subscription_backList', 'Back to subscriptions'), '#' + returnTo);
  back.classList.add('btn-sm', 'subscription-back'); back.prepend(createIcon('arrow-left', 14)); host.replaceChildren(back, feedback, body);
  async function load() { clearTimeout(timer); const version = ++generation; feedback.textContent = t('common_loading', 'Loading…'); try { const value = await send<MappingDetail>({ kind: 'mapping', mappingId }); if (value.sourceRef) value.source = await send<SourceView>({ kind: 'source', ...value.sourceRef }).catch(() => null); if (version !== generation) return; current = value; paint(value); feedback.textContent = ''; if (runtimeChanging(value.local)) schedule(); } catch (error) { if (version === generation) feedback.textContent = errorCopy(error); } }
  function schedule() { clearTimeout(timer); if (disposed) return; timer = setTimeout(() => { if (document.hidden || document.querySelector('.subscription-dialog') || body.contains(document.activeElement)) schedule(); else void load(); }, 5000); }
  async function action(kind: 'refresh'|'pause'|'resume'|'locate'|'repair') { const version = generation; try { await send({ kind, mappingId, expectedGeneration: current?.mapping.generation }); if (version === generation) await load(); } catch (error) { if (version === generation) feedback.textContent = errorCopy(error); } }
  function paint(value: MappingDetail) {
    const { mapping, local } = value; const source = value.source ?? ('source' in mapping ? mapping.source : null);
    const summary = el('section', undefined, 'subscription-card subscription-detail-head');
    summary.append(heading('h3', source?.title ?? local?.localAlias ?? t('subscription_unavailableSource', 'Source unavailable'), local ? pill(stateLabel(local.state), stateTone(local.state)) : pill(mapping.profileLabel, 'muted')),
      el('p', (source?.owner?.displayName ? source.owner.displayName + ' · ' : '') + t('subscription_readOnlyHint', 'Read-only. Save your own bookmarks in your own folders.'), 'subscription-card-meta'));
    const actions = el('div', undefined, 'section-commands subscription-card-actions');
    if (mapping.status === 'active' && local) actions.append(button(t('subscription_refreshNow', 'Update now'), () => { void action('refresh'); }), button(local?.enabled ? t('subscription_pause', 'Pause this browser') : t('subscription_resume', 'Resume this browser'), () => { void action(local?.enabled ? 'pause' : 'resume'); }));
    if (local?.state === 'permission_required') actions.append(button(t('common_allowBookmarkAccess', 'Allow bookmark access'), () => {
      const version = generation; const request = chrome.permissions.request({ permissions: ['bookmarks'] });
      void request.then(allowed => { if (version !== generation) return; if (allowed) void action('repair'); else feedback.textContent = t('subscription_permissionDenied', 'Bookmark access is still off. No folder was created.'); }).catch(error => { if (version === generation) feedback.textContent = errorCopy(error); });
    }, true));
    if (local?.state === 'sign_in_required') { const signIn = link(t('subscription_signInAccount', 'Review account and sign in'), '#account'); signIn.className = 'btn btn-primary'; actions.append(signIn); }
    if (local?.rootNativeId) actions.append(button(t('subscription_locate', 'Locate folder'), () => { void action('locate'); }));
    if (source) actions.append(link(t('subscription_openSource', 'Open source'), source.openUrl));
    actions.append(link(t('subscription_diagnostics', 'Diagnostics'), '#help?category=subscriptions&mapping=' + mappingId));
    for (const node of Array.from(actions.children)) node.classList.add('btn-sm');
    summary.append(actions); body.replaceChildren(summary);
    if (local && ['local_change', 'repair_pending', 'target_missing'].includes(local.state)) {
      const recovery = el('section', undefined, 'subscription-callout'); recovery.dataset.tone = 'attention';
      recovery.append(el('h4', t('subscription_recoveryTitle', 'Updates are paused')), el('p', t('subscription_recoveryHint', 'Updates to this folder are paused because its bookmarks were changed here. Undo your changes, or keep a copy and remove the subscription. Nothing happens until you confirm.')));
      const fixes = el('div', undefined, 'section-commands');
      fixes.append(button(t('subscription_restoreSource', 'Undo my changes'), () => openRecovery(send, value, 'restore', load), true));
      if (local.state !== 'target_missing') fixes.append(button(t('subscription_copyDetach', 'Keep a copy and remove'), () => openRecovery(send, value, 'copy_detach', load)));
      fixes.append(button(t('subscription_repair', 'Recheck recovery'), () => { void action('repair'); }));
      for (const node of Array.from(fixes.children)) node.classList.add('btn-sm');
      recovery.append(fixes); body.append(recovery);
    }
    const state = section(t('subscription_status', 'Status'));
    state.append(facts([[t('subscription_state', 'State'), local ? stateLabel(local.state) : t('subscription_remoteConfigured', 'Added on another browser. That browser reports its own status.')], [t('subscription_lastChecked', 'Last checked'), date(local?.lastCheckedAt)], [t('subscription_lastUpdated', 'Content updated'), date(local?.lastUpdatedAt)], [t('subscription_nextCheck', 'Next expected check'), mapping.checkIntervalMinutes === null ? t('common_manual', 'Manual') : date(local?.nextCheckAt)], [t('subscription_profile', 'Browser profile'), mapping.profileLabel], ...(local ? runtimeFacts(local) : [])], 'facts'));
    if (local) appendRuntimeNotes(state, local);
    body.append(state);
    if (mapping.status !== 'active') { body.append(el('p', t('subscription_exitPending', 'Removal is scheduled or done. Each browser reports its own result.'), 'subscription-note')); return; }
    const exit = section(t('subscription_leave', 'Leave this subscription'), 'subscription-section subscription-exit-actions');
    exit.append(el('p', t('subscription_leaveHint', 'Remove from this browser affects only this browser. Unsubscribe everywhere does the same on all your browsers. You choose what happens to the bookmarks before anything changes.'), 'detail'));
    const exits = el('div', undefined, 'section-commands'); exits.append(button(t('subscription_detach', 'Remove from this browser'), () => { void exitPreview('mapping'); }), button(t('subscription_unsubscribe', 'Unsubscribe everywhere'), () => { void exitPreview('subscription'); })); exit.append(exits);
    if (!local) { body.append(exit); return; }
    const form = el('form', undefined, 'subscription-section'), settingsHost = el('div', undefined, 'subscription-fields'); form.append(el('h3', t('subscription_contentSettings', 'Content and updates')), settingsHost);
    const scopeKey = (value: { digestMode: unknown; editionLimit: unknown }) => JSON.stringify([value.digestMode, value.editionLimit]);
    let reviewedScope = scopeKey(mapping), scopeExpiry = Infinity;
    const previewHost = el('div'), previewNote = status();
    const read = contentSettings(settingsHost, mapping.digestMode !== null, mapping, () => { const next = read(); if (next && scopeKey(next) !== reviewedScope) previewNote.textContent = t('subscription_reviewContentFirst', 'Preview the change before saving.'); });
    const previewScope = button(t('subscription_previewContentChanges', 'Preview content changes'), () => { const next = read(); if (!next || !value.sourceRef) return; const version = generation, requested = scopeKey(next); previewScope.disabled = true;
      void (async () => { try {
        const before = await send<{ descriptor: SnapshotDescriptor; nodes: ProjectionNode[] }>({ kind: 'sourcePreview', ...value.sourceRef!, digestMode: mapping.digestMode, editionLimit: mapping.editionLimit });
        const after = await send<{ descriptor: SnapshotDescriptor; nodes: ProjectionNode[] }>({ kind: 'sourcePreview', ...value.sourceRef!, digestMode: next.digestMode, editionLimit: next.editionLimit });
        const latest = read(); if (version !== generation || !latest || scopeKey(latest) !== requested) return;
        const oldIssues = new Set(before.descriptor.editions.map(item => item.editionId)), newIssues = new Set(after.descriptor.editions.map(item => item.editionId));
        const added = [...newIssues].filter(id => !oldIssues.has(id)).length, removed = [...oldIssues].filter(id => !newIssues.has(id)).length;
        reviewedScope = requested; scopeExpiry = new Date(after.descriptor.expiresAt).getTime(); renderProjection(previewHost, after);
        previewNote.textContent = t('subscription_previewDelta', 'Compared with now: $1 issues added, $2 issues removed. Nothing changes until you save.', added, removed);
      } catch (error) { if (version === generation) previewNote.textContent = errorCopy(error); } finally { previewScope.disabled = false; } })();
    });
    previewScope.classList.add('btn-sm');
    if (mapping.digestMode !== null && value.sourceRef) { const previewRow = el('div', undefined, 'subscription-preview-row'); previewRow.append(previewScope, previewNote); form.append(previewRow, previewHost); }
    const policies = el('fieldset', undefined, 'subscription-fieldset'); policies.append(el('legend', t('subscription_overrides', 'When you leave this subscription')));
    const options = [['inherit', t('subscription_inherit', 'Use my default')], ['keep', t('subscription_keep', 'Keep the bookmarks as your own')], ['remove', t('subscription_remove', 'Delete the folder')]] as const;
    const unfollow = select(options, mapping.exitPolicy.onUnfollow), unsubscribe = select(options, mapping.exitPolicy.onUnsubscribe), effective = el('p', undefined, 'field-hint');
    const policyFields = el('div', undefined, 'subscription-fields'); policyFields.append(field(t('subscription_afterUnfollow', 'When you unfollow'), unfollow), field(t('subscription_afterUnsubscribe', 'When you unsubscribe'), unsubscribe)); policies.append(policyFields, effective);
    const version = generation;
    void chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }).then(response => {
      if (version !== generation) return; const prefs = response as BookmarkPreferencesResponse;
      if (!prefs.ok) return;
      const label = (value: string | undefined) => value === 'keep' ? t('subscription_keep', 'Keep the bookmarks as your own') : value === 'remove' ? t('subscription_remove', 'Delete the folder') : t('common_unknown', 'Unknown');
      const paintPolicy = () => { const p = prefs.preferences; effective.textContent = t('subscription_effectivePolicy', 'What will happen') + ': ' + t('subscription_afterUnfollow', 'When you unfollow') + ' — ' + label(unfollow.value === 'inherit' ? p.subscriptionOnUnfollow : unfollow.value) + ' · ' + t('subscription_afterUnsubscribe', 'When you unsubscribe') + ' — ' + label(unsubscribe.value === 'inherit' ? p.subscriptionOnUnsubscribe : unsubscribe.value) + (prefs.pending || prefs.conflict ? ' · ' + t('subscription_policyUnconfirmed', "your default hasn't finished syncing") : ''); };
      unfollow.addEventListener('change', paintPolicy); unsubscribe.addEventListener('change', paintPolicy); paintPolicy();
    }).catch(() => undefined);
    const save = el('button', t('subscription_saveChanges', 'Save changes'), 'btn btn-primary'); save.type = 'submit'; const saveRow = el('div', undefined, 'section-commands'); saveRow.append(save); form.append(policies, saveRow);
    form.addEventListener('submit', event => { event.preventDefault(); const content = read(); if (!content) return; if (mapping.digestMode !== null && (scopeKey(content) !== reviewedScope || scopeExpiry <= Date.now())) { previewNote.textContent = t('subscription_reviewContentFirst', 'Preview the change before saving.'); previewScope.focus(); return; } const version = generation; save.disabled = true;
      void send({ kind: 'patch', mappingId, expectedGeneration: mapping.generation, ifMatch: value.etag, patch: { ...content, exitPolicy: { onUnfollow: unfollow.value as 'inherit'|'keep'|'remove', onUnsubscribe: unsubscribe.value as 'inherit'|'keep'|'remove' } } }).then(async () => { if (version !== generation) return; await load(); feedback.textContent = t('subscription_settingsSaved', 'Saved. The folder updates on its next check.'); }).catch(error => { if (version === generation) feedback.textContent = errorCopy(error); }).finally(() => { save.disabled = false; });
    }); body.append(form);
    const name = el('input'); name.value = local.localAlias; name.maxLength = 255;
    const location = section(t('subscription_location', 'Folder location')), rename = el('div', undefined, 'subscription-inline-field');
    rename.append(field(t('subscription_folderName', 'Folder name'), name), button(t('subscription_rename', 'Rename folder'), () => { if (!name.value.trim()) return; const version = generation; void send({ kind: 'rename', mappingId, localAlias: name.value.trim(), expectedGeneration: mapping.generation }).then(() => { if (version === generation) void load(); }).catch(error => { feedback.textContent = errorCopy(error); }); }));
    const move = el('div', undefined, 'section-commands'); move.append(button(t('subscription_move', 'Change location'), () => relocate(value)));
    location.append(rename, move); body.append(location, exit);
  }
  function relocate(value: MappingDetail) {
    const view = modal(t('subscription_move', 'Change location')); const pickerHost = el('div'), note = status(); let target: FolderSelection | undefined;
    view.body.append(el('p', t('subscription_moveExisting', 'Moves the folder and everything in it.'))); if (value.local) appendRuntimeSummary(view.body, value.local); view.body.append(pickerHost, note);
    const picker = createNativePicker(pickerHost, send, selected => { target = selected; confirm.disabled = !selected; token = undefined; confirm.textContent = t('subscription_previewMove', 'Preview move'); });
    let token: { token: string; expiresAt: string | number } | undefined; let requestId = crypto.randomUUID(); const version = generation;
    const confirm = button(t('subscription_previewMove', 'Preview move'), () => { if (!target) return; confirm.disabled = true;
      void (async () => { try { if (!token) { token = await send({ kind: 'relocatePreview', mappingId, parentNativeId: target!.id, ...(target!.index === undefined ? {} : { index: target!.index }), expectedGeneration: value.mapping.generation }); requestId = crypto.randomUUID(); note.textContent = t('subscription_moveTo', 'Move folder to') + ': ' + target!.path; confirm.textContent = t('subscription_confirmMove', 'Move folder'); }
        else { if (new Date(token.expiresAt).getTime() <= Date.now()) { token = undefined; throw new Error('snapshot_expired'); } await send({ kind: 'relocateConfirm', token: token.token }, requestId); view.dialog.close(); if (version === generation) await load(); }
      } catch (error) { note.textContent = errorCopy(error); if (error instanceof Error && /preview|generation|epoch|precondition|revision|snapshot/.test(error.message)) { token = undefined; confirm.textContent = t('subscription_previewMove', 'Preview move'); } } finally { confirm.disabled = false; } })();
    }, true); confirm.disabled = true; view.actions.append(confirm); view.dialog.addEventListener('close', () => picker.dispose());
  }
  const origin = (value: string) => value === 'mapping' ? t('subscription_originMapping', 'set for this subscription') : value === 'authority' ? t('subscription_originAuthority', 'set by Know-N') : t('subscription_originGlobal', 'your default');
  async function exitPreview(scope: 'mapping'|'subscription') {
    const version = generation;
    try {
      const preferences = await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }) as BookmarkPreferencesResponse;
      if (!preferences.ok || preferences.pending || preferences.conflict) { feedback.textContent = t('subscription_resolveExitPolicy', 'Your defaults for leaving a subscription are still syncing. Try again in a moment.'); return; }
      const preview = await send<ExitPreview>({ kind: 'exitPreview', mappingId, scope, expectedGeneration: current?.mapping.generation }); if (version !== generation) return;
      const view = modal(scope === 'mapping' ? t('subscription_detach', 'Remove from this browser') : t('subscription_unsubscribe', 'Unsubscribe everywhere')); const note = status();
      view.body.append(el('p', t('subscription_exitScopeWarning', 'Only the folders listed are affected. Browsers that are offline finish when they reconnect.')));
      for (const target of preview.targets) view.body.append(el('p', target.profileLabel + ': ' + (target.effectiveAction === 'keep' ? t('subscription_keep', 'Keep the bookmarks as your own') : t('subscription_remove', 'Delete the folder')) + ' · ' + origin(target.policyOrigin)));
      view.body.append(note); const requestId = crypto.randomUUID(); let stale = false;
      const confirm = button(t('subscription_confirmExit', 'Remove'), () => { if (stale) return; confirm.disabled = true;
        void (async () => { try { if (new Date(preview.expiresAt).getTime() <= Date.now()) throw new Error('snapshot_expired'); await send<ExitBatch>({ kind: 'exitConfirm', previewId: preview.previewId }, requestId); view.dialog.close(); if (version === generation) { await load(); feedback.textContent = t('subscription_exitScheduled', 'Removal started. Each browser finishes on its own.'); } } catch (error) { note.textContent = errorCopy(error); stale = error instanceof Error && /preview|generation|epoch|precondition|revision|snapshot/.test(error.message); } finally { confirm.disabled = stale; } })();
      }, true); if (preview.targets.some(target => target.effectiveAction === 'remove')) confirm.className = 'btn btn-danger';
      view.actions.append(button(t('subscription_reviewExitPolicies', 'Check again'), () => { view.dialog.close(); if (version === generation) void exitPreview(scope); }), confirm);
    } catch (error) { if (version === generation) feedback.textContent = errorCopy(error); }
  }
  void load(); return { dispose() { disposed = true; clearTimeout(timer); generation++; for (const dialog of Array.from(document.querySelectorAll<HTMLDialogElement>('.subscription-dialog'))) dialog.close(); host.replaceChildren(); } };
}
