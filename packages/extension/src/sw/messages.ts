import { DEFAULT_BOOKMARK_PREFERENCES, normalizeBookmarkPreferences } from '../bookmark-preferences.js';
import { SYNC_STATE_EVIDENCE_MAX_ARG_BYTES, SYNC_STATE_EVIDENCE_MAX_ARGS,
  isSyncStateEvidenceMethod } from './evidence-methods.js';
import type {
  AuthExtensionRequest, BatchRequest, ConnectivityRequest, FirstRunRequest, ImportRequest, IngressDiagnosticsGetRequest,
  NativeSaveRequest, NativeWaitRequest, RemoteDeleteRequest, RootRequest, SaveStatusRequest, ScopeCommandRequest,
  SyncAttentionGetRequest, SyncRetryRequest, SyncEngineRequest, SyncProgressRequest, BookmarkPreferencesRequest,
} from '../types.js';

export interface SyncStateEvidenceRequest {
  readonly kind: 'known.sync-state.evidence';
  readonly method: string;
  readonly args: readonly unknown[];
}

export function validSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  let page: URL;
  try { page = new URL(sender.url); } catch { return false; }
  return page.protocol === 'chrome-extension:' && page.hostname === chrome.runtime.id
    && (page.pathname === '/options.html' || page.pathname === '/popup.html' || page.pathname === '/capture-tabs.html');
}

export function validRequest(value: unknown): value is AuthExtensionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>; const keys = Object.keys(request);
  if (request.kind === 'known.auth.status' || request.kind === 'known.auth.refresh') return keys.length === 1;
  if (request.kind === 'known.auth.send-otp') {
    return request.userGesture === true && keys.length === 3 && validEmail(request.email);
  }
  if (request.kind === 'known.auth.logout') return request.userGesture === true && keys.length === 2;
  if (request.kind !== 'known.auth.login' || request.userGesture !== true) return false;
  if (request.method === 'password') {
    // Password accepts a username or an email. OTP stays on validEmail.
    return keys.length === 5 && validLoginIdentifier(request.email) && validSecret(request.password, 256);
  }
  if (request.method === 'otp') {
    return keys.length === 5 && validEmail(request.email) && validOtp(request.otp);
  }
  if (request.method === 'oauth') {
    return keys.length === 4 && (request.provider === 'google' || request.provider === 'github');
  }
  return false;
}

function validLoginIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 320
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validEmail(value: unknown): value is string {
  return validLoginIdentifier(value) && value.includes('@');
}
function validSecret(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function validOtp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/u.test(value);
}

export function validSyncEngineRequest(value: unknown): value is SyncEngineRequest {
  return !!value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'known.sync.engine.status'
    && Object.keys(value).length === 1;
}

export function validSyncRetryRequest(value: unknown): value is SyncRetryRequest {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === 'known.sync.engine.retry' && Object.keys(value).length === 1;
}

/**
 * S7 / B2 (SR-09 · SR-11 · SR-13): the popup/settings attention read. Read-only
 * and parameterless, like `known.sync.engine.status`: no scope, id or armed
 * action can ride along, so the extra surface stays strictly narrower than the
 * messages it aggregates.
 */
export function validSyncAttentionRequest(value: unknown): value is SyncAttentionGetRequest {
  return !!value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'known.sync.attention.get'
    && Object.keys(value).length === 1;
}

/** The sync progress read: parameterless and read-only, as narrow as the attention read. */
export function validSyncProgressRequest(value: unknown): value is SyncProgressRequest {
  return !!value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'known.sync.progress.get'
    && Object.keys(value).length === 1;
}

/**
 * SR-10 / A-08: the options-page ingress-diagnostic list. Exactly as narrow as
 * the attention read: parameterless, so no scope, code filter or armed action
 * can ride along with a page request.
 */
export function validIngressDiagnosticsRequest(value: unknown): value is IngressDiagnosticsGetRequest {
  return !!value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'known.sync.ingressDiagnostics.get'
    && Object.keys(value).length === 1;
}

export function validSaveStatusRequest(value: unknown): value is SaveStatusRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind !== 'known.save.status') return false;
  const keys = Object.keys(request);
  if (keys.length === 1) return true;
  return keys.length === 2 && typeof request.nativeId === 'string' && request.nativeId.length > 0
    && request.nativeId.length <= 128;
}

export function validConnectivityRequest(value: unknown): value is ConnectivityRequest {
  return !!value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'known.connectivity.online'
    && Object.keys(value).length === 1;
}

