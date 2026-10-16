/**
 * KNS-08 dual-Profile evidence harness.
 * Owner: KNS-08 (QA). Reuses e2e/real-stack.ts startRealStack/PushFault (F-09)
 * and the profileA/profileB mkdtemp + launchPersistentContext restart shape from
 * e2e/mv3-multi-device-recovery.spec.ts / e2e/mv3-bookmark-roots.spec.ts.
 * Do not copy a second Chromium Profile manager.
 *
 * Fixture: config/e2e-fixture.json production MV3 + startRealStack Postgres.
 * Run: npm run evidence:first-run-sync
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { hasDownloadPathSettlement, hasFirstRunSettlementProof } from './first-run-settlement.js';
import { EXTENSION_ID, openExtensionOptions, waitForLibraryBinding, showOptionsPane, signInExtension } from './extension-auth.js';
import { fixtureCollectionId } from './external-backend.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { redactEvidenceText } from './kns-08-redact.js';
import { startRealStack, type PushFault, type RealStack } from './real-stack.js';

export { EXTENSION_ID, FIXTURE_COLLECTION_ID, redactEvidenceText, startRealStack };
export type { PushFault, RealStack };

export const KNS08_BINDINGS = [
  { replicaId: 'replica-kns08-a', browserProfileId: 'profile-kns08-a', generation: '1' as const },
  { replicaId: 'replica-kns08-b', browserProfileId: 'profile-kns08-b', generation: '1' as const },
] as const;

export const UNSELECTED_SENTINEL = 'UNSELECTED-SENTINEL';
export const UNSELECTED_URL = 'https://sentinel.invalid/unselected';
export const PUBLIC_URL = 'https://example.test/kns08/public';

const extensionPath = resolve(import.meta.dirname, '../dist/production');

export type ProfileBinding = RealStack['extensionBinding'];

export function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function launchPersistent(profileDir: string, resolverRules: string): Promise<BrowserContext> {
  const browser = process.env.KNS_08_BROWSER ?? 'chromium';
  if (browser !== 'chromium' && browser !== 'msedge') throw new Error(`Unsupported KNS_08_BROWSER: ${browser}`);
  const executablePath = process.env.KNS_08_EDGE_EXECUTABLE;
  if (executablePath && browser !== 'msedge') throw new Error('KNS_08_EDGE_EXECUTABLE requires msedge');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, channel: browser, ignoreHTTPSErrors: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${resolverRules}`, '--no-proxy-server', '--ignore-certificate-errors',
    ],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const session = await context.newCDPSession(page);
    const version = await session.send('Browser.getVersion');
    await session.detach();
    if (browser === 'msedge' && !/Edg\//u.test(version.userAgent)) {
      throw new Error('Edge validation requires an actual Microsoft Edge runtime');
    }
    test.info().annotations.push({ type: 'kns08-browser', description: JSON.stringify({
      channel: browser, product: version.product, userAgent: version.userAgent,
    }) });
    return context;
  } catch (error) { await context.close(); throw error; }
}

export function profileDir(label: 'a' | 'b'): string {
  return resolve(tmpdir(), `known-kns08-profile-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export async function optionsPage(context: BrowserContext): Promise<Page> {
  return (await openExtensionOptions(context)).page;
}

export async function login(page: Page, binding: ProfileBinding): Promise<void> {
  await page.evaluate((value) => chrome.storage.local.set({ 'known.auth.binding.v1': value }), binding);
  if (await page.locator('body').getAttribute('data-state') !== 'connected') {
    await signInExtension(page, fixtureCollectionId());
  }
  await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
  await waitForLibraryBinding(page, fixtureCollectionId());
  await expect.poll(async () => {
    await runtimeMessage(page, { kind: 'known.auth.status' }).catch(() => undefined);
    const roots = await runtimeMessage<{ ok?: boolean; error?: string }>(page, { kind: 'known.roots.get' })
      .catch((error: unknown) => ({ ok: false, error: String(error) }));
    return roots?.ok === true ? 'ok' : `roots=${roots?.error ?? 'missing'}`;
  }, { timeout: 60_000 }).toBe('ok');
}

export async function grantBookmarks(page: Page): Promise<void> {
  await showOptionsPane(page, 'folders');
  if (await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))) return;
  await page.evaluate(() => document.getElementById('kns08-grant-bookmarks')?.remove());
  const production = page.getByRole('button', { name: 'Allow bookmark access' });
  if (await production.isVisible().catch(() => false)) {
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known kns08 permission');
  } else {
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'kns08-grant-bookmarks';
      button.textContent = 'Grant kns08 access';
      button.addEventListener('click', () => {
        void chrome.permissions.request({ permissions: ['bookmarks'] });
      });
      document.body.append(button);
    });
    await grantOptionalBookmarks(page, 'Grant kns08 access', 'Known kns08 permission');
    await page.evaluate(() => document.getElementById('kns08-grant-bookmarks')?.remove());
  }
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
  const changed = await runtimeMessage<{ ok?: boolean; error?: string }>(page, {
    kind: 'known.roots.permissionChanged', userGesture: true, granted: true,
  });
  if (changed?.ok !== true) throw new Error(`permission_changed_failed:${changed?.error ?? 'missing'}`);
}

export async function revokeBookmarks(page: Page): Promise<void> {
  await showOptionsPane(page, 'folders');
  await page.getByRole('button', { name: 'Remove bookmark access' }).click();
  await page.getByRole('button', { name: 'Remove access' }).click();
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(false);
}

export async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({
    kind: 'known.sync-state.evidence', method, args,
  }), { method, args }) as { ok?: boolean; error?: string; value?: T };
  if (!result?.ok) throw new Error(result?.error ?? 'evidence_method_failed');
  return result.value as T;
}

export async function runtimeMessage<T = unknown>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate((payload) => chrome.runtime.sendMessage(payload), message) as Promise<T>;
}

export function scopeFor(stack: RealStack, binding: ProfileBinding) {
  return {
    environment: 'production' as const, serverId: stack.serverOrigin, serverOrigin: stack.serverOrigin,
    accountId: stack.authUserId, browserProfileId: binding.browserProfileId,
    collectionId: fixtureCollectionId(), replicaId: binding.replicaId, generation: 1,
  };
}

export async function specialRoots(page: Page): Promise<{ barId: string; otherId: string; barTitle: string;
  otherTitle: string }> {
  return page.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0]!.children![0]!;
    const other = tree[0]!.children![1]!;
    return { barId: bar.id, otherId: other.id, barTitle: bar.title ?? 'Bookmarks bar',
      otherTitle: other.title ?? 'Other bookmarks' };
  });
}

export async function treeProjection(page: Page): Promise<{ digest: string; bookmarkCount: number;
  folderCount: number; titles: readonly string[] }> {
  const snapshot = await page.evaluate(async () => {
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): Array<{ k: string; t: string }> => {
      const rows: Array<{ k: string; t: string }> = [];
      for (const node of nodes) {
        rows.push({ k: node.url ? 'b' : 'f', t: node.title ?? '' });
        if (node.children) rows.push(...walk(node.children));
      }
      return rows;
    };
    return walk((await chrome.bookmarks.getTree())[0]?.children ?? []);
  });
  return {
    digest: `sha256:${sha(JSON.stringify(snapshot.map((row) => row.k)))}`,
    bookmarkCount: snapshot.filter((row) => row.k === 'b').length,
    folderCount: snapshot.filter((row) => row.k === 'f').length,
    titles: snapshot.map((row) => row.t),
  };
}

export async function bookmarkPlacement(page: Page, titlePrefix: string): Promise<{
  readonly title: string; readonly parentTitle: string;
}> {
  const found = await page.evaluate(async (prefix) => {
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentTitle: string):
      Array<{ title: string; parentTitle: string }> => {
      const rows: Array<{ title: string; parentTitle: string }> = [];
      for (const node of nodes) {
        if ((node.title ?? '').startsWith(prefix) && Boolean(node.url)) {
          rows.push({ title: node.title ?? '', parentTitle });
        }
        if (node.children) rows.push(...walk(node.children, node.title ?? ''));
      }
      return rows;
    };
    return walk((await chrome.bookmarks.getTree())[0]?.children ?? [], '');
  }, titlePrefix);
  expect(found, `expected exactly one bookmark starting with ${titlePrefix}`).toHaveLength(1);
  return found[0]!;
}

const LIVE_QUEUE = new Set(['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected']);
const FATAL_RECOVERY = new Set(['invalid_json', 'invalid_document']);

export interface ScopeFacts {
  readonly firstRun?: string;
  readonly queueStatuses: readonly string[];
  readonly queueTypes: readonly string[];
  readonly queueOpIds: readonly string[];
  readonly queueRecoveries: readonly string[];
  readonly mappingCount: number;
  readonly receiptCount: number;
  readonly bootstrapAckComplete: boolean;
  readonly pendingAckCount: number;
  readonly pendingCaptureCount: number;
  readonly captureStates: readonly string[];
  readonly diagnosticCodes: readonly string[];
  readonly ackedCursor: string | null;
  readonly cursor: string | null;
  readonly mountRoles: readonly string[];
  readonly bootstrapPhase?: string;
  readonly retryReason?: string;
  readonly recoveryFrozen?: boolean;
  readonly errorCode?: string;
  readonly recoveryCode?: string;
  readonly rejectedPending?: boolean;
  readonly enginePhase?: string;
  readonly sessionReady?: boolean;
}

export async function scopeFacts(page: Page, _stack: RealStack, _binding: ProfileBinding): Promise<ScopeFacts> {
  const exported = await evidence<any>(page, 'exportOutboundPushEvidence');
  const engine = await evidence<any>(page, 'syncEngineState').catch(() => ({}));
  const scope = exported.scope ?? {};
  const run = (exported.bootstrapRuns ?? [])[0] ?? {};
  const queue = exported.queue ?? [];
  return {
    firstRun: scope.firstRun, queueStatuses: queue.map((row: any) => String(row.status)),
    queueTypes: queue.map((row: any) => String(row.payload?.type ?? '')),
    queueOpIds: queue.map((row: any) => String(row.opId ?? '')),
    queueRecoveries: queue.map((row: any) => String(row.recovery?.code ?? '')),
    mappingCount: (exported.mappings ?? []).length, receiptCount: (exported.receipts ?? []).length,
    bootstrapAckComplete: (exported.ackIntents ?? []).some((row: any) => row.kind === 'bootstrap' && row.state === 'complete'),
    pendingAckCount: (exported.ackIntents ?? []).filter((row: any) => row.state !== 'complete').length,
    pendingCaptureCount: (exported.bookmarkEvents ?? []).filter((row: any) => row.status !== 'processed').length,
    captureStates: (exported.bookmarkEvents ?? []).map((row: any) => `${row.kind}:${row.status}`),
    diagnosticCodes: (exported.diagnostics ?? []).map((row: any) => String(row.code ?? row.kind ?? 'unknown')).slice(-8),
    ackedCursor: exported.engine?.lastAckedCursor ?? null,
    cursor: exported.cursor?.cursor ?? exported.scope?.checkpoint?.cursor ?? null,
    mountRoles: (exported.mountBindings ?? []).map((row: any) => String(row.rootRole ?? row.customSourceKey ?? '')),
    bootstrapPhase: run.phase, retryReason: run.retryReason,
    recoveryFrozen: engine.recoveryFrozen === true, rejectedPending: engine.rejectedPending === true,
    errorCode: engine.errorCode,
    recoveryCode: scope.metadata?.recoveryCode,
    enginePhase: engine.phase, sessionReady: engine.sessionReady === true,
  };
}

export function assertQueueTerminal(facts: ScopeFacts): void {
  expect(facts.mappingCount).toBeGreaterThan(0);
  expect(hasFirstRunSettlementProof(facts)).toBe(true);
  expect(facts.cursor).not.toBeNull();
  expect(facts.cursor).toBe(facts.ackedCursor);
  expect(facts.pendingAckCount).toBe(0);
  expect(facts.pendingCaptureCount).toBe(0);
  expect(facts.queueStatuses.filter((status) => LIVE_QUEUE.has(status))).toEqual([]);
}

export async function wakeEngine(page: Page): Promise<void> {
  await evidence(page, 'wakeOutboundPushEvidence');
}

/** Playwright setOffline(false) does not fire the SW online handler. */
export async function restoreConnectivity(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  const wake = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' })) as {
    readonly ok?: boolean };
  if (wake?.ok !== true) throw new Error('connectivity_online_failed');
}

