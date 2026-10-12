import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { SyncPullV02 } from '@know-n/colp/types';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { createPullApplier } from '../src/pull-applier.js';
import type { PullBookmarkApi } from '../src/pull-applier-types.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

export const scope: SyncScope = { environment: 'production', serverId: 'server-engine', serverOrigin: 'https://known.example',
  accountId: 'account-engine', browserProfileId: 'profile-engine', collectionId: 'collection-engine',
  replicaId: 'replica-engine', generation: 1 };

export async function setup(overrides: {
  snapshotRequired?: boolean; emptyCollection?: boolean;
  /**
   * No-op spelling kept for call sites that already name the production projector explicitly.
   * Since A-12/SR-16 the production `recoverVerifiedOrFreeze` projector is the default; opting
   * *out* now requires the explicit `useStandInProjector` below (there is deliberately no
   * unnamed way back to the synthetic path).
   */
  useVerifiedProjector?: boolean;
  /**
   * Explicit opt-in to the synthetic projector stand-in: it fabricates `snapshot:<colpId>`
   * native ids in memory and writes nothing, instead of running the production
   * `recoverVerifiedOrFreeze`. This is **not** the production path - it exists only for
   * fixtures whose subject is the engine state machine rather than projection identity.
   */
  useStandInProjector?: boolean;
  /**
   * Explicit opt-in to the real `createPullApplier` (A-12/SR-16). Fixtures that use it must
   * serve event-carrying pages: the real applier admits an Ack-only page only when its cursor
   * identity is unchanged or the response carries `Known-Sync-Cursor-Reissued: true`
   * (`pull-page-stager.ts` `pull_cursor_chain_invalid`). The default Ack-only applier below
   * covers the cursor-advance-only fixtures this harness is built around.
   */
  useRealPullApplier?: boolean;
  /** Allow the production Snapshot projector to exercise native move replay. */
  allowSnapshotMoves?: boolean;
  seedMount?: boolean;
  requestTimeoutMilliseconds?: number;
} = {}) {
  // There is deliberately no unnamed way back to the synthetic projector: an opt-out has to say
  // which non-production path it means.
  if (overrides.useVerifiedProjector === false && overrides.useStandInProjector !== true) {
    throw new Error('use_stand_in_projector');
  }
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' },
    selectedRoots: overrides.emptyCollection ? [] : ['root-old'],
    ...(overrides.emptyCollection ? { firstRun: 'running' as const, rootStatus: 'ready' as const } : {}) });
  if (!overrides.emptyCollection) await store.putMapping(scope, mapping('native-root', 'root-old', 'revision-0'));
  if (overrides.emptyCollection && overrides.seedMount !== false) {
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
  }
  const chromeNodes = new Map<string, { id: string; parentId?: string; index?: number; title?: string; url?: string }>([
    ['1', { id: '1', title: 'Bookmarks bar' }],
  ]);
  let chromeNextId = 1;
  const allocateChromeId = () => {
    do { chromeNextId += 1; } while (chromeNodes.has(String(chromeNextId)));
    return String(chromeNextId);
  };
  const order: string[] = []; const pullResponses: Array<Response | Promise<Response>> = [];
  const snapshotResponses: Array<Response | Promise<Response>> = []; const ackResponses: Array<Response | Promise<Response>> = [];
  const pullRequests: string[] = []; const pullCursorAuthorities: Array<{ readonly reissued?: boolean }> = [];
  const snapshotOrigins: Array<string | null> = [];
  const snapshotRequests: Array<{ url: string; headerSession: string | null }> = [];
  const snapshotMoveCalls: Array<{ readonly nativeId: string; readonly parentId?: string; readonly index?: number }> = [];
  const ackRequests: Array<{ body: string; key: string; headerSession: string | null }> = []; const scheduled: number[] = [];
  const clock = { now: 1_000 }; let crashAt: string | undefined;
  let recovered = false; let projectCalls = 0; let activeSessionId = 'session-engine';
  let activeSnapshotRequired = overrides.snapshotRequired === true; let activeCursor = 'cursor-0';
  const sessionForces: boolean[] = [];
  const sessionFailures: unknown[] = [];
  const forcedSessions: Array<{ sessionId?: string; state: 'active'; snapshotRequired: boolean; cursor: string }> = [];
  const push = { calls: 0, outcomes: [] as string[], async drain() { this.calls += 1; order.push('push');
    return { outcome: this.outcomes.shift() ?? 'idle' } as any; } };
  // A-12/SR-16: the engine harness now runs the production projector by default and can run
  // the production Pull applier on demand. Chrome stays a stand-in (the whole harness is one),
  // but page validation, cursor-chain admission, event application and crash recovery are the
  // production implementation whenever `useRealPullApplier` is set.
  const chromeBookmarkApi: PullBookmarkApi = {
    async create(input) {
      const id = allocateChromeId();
      chromeNodes.set(id, { id, parentId: input.parentId, index: input.index, title: input.title, url: input.url });
      return { id };
    },
    async update(id, changes) {
      const node = chromeNodes.get(id); if (!node) return;
      chromeNodes.set(id, { ...node, ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.url === undefined ? {} : { url: changes.url }) });
    },
    async move(id, destination) {
      const node = chromeNodes.get(id); if (!node) return;
      chromeNodes.set(id, { ...node, ...(destination.parentId === undefined ? {} : { parentId: destination.parentId }),
        ...(destination.index === undefined ? {} : { index: destination.index }) });
    },
    async remove(id) { chromeNodes.delete(id); },
    async removeTree(id) { removeChromeTree(chromeNodes, id); },
    async get(id) { const node = chromeNodes.get(id); return node ? [node] : []; },
    async getChildren(id) { return [...chromeNodes.values()].filter((node) => node.parentId === id); },
  };
  const effectPageTemplate = 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}';
  // Production rebuilds the applier per wake from the live Session (`src/sw/engine.ts:107-113`);
  // doing the same here keeps a renewed Session id from going stale inside the fixture.
  const realPullApplier = () => createPullApplier({ scope, store, api: chromeBookmarkApi,
    session: { acceptedProtocolVersion: '0.2', sessionId: activeSessionId, collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate, effectPageAuthority: 'https://known.example',
    endpoints: { syncPull: 'https://known.example/v1/pull', syncEffectPages: effectPageTemplate },
    credential: { accessToken: 'access-token' }, origin: 'chrome-extension://known-extension',
    now: () => clock.now,
    crash: (point: string) => { if (crashAt === point) { crashAt = undefined; throw new Error('worker_crash'); } } });
  // `order` stays the observable seam every engine fixture asserts on; the work behind it is
  // whichever applier this setup selected.
  const recordingApplier = (applier: { stage: (page: SyncPullV02,
    cursorAuthority?: { readonly reissued?: boolean }) => Promise<void>; resume: () => Promise<void> }) => ({
    async stage(page: SyncPullV02, cursorAuthority: { readonly reissued?: boolean } = {}) {
      pullCursorAuthorities.push(cursorAuthority); order.push(`stage:${page.nextCursor}`);
      return applier.stage(page, cursorAuthority);
    },
    async resume() { order.push('resume'); return applier.resume(); },
  });
  /**
   * A-12/SR-16: the **Ack-only** Pull applier, named so no fixture can mistake it for the real
   * one. It stages exactly the cursor pair the engine handed it with zero events, which is the
   * "server had nothing new" shape every existing engine fixture serves via `emptyPullPage()`.
   * It refuses event-carrying pages outright: applying events is the real applier's job, so a
   * fixture that stages one must opt into `useRealPullApplier`.
   */
  const ackOnlyPullApplier = () => {
    let stagedPage: string | null = null;
    return {
      async stage(page: SyncPullV02) {
        if (page.events.length > 0) throw new Error('ack_only_pull_applier_cannot_apply_events');
        if ((await store.getCursor(scope))?.cursor === page.nextCursor) { stagedPage = null; return; }
        stagedPage = `page:${page.nextCursor}`; const durable = await store.getCursor(scope);
        await store.stagePullPage(scope, { pageId: stagedPage,
          previousCursor: durable?.cursor ?? (await store.getScope(scope))?.checkpoint?.cursor ?? 'cursor-0',
          nextCursor: page.nextCursor, collectionRevision: page.collectionRevision,
          pageDigest: 'sha256:ack-only', events: [] });
      },
      async resume() {
        if (stagedPage) { await store.completePullPage(scope, stagedPage); stagedPage = null; return; }
        const leftover = await store.listPullPages(scope, ['staged']);
        if (leftover[0]) await store.completePullPage(scope, String(leftover[0].pageId));
      },
    };
  };
  // A-12/SR-16: the real applier is opt-in because the production cursor-chain rule
  // (`pull_cursor_chain_invalid`) rejects the event-less cursor-advance page that all 67 engine
  // Pull fixtures serve; making it the default was measured at 69/200 consumer tests red in 9 of
  // 14 files, two of which this lane must not edit. See
  // `durable-sync-engine-real-pull-applier.test.ts` for the full record.
  const pullApplier = overrides.useRealPullApplier
    // Same shape as `src/sw/engine.ts:116-117`: a fresh applier bound to the live Session per call.
    ? recordingApplier({ stage: (page, cursorAuthority) => realPullApplier().stage(page, cursorAuthority),
      resume: () => realPullApplier().resume() })
    : recordingApplier(ackOnlyPullApplier());
  const options: any = { scope, store, origin: 'chrome-extension://known-extension',
    requestTimeoutMilliseconds: overrides.requestTimeoutMilliseconds,
    endpoints: async () => ({ syncPull: 'https://known.example/v1/pull',
      syncAck: 'https://known.example/v1/ack', syncSnapshot: 'https://known.example/v1/snapshot',
      // The real applier binds effect-page downloads to this template (`assertPullApplierGate`).
      syncEffectPages: effectPageTemplate }),
    sessions: { async get(force = false) { sessionForces.push(force);
      if (sessionFailures.length) throw sessionFailures.shift();
      const classified = force ? forcedSessions.shift() : undefined;
      if (force && (recovered || classified)) {
        activeSessionId = classified?.sessionId ?? 'session-renewed';
        activeSnapshotRequired = classified?.snapshotRequired ?? false;
        activeCursor = classified?.cursor ?? 'cursor-recovered';
      }
      return { credential: { accessToken: 'access-token' },
        session: { ...session(activeSnapshotRequired), sessionId: activeSessionId,
          snapshotRequired: activeSnapshotRequired,
          replicaLease: { ...session().replicaLease, state: classified?.state ?? 'active' },
          collection: { ...session().collection, serverCursor: activeCursor } } }; } },
    pullApplier, pushWorker: push, now: () => clock.now, random: () => 0.5, id: () => 'durable-id',
    schedule: (delay: number) => scheduled.push(delay),     snapshotProjector: async (plans: any[]) => {
      projectCalls += 1;
      if (crashAt === 'before_local_projection') { crashAt = undefined; throw new Error('worker_crash'); }
      // A-12/SR-16: production identity verification is the default; the synthetic stand-in
      // below is reachable only through its explicitly named opt-in.
      if (overrides.useStandInProjector !== true) {
        const result = await recoverVerifiedOrFreeze({
          scope, store, staged: plans, freezeUnprovenIdentity: true,
          api: {
            create: async (input) => {
              const id = allocateChromeId();
              chromeNodes.set(id, { id, parentId: input.parentId, index: input.index, title: input.title, url: input.url });
              return { id };
            },
            update: async (id, changes) => {
              await chromeBookmarkApi.update(id, changes);
              if (crashAt === 'after_snapshot_native_update') { crashAt = undefined; throw new Error('worker_crash'); }
            },
            move: async (id, destination) => {
              if (!overrides.allowSnapshotMoves) throw new Error('chrome_should_not_run');
              await chromeBookmarkApi.move(id, destination);
              snapshotMoveCalls.push({ nativeId: id, ...destination });
              if (crashAt === 'after_snapshot_native_move') { crashAt = undefined; throw new Error('worker_crash'); }
            },
            remove: () => Promise.reject(new Error('chrome_should_not_run')),
            removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
            get: async (id) => { const node = chromeNodes.get(id); return node ? [node] : []; },
            getChildren: async (id) => [...chromeNodes.values()].filter((node) => node.parentId === id),
          },
        });
        if (crashAt === 'after_local_projection') { crashAt = undefined; throw new Error('worker_crash'); }
        return result;
      }
      // Explicitly named stand-in (see `useStandInProjector`): fabricates native ids and writes
      // nothing durable. Never the production path.
      const projected: any[] = []; const pending = [...plans];
      while (pending.length) { const index = pending.findIndex((plan) => !plan.parentColpId
          || projected.some((parent) => parent.colpId === plan.parentColpId));
        const [plan] = pending.splice(index, 1); const parent = projected.find((item) => item.colpId === plan.parentColpId);
        const nativeId = parent ? `snapshot:${plan.colpId}` : 'native-root';
        projected.push({ ...plan, nativeId,
          rootNativeId: parent?.rootNativeId ?? nativeId,
          ...(parent ? { parentNativeId: parent.nativeId } : {}) }); }
      return projected; }, boundary: (point: string) => {
      if (crashAt === point) { crashAt = undefined; throw new Error('worker_crash'); } },
    fetch: async (url: string, init: RequestInit) => {
      if (url.includes('/pull')) { const cursor = new URL(url).searchParams.get('cursor'); order.push(`pull:${cursor}`);
        pullRequests.push(url); return await pullResponses.shift()!; }
      if (url.includes('/snapshot/conflicts')) {
        const snapshotId = new URL(url).searchParams.get('snapshotId');
        return json(200, { snapshotId, offset: 0, limit: 50, conflictCount: 0, conflicts: [], nextOffset: null });
      }
      if (url.includes('/snapshot')) { const requestHeaders = new Headers(init.headers);
        snapshotRequests.push({ url, headerSession: requestHeaders.get('Known-Sync-Session') });
        snapshotOrigins.push(requestHeaders.get('Origin'));
        return await snapshotResponses.shift()!; }
      const body = String(init.body); const key = new Headers(init.headers).get('Idempotency-Key')!;
      const headerSession = new Headers(init.headers).get('Known-Sync-Session');
      order.push(`ack:${JSON.parse(body).cursor}`); ackRequests.push({ body, key, headerSession });
      const response = await ackResponses.shift()!;
      if (response.status === 200) recovered = true; return response;
    } };
  let engine = createDurableSyncEngine(options);
  return { store, order, pullResponses, snapshotResponses, ackResponses, pullRequests, pullCursorAuthorities,
    snapshotOrigins, snapshotRequests, snapshotMoveCalls, ackRequests,
    scheduled, clock, push, sessionForces, sessionFailures, forcedSessions, chromeNodes,
    get sessionId() { return activeSessionId; }, set sessionId(value) { activeSessionId = value; },
    get crashAt() { return crashAt; }, set crashAt(value) { crashAt = value; }, get projectCalls() { return projectCalls; }, engine,
    reopen() { engine = createDurableSyncEngine(options); return engine; },
    async markAttempt(sequence: number) { const lease = await store.acquireLease(scope, 'test-owner', clock.now, 60_000);
      const claimed = await store.claimNextQueue(scope, 'test-owner', lease.fence, clock.now);
      const body = JSON.stringify({ sessionId: 'session-engine', batchId: claimed!.batchId, atomic: true,
        operations: [claimed!.payload] });
      await store.bindPushAttempt(scope, sequence, 'test-owner', lease.fence, { sessionId: 'session-engine',
        batchId: claimed!.batchId, idempotencyKey: claimed!.idempotencyKey, endpointIdentity: 'syncPush',
        mediaType: 'application/json', body, bodyDigest: claimed!.digest }); },
    enqueue: (opId: string, overrides: Record<string, unknown> = {}) => store.allocateSequenceAndEnqueue(scope, {
      opId, batchId: `batch-${opId}`,
      idempotencyKey: `key-${opId}`, digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { opId, replicaId: scope.replicaId, sequence: opId.endsWith('1') ? 1 : 2, collectionId: scope.collectionId,
        type: 'create_node', baseRevision: null, occurredAt: '2026-07-28T00:00:00Z', dependencies: [], payload: {},
        ...overrides } }, { allowUnstamped: true }) };
}