export function validImportRequest(value: unknown): value is ImportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>; const kind = request.kind;
  if (kind === 'known.import.previewFile') return typeof request.base64 === 'string'
    && request.base64.length <= 5_592_408 && Object.keys(request).length === 2;
  if (kind === 'known.import.previewNative') {
    if (Object.keys(request).length === 1) return true;
    return Object.keys(request).length === 2 && boundedNativeImportTree(request.tree);
  }
  if (kind === 'known.import.status') return Object.keys(request).every((key) => key === 'kind' || key === 'planId')
    && (request.planId === undefined || typeof request.planId === 'string');
  if (kind === 'known.import.pause' || kind === 'known.import.resume' || kind === 'known.import.retry') {
    return typeof request.planId === 'string' && request.planId.length <= 256 && Object.keys(request).length === 2;
  }
  if (kind !== 'known.import.commit' || typeof request.digest !== 'string' || !Array.isArray(request.choices)
      || request.choices.length > 128 || Object.keys(request).length !== 3) return false;
  return request.choices.every((item) => { if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const choice = item as Record<string, unknown>; if (typeof choice.sourceNodeId !== 'string') return false;
    if (choice.action === 'skip') return Object.keys(choice).length === 2;
    if (choice.action !== 'import' || !choice.target || typeof choice.target !== 'object' || Array.isArray(choice.target)) return false;
    const target = choice.target as Record<string, unknown>; return Object.keys(choice).length === 3
      && Object.keys(target).length === 3 && ['nativeId', 'colpId', 'revision'].every((key) => typeof target[key] === 'string'); });
}

function boundedNativeImportTree(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 4 * 1024 * 1024;
  } catch { return false; }
}

export function validSyncStateEvidenceRequest(value: unknown): value is SyncStateEvidenceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind !== 'known.sync-state.evidence' || typeof request.method !== 'string') return false;
  if (Object.keys(request).length !== 3 || !Array.isArray(request.args)) return false;
  // The method name is the whole surface of this development channel: reject
  // anything that is not one of the dispatched verbs instead of letting an
  // arbitrary string reach the dispatcher.
  if (!isSyncStateEvidenceMethod(request.method)) return false;
  if (request.args.length > SYNC_STATE_EVIDENCE_MAX_ARGS) return false;
  try {
    return JSON.stringify(request.args).length <= SYNC_STATE_EVIDENCE_MAX_ARG_BYTES;
  } catch { return false; }
}

export function validFaviconRequest(value: unknown): value is
  | { readonly kind: 'known.favicon.save-context' | 'known.favicon.save-context-local' | 'known.favicon.drain' | 'known.favicon.policy' }
  | { readonly kind: 'known.favicon.clear'; readonly nativeId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.favicon.clear') {
    return typeof request.nativeId === 'string' && request.nativeId.length > 0 && request.nativeId.length <= 256
      && Object.keys(request).length === 2;
  }
  return (request.kind === 'known.favicon.save-context' || request.kind === 'known.favicon.save-context-local' || request.kind === 'known.favicon.drain'
    || request.kind === 'known.favicon.policy')
    && Object.keys(request).length === 1;
}

export function validNativeSaveRequest(value: unknown): value is NativeSaveRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.kind === 'known.save.native' && request.userGesture === true
    && (request.entry === 'page' || request.entry === 'window') && Object.keys(request).length === 3;
}

export function validBookmarkPreferencesRequest(value: unknown): value is BookmarkPreferencesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.bookmark.preferences.get'
      || request.kind === 'known.bookmark.preferences.local') return Object.keys(request).length === 1;
  if (request.kind === 'known.bookmark.preferences.update') {
    const fields = ['bookmarkInsertPosition', 'foldersFirst', 'captureMode', 'resultPanelAutoDismissMs', 'learnFromCorrections', 'resumeClassificationWhenOnline', 'aiTagMode', 'subscriptionOnUnfollow', 'subscriptionOnUnsubscribe', 'subscriptionDefaultCheckIntervalMinutes', 'subscriptionDefaultDigestMode', 'subscriptionDefaultEditionLimit'];
    const { kind: _kind, userGesture: _gesture, ...patch } = request;
    return request.userGesture === true && Object.keys(patch).length > 0
      && Object.keys(patch).every(key => fields.includes(key))
      && Object.entries(patch).every(([key, value]) => value !== undefined && (value !== null || key === 'subscriptionDefaultCheckIntervalMinutes'))
      && normalizeBookmarkPreferences({ ...DEFAULT_BOOKMARK_PREFERENCES, ...patch }) !== undefined;
  }
  return request.kind === 'known.bookmark.preferences.resolve' && Object.keys(request).length === 3
    && request.userGesture === true && (request.choice === 'server' || request.choice === 'local');
}