export async function drainBookmarkEvents(page: Page): Promise<void> {
  await evidence(page, 'drainBookmarkEventCaptureEvidence').catch(() => undefined);
}

export async function waitEngineReady(page: Page, timeout = 60_000): Promise<void> {
  await wakeEngine(page);
  await expect.poll(async () => {
    await wakeEngine(page);
    const state = await evidence<any>(page, 'syncEngineState').catch((error: unknown) => ({
      error: error instanceof Error ? error.message : 'sync_engine_unavailable',
    }));
    if (state.sessionReady === true && state.recoveryFrozen === false
      && (state.phase === 'sleeping' || state.phase === 'idle')) return 'ready';
    return `phase=${state.phase ?? 'missing'}|frozen=${state.recoveryFrozen}|session=${state.sessionReady}|err=${state.error ?? state.errorCode ?? 'none'}`;
  }, { timeout }).toBe('ready');
}

function quietLabel(facts: ScopeFacts, firstRun: boolean): string {
  const live = facts.queueStatuses.filter((status) => LIVE_QUEUE.has(status));
  const fatal = facts.queueRecoveries.some((code) => FATAL_RECOVERY.has(code));
  const phaseFinal = facts.bootstrapPhase === 'completed' || facts.bootstrapPhase === 'needs_attention';
  const aligned = hasDownloadPathSettlement(facts);
  const receiptsOk = facts.bootstrapPhase === 'needs_attention' ? aligned : hasFirstRunSettlementProof(facts);
  const firstRunSettled = firstRun
    && facts.recoveryFrozen !== true
    && facts.rejectedPending !== true
    && !fatal
    && live.length === 0
    && facts.mappingCount > 0
    && phaseFinal
    && receiptsOk;
  if (firstRunSettled) return 'quiet';
  if (!firstRun && facts.recoveryFrozen !== true && facts.rejectedPending !== true && !fatal
    && live.length === 0
    && (facts.enginePhase === 'sleeping' || facts.enginePhase === 'idle')
    && aligned) return 'quiet';
  return [
    live.length === 0 ? 'empty' : live.join(','),
    `frozen=${facts.recoveryFrozen === true}`,
    `rejected=${facts.rejectedPending === true}`,
    `fatal=${fatal}`,
    `phase=${facts.enginePhase ?? 'missing'}`,
    `boot=${facts.bootstrapPhase ?? 'none'}`,
    `maps=${facts.mappingCount}`,
    `receipts=${facts.receiptCount}`,
    `acks=${facts.pendingAckCount}`,
    `captures=${facts.pendingCaptureCount}`,
    `captureStates=${facts.captureStates.join(',') || 'none'}`,
    `diagnostics=${facts.diagnosticCodes.join(',') || 'none'}`,
    `cursors=${facts.cursor === facts.ackedCursor ? 'aligned' : 'drift'}`,
    `recovery=${facts.queueRecoveries.filter((code) => code.length > 0).join(',') || 'none'}`,
    `error=${facts.errorCode ?? 'none'}`,
    `scopeRecovery=${facts.recoveryCode ?? 'none'}`,
    `retry=${facts.retryReason ?? 'none'}`,
  ].join('|');
}