export async function seedLegacySpc2Bootstrap(store: ReturnType<typeof createSyncStateStore>) {
  const page = snapshot(1, false, null); const mappings = page.nodes.map((node: any) => mapping(
    node.id === 'root-server' ? 'native-root' : `snapshot:${node.id}`, node.id, page.revision));
  await store.stageRecoveryPage(scope, { snapshotId: page.snapshotId, revision: page.revision,
    syncCursor: page.syncCursor,
    capability: (page as { readonly recoveryCapability?: string }).recoveryCapability,
    identityDigest: 'sha256:legacy-spc2',
    rootNodeId: page.collection.rootNodeId,
    page: 0, pageDigest: 'sha256:legacy-page', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: page.nodes.map((node: any, index: number) => ({ colpId: node.id, parentId: node.parentId,
      position: String(node.position ?? `snapshot-0-${index}`), kind: node.kind === 'bookmark' ? 'Bookmark' : 'Folder',
      payloadDigest: `sha256:${node.id}`, mapping: mappings[index]! })) });
  await store.finalizeRecoveryMappings(scope, page.snapshotId, mappings);
  const body = JSON.stringify({ sessionId: 'session-engine', cursor: page.syncCursor, warnings: [] });
  await store.commitRecovery(scope, page.snapshotId, {
    intentId: 'legacy-spc2-intent', sessionId: 'session-engine',
    idempotencyKey: 'legacy-spc2-key', endpointIdentity: 'syncAck', mediaType: 'application/json',
    body, bodyDigest: createHash('sha256').update(body).digest('hex'),
  });
}

