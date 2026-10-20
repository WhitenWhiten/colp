import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as messages from '../src/sw/messages.js';
import { DEFAULT_BOOKMARK_PREFERENCES } from '../src/bookmark-preferences.js';

type Validator = (value: unknown) => boolean;
const validators: [string, Validator][] = Object.entries(messages)
  .filter(([name]) => name !== 'validSender') as [string, Validator][];
beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: 'known-extension' } }));
afterEach(() => vi.unstubAllGlobals());

test.each(validators)('%s refuses non-document input and an unknown command', (_name, validate) => {
  for (const value of [undefined, null, false, 42, 'known.auth.status', [], {}, { kind: 'unknown.command' }]) {
    expect(validate(value)).toBe(false);
  }
});

test('worker senders require this extension and one of its three shipped page paths', () => {
  for (const page of ['options', 'popup', 'capture-tabs']) {
    expect(messages.validSender({ id: 'known-extension', url: `chrome-extension://known-extension/${page}.html` })).toBe(true);
  }
  for (const sender of [
    {}, { id: 'other', url: 'chrome-extension://known-extension/options.html' },
    { id: 'known-extension' }, { id: 'known-extension', url: 'not a URL' },
    { id: 'known-extension', url: 'https://known-extension/options.html' },
    { id: 'known-extension', url: 'chrome-extension://other/options.html' },
    { id: 'known-extension', url: 'chrome-extension://known-extension/untrusted.html' },
    { id: 'known-extension', url: 'chrome-extension://known-extension/options.html/child' },
  ]) expect(messages.validSender(sender)).toBe(false);
});

const reads: [Validator, string][] = [
  [messages.validRequest, 'known.auth.status'], [messages.validRequest, 'known.auth.refresh'],
  [messages.validSyncEngineRequest, 'known.sync.engine.status'], [messages.validSyncRetryRequest, 'known.sync.engine.retry'],
  [messages.validSyncAttentionRequest, 'known.sync.attention.get'], [messages.validSyncProgressRequest, 'known.sync.progress.get'],
  [messages.validIngressDiagnosticsRequest, 'known.sync.ingressDiagnostics.get'], [messages.validConnectivityRequest, 'known.connectivity.online'],
  [messages.validBookmarkPreferencesRequest, 'known.bookmark.preferences.get'], [messages.validBookmarkPreferencesRequest, 'known.bookmark.preferences.local'],
  [messages.validRemoteDeleteRequest, 'known.remoteDelete.policy.get'], [messages.validRemoteDeleteRequest, 'known.remoteDelete.pending.list'],
  [messages.validNativeWaitRequest, 'known.nativeWait.list'], [messages.validRootRequest, 'known.roots.boundaries'],
  [messages.validFirstRunRequest, 'known.firstRun.later'],
];
test.each(reads.map(([validate, kind]) => ({ validate, kind })))('$kind cannot carry injected scope or write intent', ({ validate, kind }) => {
  expect(validate({ kind })).toBe(true);
  for (const extra of [{ collectionId: 'foreign' }, { userGesture: true }, { action: 'delete' }]) {
    expect(validate({ kind, ...extra })).toBe(false);
  }
});

test('authentication commands enforce gesture, method, exact fields and bounded secrets', () => {
  const password = { kind: 'known.auth.login', userGesture: true, method: 'password', email: 'alice', password: 'secret' };
  expect(messages.validRequest(password)).toBe(true);
  for (const email of ['', 'a'.repeat(321), 'alice\u0000', 1]) expect(messages.validRequest({ ...password, email })).toBe(false);
  for (const secret of ['', 'a'.repeat(257), null]) expect(messages.validRequest({ ...password, password: secret })).toBe(false);
  expect(messages.validRequest({ ...password, email: 'a'.repeat(320), password: 'a'.repeat(256) })).toBe(true);
  for (const patch of [{ userGesture: false }, { method: 'unsupported' }, { collectionId: 'foreign' }]) {
    expect(messages.validRequest({ ...password, ...patch })).toBe(false);
  }
  for (const provider of ['google', 'github']) expect(messages.validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'oauth', provider,
  })).toBe(true);
  expect(messages.validRequest({ kind: 'known.auth.login', userGesture: true, method: 'oauth', provider: 'unknown' })).toBe(false);
  for (const otp of ['12345', '1234567', '12345a', 123456]) expect(messages.validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'otp', email: 'alice@example.test', otp,
  })).toBe(false);
  expect(messages.validRequest({ kind: 'known.auth.logout', userGesture: true })).toBe(true);
  expect(messages.validRequest({ kind: 'known.auth.logout', userGesture: false })).toBe(false);
});