export async function waitQueueQuiet(page: Page, stack: RealStack, binding: ProfileBinding, timeout = 90_000,
  resume?: { readonly previewId: string; readonly confirmationId: string }): Promise<ScopeFacts> {
  await expect.poll(async () => {
    let facts = await scopeFacts(page, stack, binding);
    if (quietLabel(facts, Boolean(resume)) === 'quiet') return 'quiet';
    await drainBookmarkEvents(page);
    await wakeEngine(page);
    facts = await scopeFacts(page, stack, binding);
    if (resume && facts.recoveryFrozen !== true
      && facts.bootstrapPhase !== 'completed' && facts.bootstrapPhase !== 'needs_attention') {
      await resumeFirstRun(page, resume.previewId, resume.confirmationId);
      facts = await scopeFacts(page, stack, binding);
    }
    return quietLabel(facts, Boolean(resume));
  }, { timeout }).toBe('quiet');
  return scopeFacts(page, stack, binding);
}

/** First-run settled via product status + snapshot. Does not re-confirm or evidence-wake. */
export async function waitFirstRunProductQuiet(page: Page, stack: RealStack, binding: ProfileBinding,
  timeout = 90_000): Promise<ScopeFacts> {
  await expect.poll(async () => {
    await runtimeMessage(page, { kind: 'known.firstRun.status' }).catch(() => undefined);
    const facts = await scopeFacts(page, stack, binding);
    return quietLabel(facts, true);
  }, { timeout }).toBe('quiet');
  return scopeFacts(page, stack, binding);
}