/** Recursive Chrome `removeTree` over the stand-in node map (the real API is recursive). */
function removeChromeTree(nodes: Map<string, { id: string; parentId?: string }>, id: string): void {
  for (const child of [...nodes.values()].filter((node) => node.parentId === id)) removeChromeTree(nodes, child.id);
  nodes.delete(id);
}

function session(snapshotRequired = false) { return { sessionId: 'session-engine', expiresAt: '2099-01-01T00:00:00Z',
  scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const, snapshotRequired,
  collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
  replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active',
    expiresAt: '2099-01-01T00:00:00Z' }, conversionPolicy: { separator: 'preserve_remote' as const } }; }
/**
 * A-12/SR-16: the **Ack-only (empty) Pull page**, named explicitly.
 *
 * `events: []` is the "the server had nothing new for this cursor" shape the engine fixtures
 * need in order to exercise cursor publication, Ack, sleep cadence and crash recovery without
 * dragging a data mutation along. It is a deliberate, named choice at every call site - the
 * default page builder is no longer an unnamed empty page. The real applier admits this shape
 * only when the Ack is the whole story (see `useRealPullApplier`).
 */
export function emptyPullPage(cursor: string) { return { events: [], nextCursor: cursor, hasMore: false,
  collectionRevision: 'revision-1', recommendedPullAfterSeconds: 30 }; }
