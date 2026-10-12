import { filterPersonalTree } from '../bookmark-subscriptions/personal-boundary.js';
import { supportedBookmarkTree, isUnsupportedBookmarkFolder } from '../bookmark-folder-policy.js';
import { assertPersonalNativeAllowed, isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { assertPreviewSourceUnchanged, bindImportFolderChoices, createBookmarkImportCoordinator,
  type BookmarkImportView } from '../bookmark-import-plan.js';
import { previewChromeBookmarkImport, previewNetscapeBookmarkImport, normalizeChromeBookmarkTree, type ImportConversionResult } from '../import-preview.js';
import { clearImportPreviewCache, readImportPreviewCache, writeImportPreviewCache } from '../import-preview-cache.js';
import { FAVICON_SIDECAR_ALARM } from '../favicon-sidecar-store.js';
import type { SyncScope } from '../sync-state-store.js';
import type { ImportRequest, ImportResponse, PublicImportPreview } from '../types.js';
import { scheduleSyncEngineWake } from './engine.js';
import { hasBookmarkPermission, faviconSidecar, sw, syncState } from './runtime.js';
import { requireSyncScope } from './scope.js';
import { t } from '../i18n.js';

export async function handleImportRequest(message: ImportRequest): Promise<ImportResponse> {
  const scope = await requireSyncScope(); const coordinator = createBookmarkImportCoordinator({ store: syncState, scope });
  if (message.kind === 'known.import.previewFile') {
    const conversion = previewNetscapeBookmarkImport(decodeImportBase64(message.base64));
    await rememberImportPreview(conversion);
    return { ok: true, preview: await publicImportPreview(scope, conversion) };
  }
  if (message.kind === 'known.import.previewNative') {
    if (!await hasBookmarkPermission()) throw new Error('permission_required');
    const conversion = previewChromeBookmarkImport(normalizeChromeBookmarkTree(
      message.tree !== undefined ? message.tree : await readNativeBookmarkTree()));
    await rememberImportPreview(conversion);
    return { ok: true, preview: await publicImportPreview(scope, conversion) };
  }
  if (message.kind === 'known.import.commit') {
    // The RAM map dies with the worker between preview and commit; the
    // digest-verified session cache keeps the reviewed preview committable.
    const conversion = sw.importPreviews.get(message.digest)
      ?? await readImportPreviewCache(chrome.storage.session, message.digest).catch(() => undefined);
    if (!conversion) throw new Error('preview_expired');
    if (conversion.source.profile === 'chromium-bookmarks-v1') await assertLiveNativeImportUnchanged(conversion);
    const preview = await publicImportPreview(scope, conversion); const allowed = new Map(preview.targets
      .map((target) => [`${target.nativeId}\u0000${target.colpId}`, {
        nativeId: target.nativeId, colpId: target.colpId, revision: target.revision }]));
    const choices = bindImportFolderChoices(message.choices, allowed);
    for (const choice of choices) if(choice.action!=='skip') await assertPersonalNativeAllowed(choice.target.nativeId);
    const view = await coordinator.commit({ conversion, choices, sidecar: faviconSidecar, collectionId: scope.collectionId });
    sw.importPreviews.delete(message.digest);
    await clearImportPreviewCache(chrome.storage.session).catch(() => undefined);
    chrome.alarms.create(FAVICON_SIDECAR_ALARM, { when: Date.now() + 1_000 });
    scheduleSyncEngineWake('manual'); return { ok: true, status: publicImportStatus(view) };
  }
  const view = message.kind === 'known.import.pause' ? await coordinator.pause(message.planId)
    : message.kind === 'known.import.resume' ? await coordinator.resume(message.planId)
      : message.kind === 'known.import.retry' ? await coordinator.retry(message.planId)
        : await coordinator.status(message.planId);
  if (message.kind === 'known.import.resume' || message.kind === 'known.import.retry') scheduleSyncEngineWake('manual');
  return { ok: true, status: publicImportStatus(view) };
}

async function publicImportPreview(scope: SyncScope, conversion: ImportConversionResult): Promise<PublicImportPreview> {
  const stored = await syncState.getScope(scope); const mappings = await syncState.listMappings(scope);
  const selected = new Set(stored?.selectedRoots ?? []); const targets = [];
  for (const mapping of mappings.filter((item) => selected.has(item.colpId))) {
    if(await isSubscriptionExcluded(mapping.nativeId)||await isUnsupportedBookmarkFolder(mapping.nativeId))continue;
    let title = t('import_selectedSyncFolder', 'Selected sync folder');
    try { title = (await chrome.bookmarks.get(mapping.nativeId))[0]?.title || title; } catch { /* stable fallback */ }
    targets.push({ nativeId: mapping.nativeId, colpId: mapping.colpId, revision: mapping.projection.revision, title });
  }
  return { digest: conversion.digest, sourceProfile: conversion.source.profile, creates: conversion.preview.creates,
    warnings: conversion.preview.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    roots: conversion.tree.map((node) => ({ sourceNodeId: node.sourceNodeId, kind: node.kind, title: node.title ?? node.kind,
      descendants: countImportNodes(node) - 1 })), targets };
}

function countImportNodes(node: ImportConversionResult['tree'][number]): number {
  return 1 + node.children.reduce((total, child) => total + countImportNodes(child), 0);
}

export function publicImportStatus(view: BookmarkImportView) {
  return { planId: view.planId, state: view.state, progress: view.progress };
}

async function rememberImportPreview(conversion: ImportConversionResult): Promise<void> {
  sw.importPreviews.clear();
  sw.importPreviews.set(conversion.digest, conversion);
  await writeImportPreviewCache(chrome.storage.session, conversion).catch(() => undefined);
}

async function assertLiveNativeImportUnchanged(conversion: ImportConversionResult): Promise<void> {
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  assertPreviewSourceUnchanged(conversion, previewChromeBookmarkImport(normalizeChromeBookmarkTree(await readNativeBookmarkTree())));
}

async function readNativeBookmarkTree(): Promise<unknown> {
  const api = typeof chrome.bookmarks === 'undefined' ? undefined : chrome.bookmarks;
  if (typeof api?.getTree !== 'function') throw new Error('permission_required');
  try { return await filterPersonalTree(supportedBookmarkTree(await api.getTree())); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/permission|not permitted|access denied/i.test(message)) throw new Error('permission_required');
    throw new Error('chrome_tree_invalid');
  }
}

function decodeImportBase64(value: string) { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
  throw new Error('input_invalid');
}
  let binary: string; try { binary = atob(value); } catch { throw new Error('input_invalid'); }
  if (binary.length > 4 * 1024 * 1024) throw new Error('input_too_large');
  const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