export async function waitNonterminalQueue(page: Page, stack: RealStack, binding: ProfileBinding,
  timeout = 30_000): Promise<ScopeFacts> {
  await expect.poll(async () => {
    await drainBookmarkEvents(page);
    await wakeEngine(page);
    const facts = await scopeFacts(page, stack, binding);
    if (facts.queueStatuses.some((status) => LIVE_QUEUE.has(status) && status !== 'terminal')) return 'live';
    return quietLabel(facts, false);
  }, { timeout }).toBe('live');
  return scopeFacts(page, stack, binding);
}

export async function waitTitles(page: Page, titles: readonly string[], timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    await wakeEngine(page);
    const projection = await treeProjection(page);
    return titles.every((title) => projection.titles.includes(title)) ? 'present' : projection.titles.join('|');
  }, { timeout }).toBe('present');
}

export async function waitTitlesGone(page: Page, titles: readonly string[], timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    await wakeEngine(page);
    const projection = await treeProjection(page);
    return titles.every((title) => !projection.titles.includes(title)) ? 'gone' : 'present';
  }, { timeout }).toBe('gone');
}

export async function waitAnyTitle(page: Page, titles: readonly string[], timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    await wakeEngine(page);
    const projection = await treeProjection(page);
    return titles.some((title) => projection.titles.includes(title)) ? 'present' : projection.titles.join('|');
  }, { timeout }).toBe('present');
}

