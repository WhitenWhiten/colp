// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { projectSyncStatus, type SyncStatus } from '../src/sync-status.js';
import { SYNC_CHIP_REFRESH_MS, bindHubChrome, bindSyncChipRefresh } from '../src/options-hub-chrome.js';

function chip() {
  document.body.innerHTML = '<span id="side-name"></span><span id="hub-dot" hidden></span><a id="hub-signin" hidden></a><span id="hub-status"></span>';
  const node = (id: string) => document.getElementById(id)!;
  const status = node('hub-status'), name = node('side-name'), dot = node('hub-dot'), signIn = node('hub-signin');
  return { status, name, dot, signIn, chrome: bindHubChrome({ name, line: status, dot, signIn }) };
}

test('the sidebar status line uses the one account vocabulary (R13 E-18)', () => {
  const { status, chrome } = chip();
  const labels = (['connected', 'offline', 'connecting', 'refreshing', 'error', 'policy_blocked', 'signed_out'] as const)
    .map((value) => { chrome.setAccount(value); return status.textContent; });
  expect(labels).toEqual([
    'Signed in', 'Offline', 'Signing in', 'Renewing session', 'Sign-in problem', 'Sign-in problem', 'for optional sync',
  ]);
});

test('signed out shows the Sign in link and no dot; signed in shows the name and a dot', () => {
  const { name, dot, signIn, chrome } = chip();
  chrome.setAccount('signed_out');
  expect(name.textContent).toBe('Not signed in');
  expect(signIn.hidden).toBe(false);
  expect(dot.hidden).toBe(true);
  chrome.setAccount('connected', 'Ada');
  expect(name.textContent).toBe('Ada');
  expect(signIn.hidden).toBe(true);
  expect(dot.hidden).toBe(false);
});

test('the engine phase replaces the account line, only while connected', () => {
  const { status, chrome } = chip();
  chrome.setAccount('connected');
  chrome.setEnginePhase(projectSyncStatus('synced'), true);
  expect(status.textContent).toBe(projectSyncStatus('synced').label);
  chrome.setAccount('offline');
  expect(status.textContent).toBe('Offline');
});

test('the engine phase marks the dot tone to match its words', () => {
  const { dot, chrome } = chip();
  chrome.setAccount('connected');
  chrome.setEnginePhase(projectSyncStatus('review-conflicts'), true);
  expect(dot.dataset.tone).toBe('warning');
  chrome.setEnginePhase(projectSyncStatus('synced'), true);
  expect(dot.dataset.tone).toBeUndefined();
  chrome.setAccount('offline');
  expect(dot.dataset.tone).toBe('off');
});

test('signed in without sync set up reads "Sync is off", not "Waiting for network"', async () => {
  // The worker has no Session before first sync, so the engine status read
  // fails the same way it would offline; first-run state tells the two apart.
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: async (message: { kind: string }) => message.kind === 'known.firstRun.status'
      ? { ok: true, firstRun: 'none' } : { ok: false, error: 'not_connected' } },
  });
  try {
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    expect(await signedInSyncStatus()).toEqual(projectSyncStatus('setup-required'));
  } finally { vi.unstubAllGlobals(); }
});

test.each([
  { attention: { issueCount: 2, retryAutomatic: true }, expected: 'action-required' },
  { attention: { issueCount: 0, terminal: true }, expected: 'action-required' },
  { attention: { issueCount: 0, retryAutomatic: false }, expected: 'action-required' },
  { attention: { issueCount: 0, nativeWaitPending: true }, expected: 'action-required' },
  { attention: { issueCount: 2, conflictPending: true }, expected: 'review-conflicts' },
  { attention: { issueCount: 0, retryAutomatic: true }, expected: 'synced' },
] as const)('a sleeping engine projects $attention as $expected', async ({ attention, expected }) => {
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: async ({ kind }: { kind: string }) => {
      if (kind === 'known.firstRun.status') return { ok: true, firstRun: 'completed' };
      if (kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'sleeping', hasPendingWork: false } };
      if (kind === 'known.sync.attention.get') return { ok: true, attention };
      return { ok: false };
    } },
  });
  try {
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    expect(await signedInSyncStatus()).toEqual(projectSyncStatus(expected));
  } finally { vi.unstubAllGlobals(); }
});

test('a long-open options page re-reads the sync phrase instead of keeping its first reading', async () => {
  vi.useFakeTimers();
  const storageListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: (listener: typeof storageListeners[number]) => {
    storageListeners.push(listener); } } } });
  try {
    const { status, chrome } = chip();
    chrome.setAccount('connected');
    const labels = [projectSyncStatus('setup-required'), projectSyncStatus('synced'), projectSyncStatus('review-conflicts')];
    const refresh = bindSyncChipRefresh(chrome, { connected: () => true, read: async () => labels.shift()!,
      keys: ['known.sync.collection.v1'] });
    await refresh();
    expect(status.textContent).toBe('Sync is off');
    // First sync binds a collection: the storage change repaints at once.
    storageListeners.forEach((listener) => listener({ 'known.sync.collection.v1': {} }, 'local'));
    await vi.waitFor(() => expect(status.textContent).toBe('Synced'));
    storageListeners.forEach((listener) => listener({ 'unrelated.key': {} }, 'local'));
    await vi.advanceTimersByTimeAsync(SYNC_CHIP_REFRESH_MS);
    expect(status.textContent).toBe('Review conflicts');
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

test('a slower earlier read never paints over a later one', async () => {
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: () => undefined } } });
  try {
    const { status, chrome } = chip();
    chrome.setAccount('connected');
    let releaseSlow!: (label: SyncStatus) => void;
    const reads = [new Promise<SyncStatus>((resolve) => { releaseSlow = resolve; }), Promise.resolve(projectSyncStatus('synced'))];
    const refresh = bindSyncChipRefresh(chrome, { connected: () => true, read: () => reads.shift()!, keys: [] });
    const slow = refresh(); await refresh();
    releaseSlow(projectSyncStatus('setup-required')); await slow;
    expect(status.textContent).toBe('Synced');
  } finally { vi.unstubAllGlobals(); }
});