test('native save and status carry only the permitted entry or bounded bookmark identity', () => {
  for (const entry of ['page', 'window']) expect(messages.validNativeSaveRequest({ kind: 'known.save.native', userGesture: true, entry })).toBe(true);
  for (const patch of [{ userGesture: false }, { entry: 'all' }, { nativeId: 'injected' }]) {
    expect(messages.validNativeSaveRequest({ kind: 'known.save.native', userGesture: true, entry: 'page', ...patch })).toBe(false);
  }
  expect(messages.validSaveStatusRequest({ kind: 'known.save.status' })).toBe(true);
  expect(messages.validSaveStatusRequest({ kind: 'known.save.status', nativeId: 'a'.repeat(128) })).toBe(true);
  for (const nativeId of ['', 'a'.repeat(129), undefined, 4]) expect(messages.validSaveStatusRequest({ kind: 'known.save.status', nativeId })).toBe(false);
  for (const kind of ['known.favicon.save-context', 'known.favicon.save-context-local', 'known.favicon.drain', 'known.favicon.policy']) {
    expect(messages.validFaviconRequest({ kind })).toBe(true);
    expect(messages.validFaviconRequest({ kind, nativeId: 'injected' })).toBe(false);
  }
  expect(messages.validFaviconRequest({ kind: 'known.favicon.clear', nativeId: 'a'.repeat(256) })).toBe(true);
  for (const nativeId of ['', 'a'.repeat(257), null]) expect(messages.validFaviconRequest({ kind: 'known.favicon.clear', nativeId })).toBe(false);
});

test('import previews and explicit choices stay bounded before any worker or network work', () => {
  expect(messages.validImportRequest({ kind: 'known.import.previewFile', base64: 'a'.repeat(5_592_408) })).toBe(true);
  expect(messages.validImportRequest({ kind: 'known.import.previewFile', base64: 'a'.repeat(5_592_409) })).toBe(false);
  expect(messages.validImportRequest({ kind: 'known.import.previewNative' })).toBe(true);
  expect(messages.validImportRequest({ kind: 'known.import.previewNative', tree: [{ id: 'root' }] })).toBe(true);
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const tree of [null, [], Array(9).fill({}), [{ title: 'x'.repeat(4 * 1024 * 1024) }], cycle]) {
    expect(messages.validImportRequest({ kind: 'known.import.previewNative', tree })).toBe(false);
  }
  for (const kind of ['known.import.pause', 'known.import.resume', 'known.import.retry']) {
    expect(messages.validImportRequest({ kind, planId: 'plan' })).toBe(true);
    expect(messages.validImportRequest({ kind, planId: 'x'.repeat(257) })).toBe(false);
  }
  expect(messages.validImportRequest({ kind: 'known.import.status' })).toBe(true);
  expect(messages.validImportRequest({ kind: 'known.import.status', planId: 'plan' })).toBe(true);
  expect(messages.validImportRequest({ kind: 'known.import.status', planId: 3 })).toBe(false);
  const skip = { sourceNodeId: 'one', action: 'skip' };
  const target = { nativeId: 'native', colpId: 'remote', revision: 'r1' };
  const take = { sourceNodeId: 'two', action: 'import', target };
  const command = { kind: 'known.import.commit', digest: 'sha256:preview', choices: [skip, take] };
  expect(messages.validImportRequest(command)).toBe(true);
  for (const choice of [null, [], {}, { ...skip, target }, { ...take, action: 'delete' },
    { ...take, target: null }, { ...take, target: [] }, { ...take, target: { ...target, revision: 1 } },
    { ...take, target: { ...target, extra: true } }, { ...take, extra: true }]) {
    expect(messages.validImportRequest({ ...command, choices: [choice] })).toBe(false);
  }
  expect(messages.validImportRequest({ ...command, choices: Array(129).fill(skip) })).toBe(false);
});