export async function captureReplayFacts(page: Page, stack: RealStack, binding: ProfileBinding): Promise<unknown> {
  const facts = await scopeFacts(page, stack, binding);
  const tree = await treeProjection(page).catch(() => ({ titles: [] as readonly string[], digest: '' }));
  return { ...facts, treeTitles: tree.titles, treeDigest: tree.digest };
}

export async function previewFirstRun(page: Page, selectedTitles: readonly string[],
  excludedTitles: readonly string[] = []): Promise<{
    readonly previewId: string; readonly treeDigest: string; readonly bookmarkCount: number;
    readonly folderCount: number; readonly skippedCount: number;
    readonly warnings: readonly { readonly code: string }[];
  }> {
  await showOptionsPane(page, 'folders');
  await page.getByRole('button', { name: 'Refresh folders' }).click();
  const view = await runtimeMessage<any>(page, { kind: 'known.roots.get' });
  if (!view?.ok || !view.view) throw new Error('roots_view_unavailable');
  const roots = view.view.roots as Array<{ ref: string; title: string; managed?: boolean }>;
  const selectedRefs = roots.filter((root) => !root.managed && selectedTitles.includes(root.title)).map((root) => root.ref);
  const excludedRefs = roots.filter((root) => !root.managed && excludedTitles.includes(root.title)).map((root) => root.ref);
  if (selectedRefs.length === 0) throw new Error('first_run_selection_empty');
  const preview = await runtimeMessage<any>(page, {
    kind: 'known.firstRun.preview', viewId: view.view.viewId, selectedRefs, excludedRefs,
  });
  if (!preview?.ok || typeof preview.previewId !== 'string') {
    throw new Error(`first_run_preview_failed:${JSON.stringify(preview)}`);
  }
  return {
    previewId: preview.previewId, treeDigest: preview.treeDigest, bookmarkCount: preview.bookmarkCount,
    folderCount: preview.folderCount, skippedCount: Number(preview.skippedCount ?? 0),
    warnings: Array.isArray(preview.warnings) ? preview.warnings : [],
  };
}