export function validRootRequest(value: unknown): value is RootRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.roots.get') {
    return Object.keys(request).every((key) => key === 'kind' || key === 'preselectFolderId')
      && (request.preselectFolderId === undefined || boundedId(request.preselectFolderId));
  }
  if (request.kind === 'known.roots.boundaries') {
    return Object.keys(request).length === 1;
  }
  if (request.kind === 'known.roots.permissionChanged') return request.userGesture === true
    && typeof request.granted === 'boolean' && Object.keys(request).length === 3;
  if (request.kind === 'known.roots.confirm') {
    const keys = Object.keys(request);
    return boundedId(request.previewId) && boundedId(request.confirmationId) && boundedId(request.treeDigest, 256)
      && keys.every((key) => ['kind', 'previewId', 'confirmationId', 'treeDigest', 'shiftActions',
        'remoteDeleteRefs'].includes(key))
      && (request.shiftActions === undefined || validShiftActions(request.shiftActions))
      && (request.remoteDeleteRefs === undefined || boundedRefList(request.remoteDeleteRefs));
  }
  return (request.kind === 'known.roots.update' || request.kind === 'known.roots.preview')
    && typeof request.viewId === 'string' && request.viewId.length <= 64
    && Array.isArray(request.selectedRefs) && Array.isArray(request.privateRefs)
    && Object.keys(request).length === 4 && request.selectedRefs.length <= 128 && request.privateRefs.length <= 128
    && request.selectedRefs.every((item) => typeof item === 'string')
    && request.privateRefs.every((item) => typeof item === 'string');
}

function validShiftActions(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 128 && value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return Object.keys(row).length === 2 && typeof row.ref === 'string' && row.ref.length > 0 && row.ref.length <= 64
      && (row.action === 'keep' || row.action === 'unmount');
  });
}

function boundedId(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedRefList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((item) => typeof item === 'string');
}

export function validFirstRunRequest(value: unknown): value is FirstRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.firstRun.status' || request.kind === 'known.firstRun.later') {
    return Object.keys(request).length === 1;
  }
  if (request.kind === 'known.firstRun.attention.get') {
    const keys = Object.keys(request);
    return (keys.length === 2 || keys.length === 3)
      && keys.every((key) => ['kind', 'reportId', 'cursor'].includes(key))
      && boundedId(request.reportId)
      && (request.cursor === undefined || boundedId(request.cursor, 32));
  }
  if (request.kind === 'known.firstRun.attention.decide') {
    return Object.keys(request).every(key => ['kind', 'reportId', 'itemId', 'decision', 'evidenceDigest'].includes(key))
      && boundedId(request.reportId) && boundedId(request.itemId)
      && (request.decision === 'keep_both' || request.decision === 'keep_local'
        && typeof request.evidenceDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(request.evidenceDigest));
  }
  if (request.kind === 'known.firstRun.preview') {
    const keys = Object.keys(request);
    return (keys.length === 4 || keys.length === 5)
      && keys.every((key) => ['kind', 'viewId', 'selectedRefs', 'excludedRefs', 'bootstrapMode'].includes(key))
      && boundedId(request.viewId, 64)
      && boundedRefList(request.selectedRefs) && boundedRefList(request.excludedRefs)
      && (!Object.hasOwn(request, 'bootstrapMode') || validBootstrapMode(request.bootstrapMode));
  }
  if (request.kind !== 'known.firstRun.confirm' || !boundedId(request.previewId)
      || !boundedId(request.confirmationId)) return false;
  const keys = Object.keys(request);
  return typeof request.libraryId === 'string' && keys.every(key => ['kind', 'previewId', 'confirmationId', 'libraryId', 'bootstrapMode', 'advancedConfirmation'].includes(key))
    && validFirstRunConfirmKeys(request, keys, boundedId(request.libraryId));
}

function validFirstRunConfirmKeys(request: Record<string, unknown>, keys: readonly string[], libraryValid: boolean): boolean {
  if (!libraryValid) return false;
  const mode = request.bootstrapMode;
  if (mode === undefined && Object.hasOwn(request, 'bootstrapMode')) return false;
  if (mode !== undefined && !validBootstrapMode(mode)) return false;
  const advanced = request.advancedConfirmation;
  if (advanced === undefined) return keys.length === 4 && mode === undefined;
  if (mode !== 'upload' && mode !== 'download' && mode !== 'mirror') return false;
  return keys.length === 6 && validAdvancedConfirmation(advanced)
    && (advanced as { readonly mode?: unknown }).mode === mode;
}

function validBootstrapMode(value: unknown): value is 'download' | 'upload' | 'merge' | 'mirror' {
  return value === 'download' || value === 'upload' || value === 'merge' || value === 'mirror';
}

function validAdvancedConfirmation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 8 || keys.some((key) => ![
    'scopeFingerprint', 'treeDigest', 'mode', 'remoteSnapshotId', 'remoteRevision', 'remoteCursor',
    'destructivePlanDigest', 'confirmationProof',
  ].includes(key))) return false;
  return boundedId(row.scopeFingerprint, 256) && boundedId(row.treeDigest, 256)
    && (row.mode === 'upload' || row.mode === 'download' || row.mode === 'mirror')
    && boundedId(row.remoteSnapshotId, 256) && boundedId(row.remoteRevision, 256)
    && boundedId(row.remoteCursor, 256) && boundedId(row.destructivePlanDigest, 256)
    && boundedId(row.confirmationProof, 256);
}