test('development evidence permits listed verbs and refuses unbounded or unserializable arguments', () => {
  const request = { kind: 'known.sync-state.evidence', method: 'exportScope', args: [] as unknown[] };
  expect(messages.validSyncStateEvidenceRequest(request)).toBe(true);
  for (const patch of [{ method: 'deleteEverything' }, { method: 3 }, { args: {} }, { args: Array(9).fill(null) },
    { args: ['x'.repeat(64 * 1024)] }, { args: [1n] }, { unsafe: true }]) {
    expect(messages.validSyncStateEvidenceRequest({ ...request, ...patch })).toBe(false);
  }
  const cycle: unknown[] = []; cycle.push(cycle);
  expect(messages.validSyncStateEvidenceRequest({ ...request, args: cycle })).toBe(false);
});

test('preference patches keep their typed values, explicit gesture and nullable interval semantics', () => {
  const base = { kind: 'known.bookmark.preferences.update', userGesture: true };
  for (const [key, value] of Object.entries(DEFAULT_BOOKMARK_PREFERENCES)) {
    expect(messages.validBookmarkPreferencesRequest({ ...base, [key]: value })).toBe(true);
  }
  expect(messages.validBookmarkPreferencesRequest({ ...base, subscriptionDefaultCheckIntervalMinutes: null })).toBe(true);
  for (const patch of [{}, { captureMode: null }, { captureMode: undefined }, { captureMode: 'invalid' },
    { foldersFirst: 'true' }, { otherAccount: 'foreign' }, { foldersFirst: true, userGesture: false }]) {
    expect(messages.validBookmarkPreferencesRequest({ ...base, ...patch })).toBe(false);
  }
  for (const choice of ['server', 'local']) expect(messages.validBookmarkPreferencesRequest({
    kind: 'known.bookmark.preferences.resolve', userGesture: true, choice,
  })).toBe(true);
  expect(messages.validBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.resolve', userGesture: true, choice: 'both' })).toBe(false);
});

test('range commands require the displayed preview, confirmation identity and typed choices', () => {
  expect(messages.validRootRequest({ kind: 'known.roots.get' })).toBe(true);
  expect(messages.validRootRequest({ kind: 'known.roots.get', preselectFolderId: '1' })).toBe(true);
  expect(messages.validRootRequest({ kind: 'known.roots.get', preselectFolderId: '' })).toBe(false);
  const permission = { kind: 'known.roots.permissionChanged', userGesture: true, granted: false };
  expect(messages.validRootRequest(permission)).toBe(true);
  expect(messages.validRootRequest({ ...permission, granted: 'yes' })).toBe(false);
  const confirm = { kind: 'known.roots.confirm', previewId: 'preview', confirmationId: 'command', treeDigest: 'sha256:tree' };
  expect(messages.validRootRequest(confirm)).toBe(true);
  expect(messages.validRootRequest({ ...confirm, shiftActions: [{ ref: 'one', action: 'keep' }, { ref: 'two', action: 'unmount' }], remoteDeleteRefs: ['ref'] })).toBe(true);
  for (const shiftActions of [null, Array(129).fill({ ref: 'one', action: 'keep' }), [null], [[]],
    [{ ref: '', action: 'keep' }], [{ ref: 'one', action: 'delete' }], [{ ref: 'one', action: 'keep', injected: true }]]) {
    expect(messages.validRootRequest({ ...confirm, shiftActions })).toBe(false);
  }
  for (const patch of [{ previewId: '' }, { confirmationId: 'a\u0000' }, { treeDigest: 'x'.repeat(257) },
    { selectedRefs: ['injected'] }, { remoteDeleteRefs: [2] }]) expect(messages.validRootRequest({ ...confirm, ...patch })).toBe(false);
  for (const kind of ['known.roots.preview', 'known.roots.update']) {
    const request = { kind, viewId: 'view', selectedRefs: ['one'], privateRefs: [] };
    expect(messages.validRootRequest(request)).toBe(true);
    for (const patch of [{ viewId: 'x'.repeat(65) }, { selectedRefs: Array(129).fill('ref') },
      { selectedRefs: [1] }, { privateRefs: [null] }, { injected: true }]) expect(messages.validRootRequest({ ...request, ...patch })).toBe(false);
  }
});

test('first-run confirmations bind advanced mode and exact snapshot proof while ordinary confirmation stays compatible', () => {
  const ordinary = { kind: 'known.firstRun.confirm', previewId: 'preview', confirmationId: 'command', libraryId: 'collection' };
  expect(messages.validFirstRunRequest(ordinary)).toBe(true);
  const proof = { scopeFingerprint: 'scope', treeDigest: 'sha256:tree', mode: 'upload',
    remoteSnapshotId: 'snapshot', remoteRevision: 'r1', remoteCursor: 'cursor', destructivePlanDigest: 'sha256:plan', confirmationProof: 'proof' };
  for (const mode of ['upload', 'download', 'mirror']) expect(messages.validFirstRunRequest({ ...ordinary,
    bootstrapMode: mode, advancedConfirmation: { ...proof, mode } })).toBe(true);
  for (const patch of [{ libraryId: '' }, { libraryId: 3 }, { bootstrapMode: undefined }, { bootstrapMode: 'invalid' },
    { bootstrapMode: 'merge' }, { bootstrapMode: 'upload' }, { advancedConfirmation: proof },
    { bootstrapMode: 'upload', advancedConfirmation: null }, { bootstrapMode: 'upload', advancedConfirmation: [] },
    { bootstrapMode: 'upload', advancedConfirmation: { ...proof, mode: 'download' } },
    { bootstrapMode: 'upload', advancedConfirmation: { ...proof, confirmationProof: '' } },
    { bootstrapMode: 'upload', advancedConfirmation: { ...proof, injected: true } }]) {
    expect(messages.validFirstRunRequest({ ...ordinary, ...patch })).toBe(false);
  }
  const preview = { kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: ['one'], excludedRefs: [] };
  expect(messages.validFirstRunRequest(preview)).toBe(true);
  for (const bootstrapMode of ['merge', 'upload', 'download', 'mirror']) expect(messages.validFirstRunRequest({ ...preview, bootstrapMode })).toBe(true);
  for (const patch of [{ viewId: '' }, { selectedRefs: Array(129).fill('ref') }, { excludedRefs: [null] }, { bootstrapMode: undefined }]) {
    expect(messages.validFirstRunRequest({ ...preview, ...patch })).toBe(false);
  }
  expect(messages.validFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: 'command' })).toBe(true);
  expect(messages.validFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: '' })).toBe(false);
  const attention = { kind: 'known.firstRun.attention.get', reportId: 'report' };
  expect(messages.validFirstRunRequest(attention)).toBe(true);
  expect(messages.validFirstRunRequest({ ...attention, cursor: 'next' })).toBe(true);
  expect(messages.validFirstRunRequest({ ...attention, cursor: 'x'.repeat(33) })).toBe(false);
  const decision = { kind: 'known.firstRun.attention.decide', reportId: 'report', itemId: 'item', decision: 'keep_both' };
  expect(messages.validFirstRunRequest(decision)).toBe(true);
  expect(messages.validFirstRunRequest({ ...decision, decision: 'keep_local', evidenceDigest: `sha256:${'a'.repeat(64)}` })).toBe(true);
  for (const patch of [{ decision: 'delete' }, { decision: 'keep_local' }, { decision: 'keep_local', evidenceDigest: 'invalid' }, { itemId: '' }]) {
    expect(messages.validFirstRunRequest({ ...decision, ...patch })).toBe(false);
  }
});