export async function confirmPreview(page: Page, previewId: string, confirmationId = crypto.randomUUID()): Promise<{
  readonly previewId: string; readonly confirmationId: string; readonly phase?: string; readonly firstRun?: string;
}> {
  const confirm = await runtimeMessage<any>(page, {
    kind: 'known.firstRun.confirm', previewId, confirmationId, libraryId: fixtureCollectionId(),
  });
  if (!confirm?.ok) throw new Error(`first_run_confirm_failed:${JSON.stringify(confirm)}`);
  await wakeEngine(page);
  return { previewId, confirmationId, phase: confirm.phase, firstRun: confirm.firstRun };
}

export async function confirmFirstRun(page: Page, selectedTitles: readonly string[], confirmationId = crypto.randomUUID(),
  excludedTitles: readonly string[] = []): Promise<{
    readonly previewId: string; readonly confirmationId: string; readonly treeDigest: string;
    readonly bookmarkCount: number; readonly folderCount: number; readonly skippedCount: number;
    readonly warnings: readonly { readonly code: string }[];
    readonly phase?: string; readonly firstRun?: string;
  }> {
  const preview = await previewFirstRun(page, selectedTitles, excludedTitles);
  const confirm = await confirmPreview(page, preview.previewId, confirmationId);
  return { ...preview, ...confirm };
}

export async function resumeFirstRun(page: Page, previewId: string, confirmationId: string): Promise<void> {
  const confirm = await runtimeMessage<any>(page, {
    kind: 'known.firstRun.confirm', previewId, confirmationId, libraryId: fixtureCollectionId(),
  });
  if (!confirm?.ok && confirm?.error !== 'preview_stale') {
    throw new Error(`first_run_resume_failed:${JSON.stringify(confirm)}`);
  }
  await wakeEngine(page);
}