export function validScopeCommandRequest(value: unknown): value is ScopeCommandRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.scope.detach' || request.kind === 'known.scope.rejoin') {
    return Object.keys(request).length === 2 && boundedId(request.mountId);
  }
  return request.kind === 'known.scope.remoteDelete' && Object.keys(request).length === 4
    && boundedId(request.mountId) && boundedId(request.confirmationToken, 256)
    && Number.isSafeInteger(request.affectedCount) && (request.affectedCount as number) >= 0;
}

export function validRemoteDeleteRequest(value: unknown): value is RemoteDeleteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.remoteDelete.policy.get' || request.kind === 'known.remoteDelete.pending.list') {
    return Object.keys(request).length === 1;
  }
  if (request.kind === 'known.remoteDelete.policy.set') {
    return Object.keys(request).length === 4 && request.userGesture === true
      && (request.policy === 'sync' || request.policy === 'confirm' || request.policy === 'keep_local')
      && Number.isSafeInteger(request.expectedCasVersion) && (request.expectedCasVersion as number) >= 0;
  }
  return request.kind === 'known.remoteDelete.decide' && Object.keys(request).length === 6
    && request.userGesture === true && boundedId(request.decisionId, 128)
    && (request.action === 'apply' || request.action === 'restore' || request.action === 'keep_local')
    && Number.isSafeInteger(request.expectedCasVersion) && (request.expectedCasVersion as number) >= 1
    && boundedId(request.deleteRevision, 256);
}

/**
 * S1 / B0-1: `nativeWait.list` reads the pending waits; `nativeWait.confirm`
 * carries the waitRef + generation CAS for one of the three user decisions.
 * `nativeId` is only meaningful for `bind` and is rejected elsewhere so the
 * whitelist cannot smuggle an ignored identity into another action.
 */
export function validNativeWaitRequest(value: unknown): value is NativeWaitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.nativeWait.list') return Object.keys(request).length === 1;
  if (request.kind !== 'known.nativeWait.confirm') return false;
  const keys = Object.keys(request);
  if (keys.some((key) => !['kind', 'userGesture', 'waitRef', 'intentId', 'generation', 'action', 'nativeId']
    .includes(key))) return false;
  if (request.userGesture !== true
      || !boundedId(request.waitRef, 256) || !boundedId(request.intentId, 256)
      || !Number.isSafeInteger(request.generation) || (request.generation as number) < 1) return false;
  if (request.action === 'bind') {
    return keys.length === 7 && boundedId(request.nativeId, 256);
  }
  if (request.action !== 'keep_local_and_create' && request.action !== 'cancel') return false;
  return keys.length === 6 && request.nativeId === undefined;
}

export function validBatchRequest(value: unknown): value is BatchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.batch.status') {
    return Object.keys(request).every((key) => key === 'kind' || key === 'planId')
      && (request.planId === undefined || boundedId(request.planId, 256));
  }
  if (request.kind === 'known.batch.undo') {
    return Object.keys(request).length === 4 && request.userGesture === true
      && boundedId(request.planId, 256) && boundedId(request.commandId, 256);
  }
  if (request.kind === 'known.batch.preview' || request.kind === 'known.batch.confirm') {
    if (!validBatchOperation(request.operation) || !validNativeIdList(request.nativeIds)
        || (request.targetParentId !== undefined && !boundedId(request.targetParentId))
        || (request.titles !== undefined && !validTitleMap(request.titles, request.nativeIds as readonly string[]))) {
      return false;
    }
    if (request.kind === 'known.batch.preview') {
      return Object.keys(request).every((key) => ['kind', 'operation', 'nativeIds', 'targetParentId', 'titles']
        .includes(key));
    }
    return request.userGesture === true && boundedId(request.commandId, 256)
      && boundedId(request.previewDigest, 256)
      && (request.secondConfirm === undefined || request.secondConfirm === true)
      && Object.keys(request).every((key) => [
        'kind', 'commandId', 'operation', 'nativeIds', 'previewDigest', 'userGesture', 'secondConfirm',
        'targetParentId', 'titles',
      ].includes(key));
  }
  return false;
}

function validBatchOperation(value: unknown): value is 'move' | 'rename' | 'delete' {
  return value === 'move' || value === 'rename' || value === 'delete';
}

function validNativeIdList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 500 && value.every((id) => boundedId(id));
}

function validTitleMap(value: unknown, nativeIds: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(nativeIds);
  return Object.entries(value as Record<string, unknown>).every(([key, title]) => allowed.has(key)
    && typeof title === 'string' && title.length > 0 && title.length <= 512);
}