test('mount, remote-delete and native-wait choices require explicit identity and current CAS versions', () => {
  for (const kind of ['known.scope.detach', 'known.scope.rejoin']) {
    expect(messages.validScopeCommandRequest({ kind, mountId: 'mount' })).toBe(true);
    expect(messages.validScopeCommandRequest({ kind, mountId: '' })).toBe(false);
  }
  const remote = { kind: 'known.scope.remoteDelete', mountId: 'mount', confirmationToken: 'proof', affectedCount: 0 };
  expect(messages.validScopeCommandRequest(remote)).toBe(true);
  for (const affectedCount of [-1, 1.5, Infinity]) expect(messages.validScopeCommandRequest({ ...remote, affectedCount })).toBe(false);
  for (const policy of ['sync', 'confirm', 'keep_local']) expect(messages.validRemoteDeleteRequest({
    kind: 'known.remoteDelete.policy.set', userGesture: true, policy, expectedCasVersion: 0,
  })).toBe(true);
  const deletion = { kind: 'known.remoteDelete.decide', userGesture: true, decisionId: 'decision', action: 'apply', expectedCasVersion: 1, deleteRevision: 'r1' };
  for (const action of ['apply', 'restore', 'keep_local']) expect(messages.validRemoteDeleteRequest({ ...deletion, action })).toBe(true);
  for (const patch of [{ userGesture: false }, { action: 'unknown' }, { expectedCasVersion: 0 }, { deleteRevision: '' }]) {
    expect(messages.validRemoteDeleteRequest({ ...deletion, ...patch })).toBe(false);
  }
  const wait = { kind: 'known.nativeWait.confirm', userGesture: true, waitRef: 'wait', intentId: 'intent', generation: 1, action: 'bind', nativeId: 'native' };
  expect(messages.validNativeWaitRequest(wait)).toBe(true);
  for (const patch of [{ nativeId: '' }, { generation: 0 }, { generation: 1.5 }, { userGesture: false }, { waitRef: '' }, { action: 'unknown' }, { injected: true }]) {
    expect(messages.validNativeWaitRequest({ ...wait, ...patch })).toBe(false);
  }
  const { nativeId: _native, ...withoutNative } = wait;
  expect(messages.validNativeWaitRequest(withoutNative)).toBe(false);
  for (const action of ['keep_local_and_create', 'cancel']) {
    expect(messages.validNativeWaitRequest({ ...withoutNative, action })).toBe(true);
    expect(messages.validNativeWaitRequest({ ...wait, action })).toBe(false);
  }
});