export async function observePushUntil(page: Page, stack: RealStack, predicate: (obs: any) => boolean,
  timeout = 15_000): Promise<any> {
  const started = Date.now();
  let last: any;
  while (Date.now() - started < timeout) {
    last = await stack.observations();
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

export async function terminateWorker(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  try {
    const targets = await session.send('Target.getTargets');
    const worker = targets.targetInfos.find((target) => target.type === 'service_worker'
      && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
    if (!worker) throw new Error('extension worker target unavailable');
    const result = await session.send('Target.closeTarget', { targetId: worker.targetId });
    if (!result.success) throw new Error('extension worker termination failed');
  } finally { await session.detach(); }
}

/**
 * NOTE ON WHAT THIS FILE CANNOT DO — recorded so the gap is not re-discovered.
 *
 * Every interruption available here is a CLEAN stop. `terminateWorker` closes the
 * worker target and `browser.close()` asks the browser to exit; both let
 * JavaScript unwind, so pending awaits reject and `finally` blocks run. MV3's
 * actual failure mode is an abrupt reclaim where none of that happens, and this
 * harness cannot produce it: Playwright's typed protocol exposes no crash
 * primitive for a service-worker target (`Target.crashTarget` is absent), and it
 * does not hand out the browser process to kill.
 *
 * The existing `FR-...` crash tests come closer but do not close it:
 * `configureProjectionApplyBarrierEvidence` THROWS at the barrier rather than
 * blocking, and `waitBarrierHits` waits for that hit — so by the time the worker
 * is terminated the apply has already failed and unwound. What is still untested
 * is interruption while a durable multi-step write is genuinely mid-flight, which
 * needs either a blocking barrier or a kill primitive this harness does not have.
 * See `TEST-E2E-NO-RACE-TIMING`.
 */
export function evidenceRoot(testInfo?: TestInfo): string {
  return process.env.KNS_08_EVIDENCE_DIR?.trim()
    || (testInfo ? testInfo.outputPath('kns-08') : resolve(import.meta.dirname, '../test-results/kns-08-run'));
}

export async function writeScenarioEvidence(input: {
  readonly testInfo: TestInfo; readonly id: string; readonly ops: readonly unknown[];
  readonly startDigest: string; readonly endTree: unknown; readonly mapping: unknown;
  readonly cursor: unknown; readonly receipt: unknown; readonly logs: readonly string[];
  readonly extraRedact?: readonly string[];
}): Promise<string> {
  const dir = evidenceRoot(input.testInfo);
  await mkdir(dir, { recursive: true });
  const payload = {
    schemaVersion: 1, testId: input.id, startTreeDigest: input.startDigest,
    browsers: input.testInfo.annotations.filter((row) => row.type === 'kns08-browser')
      .map((row) => JSON.parse(row.description ?? '{}') as unknown),
    opSequence: input.ops, finalTree: input.endTree, mapping: input.mapping,
    cursor: input.cursor, receipt: input.receipt,
  };
  const extraRedact = [...new Set([UNSELECTED_SENTINEL, UNSELECTED_URL, ...(input.extraRedact ?? [])])];
  const text = redactEvidenceText(JSON.stringify(payload, null, 2), extraRedact);
  const path = resolve(dir, `${input.id}.json`);
  await writeFile(path, text);
  const logPath = resolve(dir, `${input.id}.log`);
  await writeFile(logPath, redactEvidenceText(input.logs.join('\n'), extraRedact));
  return dir;
}

export async function saveReplayFixture(testInfo: TestInfo, id: string, error: unknown, facts: unknown):
  Promise<void> {
  const dir = resolve(import.meta.dirname, '../test-results/kns-08-replay');
  await mkdir(dir, { recursive: true });
  const message = error instanceof Error ? error.message : String(error);
  const body = redactEvidenceText(JSON.stringify({
    schemaVersion: 1, testId: id, failedAt: new Date().toISOString(), message,
    facts, note: 'Do not rerun until the owning KNS task is flake-green.',
  }, null, 2), [UNSELECTED_SENTINEL, UNSELECTED_URL]);
  await writeFile(resolve(dir, `${id}.json`), body);
  await writeFile(testInfo.outputPath(`${id}.replay.json`), body);
}

export function collectLogs(context: BrowserContext): string[] {
  const logs: string[] = [];
  context.on('console', (message) => logs.push(`console:${message.type()}:${message.text()}`));
  context.on('request', (request) => logs.push(`request:${request.method()}:${request.url()}`));
  return logs;
}

export async function screenshotRedacted(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await showOptionsPane(page, 'account');
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

export function hasBrowserTrashFolder(titles: readonly string[]): boolean {
  return titles.some((title) => /^(trash|回收站)$/iu.test(title.trim()));
}

export async function liveCanonical(stack: RealStack): Promise<Array<Record<string, unknown>>> {
  const observed = await stack.observations() as { canonicalNodes?: Array<Record<string, unknown>> };
  return (observed.canonicalNodes ?? []).filter((node) => node.deleted_at == null && node.is_root !== true);
}

export async function liveTitles(stack: RealStack): Promise<string[]> {
  return (await liveCanonical(stack)).map((node) => String(node.title ?? ''));
}

export function assertPushEnvelopeReused(before: readonly string[] | undefined, after: unknown): void {
  if (!Array.isArray(after)) return;
  const prior = Array.isArray(before) ? before : [];
  const created = after.map((row) => String(row)).slice(prior.length);
  const reused = created.some((digest) => created.filter((row) => row === digest).length > 1);
  expect(created.length).toBeGreaterThan(0);
  expect(reused || new Set(created).size === 1).toBe(true);
}

export function assertNoSentinel(values: readonly string[], sentinels: readonly string[]): void {
  const blob = values.join('\n');
  for (const sentinel of sentinels) {
    expect(blob.includes(sentinel), `privacy sentinel leaked: ${sentinel}`).toBe(false);
  }
}