/**
 * @deprecated Use `emptyPullPage` (Ack-only, explicitly named) or `pullEventsPage` (real
 * events). This alias exists only so the two harness consumers the SR-16 lane must not edit
 * (`outbound-push-worker-rebase.test.ts`, `srg-t04-pull-freeze-rewind.test.ts`) keep compiling
 * unchanged; new call sites must name which shape they mean.
 */
export const pullPage = emptyPullPage;
/**
 * A Pull page that carries real events, for fixtures that opt into `useRealPullApplier`.
 * The last event's cursor is aligned with `nextCursor`, which is the chain rule the real
 * applier enforces (`pull-page-stager.ts`).
 */
export function pullEventsPage(events: readonly unknown[], nextCursor: string,
  overrides: Record<string, unknown> = {}) {
  return { ...pullFixtures.page({ events, nextCursor, collectionRevision: 'revision-1' }), ...overrides };
}
export function ack(cursor: string) { return { replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' }; }
export function snapshot(sequence: number, hasMore: boolean, nextCursor: string | null) { const id = sequence === 1 ? 'root-server' : 'node-a';
  return { protocolVersion: '0.2', snapshotId: 'snapshot-engine', mode: 'sync', complete: true,
    collection: { schemaVersion: '0.1', id: scope.collectionId, kind: 'bookmarks', title: 'Engine',
      rootNodeId: 'root-server', visibility: 'private', createdAt: '2026-07-28T00:00:00Z',
      updatedAt: '2026-07-28T00:00:00Z', revision: 'revision-snapshot', extensions: {} },
    nodes: [{ id, collectionId: scope.collectionId, kind: sequence === 1 ? 'root' : 'bookmark',
      parentId: sequence === 1 ? null : 'root-server', position: sequence === 1 ? null : `p${sequence}`,
      ...(sequence === 1 ? { folderRole: 'root' } : {}), revision: `revision-${id}`,
      createdAt: '2026-07-28T00:00:00Z', updatedAt: '2026-07-28T00:00:00Z', extensions: {},
      title: id, ...(sequence === 2 ? { url: 'https://example.test/' } : {}) }], annotations: [], attachments: [],
    relations: [], tombstones: [], revision: 'revision-snapshot',
    syncCursor: 'bootstrap-cursor',
    generatedAt: '2026-07-28T00:00:00Z', parentRevisions: sequence === 1
      ? [{ parentId: 'root-server', childrenRevision: 'children-root' }] : [],
    page: { nextCursor, hasMore, sequence }, warnings: [] }; }
export function nonemptyMountSnapshot(includeChild = true) {
  const base = snapshot(1, false, null);
  const stamp = { collectionId: scope.collectionId, createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z', extensions: {} };
  const mount = { id: 'mount-bar', kind: 'folder' as const, parentId: 'root-server', position: 'p1',
    folderRole: 'bookmarks-bar' as const, revision: 'revision-mount-bar', title: 'Bar', ...stamp };
  const child = { id: 'child-a', kind: 'bookmark' as const, parentId: 'mount-bar', position: 'p2',
    revision: 'revision-child-a', title: 'Child', url: 'https://example.test/child', ...stamp };
  return { ...base, nodes: [base.nodes[0]!, mount, ...(includeChild ? [child] : [])], parentRevisions: [
    { parentId: 'root-server', childrenRevision: 'children-root' },
    { parentId: 'mount-bar', childrenRevision: 'children-bar' }] };
}
export function recoverySnapshot(sequence: number, hasMore: boolean, nextCursor: string | null) {
  return { ...snapshot(sequence, hasMore, nextCursor),
    ...(hasMore ? {} : { recoveryCapability: 'src1.recovery-capability' }) };
}
function mapping(nativeId: string, colpId: string, revision: string, nodeKind: 'folder' | 'bookmark' = 'folder') {
  return { nativeId, colpId,
  rootNativeId: nativeId.startsWith('snapshot:') ? 'snapshot:root-server' : nativeId,
  projection: { revision, ...(nodeKind === 'folder' ? { childrenRevision: 'children-authority' } : {}),
    digest: `sha256:${colpId}` }, nodeKind }; }
export function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
export function problem(status: number, code: string, recovery: object) { return new Response(JSON.stringify({
  type: `https://know-n.com/colp/problems/${code}`, title: code, status, code, recovery }), { status,
  headers: { 'Content-Type': 'application/problem+json' } }); }
// Real transport rejections carry a fetch signature ('Failed to fetch' in
// Chromium); a bare TypeError without one is a local defect, not connectivity.
export function networkFailure(message = 'network lost') { return { then(_resolve: (value: Response) => void,
  reject: (reason: unknown) => void) { reject(new TypeError(`Failed to fetch (${message})`)); } } as unknown as Promise<Response>; }
export function abortFailure() { return ({ then(_resolve: (value: Response) => void,
  reject: (reason: unknown) => void) { reject(new DOMException('The operation was aborted', 'AbortError')); } }) as unknown as Promise<Response>; }