test('batch preview, confirm and undo reject cross-selection titles and unconfirmed destructive requests', () => {
  expect(messages.validBatchRequest({ kind: 'known.batch.status' })).toBe(true);
  expect(messages.validBatchRequest({ kind: 'known.batch.status', planId: 'plan' })).toBe(true);
  expect(messages.validBatchRequest({ kind: 'known.batch.status', planId: '' })).toBe(false);
  const preview = { kind: 'known.batch.preview', operation: 'rename', nativeIds: ['one'], titles: { one: 'New title' } };
  expect(messages.validBatchRequest(preview)).toBe(true);
  for (const operation of ['move', 'delete']) expect(messages.validBatchRequest({ kind: 'known.batch.preview', operation, nativeIds: ['one'], targetParentId: 'parent' })).toBe(true);
  for (const patch of [{ operation: 'copy' }, { nativeIds: [''] }, { nativeIds: Array(501).fill('one') }, { targetParentId: '' },
    { titles: null }, { titles: [] }, { titles: { another: 'Foreign' } }, { titles: { one: '' } },
    { titles: { one: 'x'.repeat(513) } }, { injected: true }]) expect(messages.validBatchRequest({ ...preview, ...patch })).toBe(false);
  const confirm = { ...preview, kind: 'known.batch.confirm', commandId: 'command', previewDigest: 'sha256:preview', userGesture: true };
  expect(messages.validBatchRequest(confirm)).toBe(true);
  expect(messages.validBatchRequest({ ...confirm, secondConfirm: true })).toBe(true);
  for (const patch of [{ userGesture: false }, { commandId: '' }, { previewDigest: '' }, { secondConfirm: false }, { injected: true }]) {
    expect(messages.validBatchRequest({ ...confirm, ...patch })).toBe(false);
  }
  expect(messages.validBatchRequest({ kind: 'known.batch.undo', userGesture: true, planId: 'plan', commandId: 'undo' })).toBe(true);
  expect(messages.validBatchRequest({ kind: 'known.batch.undo', userGesture: false, planId: 'plan', commandId: 'undo' })).toBe(false);
});
