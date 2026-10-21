import { pullAckWarnings } from './pull-item-set-aside.js';
import { readCompletedBootstrapState } from './bootstrap-ack-unfreeze.js';
import { enforceSyncIssueCeiling } from './sync-issue-ceiling.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { SnapshotNode, Warning } from '@know-n/colp/types';
import { readBoundedJson } from './json-response.js';
import { syncSnapshotV02 } from './generated/pull-effect-validators.js';
import type { AckIntentRecord, JsonObject, MappingInput } from './sync-state-store.js';
import type { DurableSyncSnapshot, EngineOptions } from './durable-sync-engine-types.js';
import { snapshotFailure } from './durable-sync-engine-errors.js';
import { discardExpiredRecoveryStaging, freezeScopeRecovery, isCursorExpiryCode,
  shouldFreezePullApply } from './pull-recovery-freeze.js';
import { assertCompleteSnapshotStaging } from './snapshot-staging-assert.js';
import { sessionTransportBudget } from './colp-transport-budget-browser.js';
import { persistSnapshotOpenConflicts, snapshotOpenConflictDetails } from './snapshot-conflict-recovery.js';
import { createSnapshotV02Accumulator } from './snapshot-v02-pages.js';
import {
  snapshotProjectionContent, snapshotV02PagesFromStaging, snapshotV02RejectMessage, toSnapshotV02Page,
  readSnapshotMaterializationVersion,
} from './snapshot-v02-consume.js';
import type { SessionAuthority } from './session-client.js';
import type { StoredSession } from './types.js';

const DEFAULT_PULL_LIMIT = 100;
const failedSnapshotByStore = new WeakMap<object, string>();

export interface SnapshotRecoveryRuntime {
  readonly options: EngineOptions;
  readonly now: () => number;
  transition(phase: import('./sync-state-store.js').DurableSyncEngineState['phase'],
    patch?: Partial<import('./sync-state-store.js').DurableSyncEngineState>): Promise<import('./sync-state-store.js').DurableSyncEngineState>;
  networkFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response>;
  headers(authority: { readonly credential: { readonly accessToken: string }; readonly session: StoredSession },
    origin?: string): Record<string, string>;
  projectRecovery(snapshotId: string): Promise<void>;
  sendAck(intent: AckIntentRecord, authority: { readonly credential: { readonly accessToken: string };
    readonly session: StoredSession }): Promise<'complete' | 'recovery' | 'discarded'>;
  renewBootstrapAuthority(capability: string): Promise<{ readonly credential: { readonly accessToken: string };
    readonly session: StoredSession }>;
  ackEnvelope(kind: AckIntentRecord['kind'], sessionId: string, cursor: string, recoveryCapability?: string, warnings?: readonly Warning[]):
    Omit<AckIntentRecord, 'scopeKey' | 'state'>;
  digest(value: unknown): string;
  state(): Promise<import('./sync-state-store.js').DurableSyncEngineState>;
}

export async function recoverSnapshot(
  runtime: SnapshotRecoveryRuntime,
  authority: { readonly credential: { readonly accessToken: string }; readonly session: StoredSession },
  classification: Exclude<SessionAuthority, 'active'>,
): Promise<import('./sync-state-store.js').DurableSyncEngineState> {
  try {
    return await recoverSnapshotPages(runtime, authority, classification);
  } catch (error) {
    // F005 sibling: a recovery denial (e.g. a capability issued before the final
    // Snapshot page) must freeze the scope/engine so the next wake refreshes
    // Session authority, instead of retrying the same denial every wake.
    if (shouldFreezePullApply(error)) {
      const code = error instanceof Error ? error.message : 'recovery_required';
      // F006: when the recovery window itself lapsed, the staged chain it authorized can never be
      // committed; drop it so the refreshed authority rebuilds the Snapshot from page 0.
      if (isCursorExpiryCode(code)) {
        await discardExpiredRecoveryStaging(runtime.options.store, runtime.options.scope, code);
      }
      await freezeScopeRecovery(runtime.options.store, runtime.options.scope, code, runtime.now);
    }
    throw error;
  }
}

async function recoverSnapshotPages(
  runtime: SnapshotRecoveryRuntime,
  authority: { readonly credential: { readonly accessToken: string }; readonly session: StoredSession },
  classification: Exclude<SessionAuthority, 'active'>,
): Promise<import('./sync-state-store.js').DurableSyncEngineState> {
  const { options, now } = runtime;
  if (!authority.session.snapshotRequired) throw new SyncFailureError('recovery_authority_invalid');
  const recoveryAuthority = classification === 'recovery';
  await runtime.transition('bootstrap', { sessionId: authority.session.sessionId, recoveryFrozen: true,
    authorityRefreshRequired: false });
  let header = await options.store.getRecoveryHeader(options.scope);
  let stagedNodes = header ? await options.store.listRecoveryNodes(options.scope, header.snapshotId) : [];
  if (header && header.sessionId !== authority.session.sessionId) {
    await options.store.discardRecoveryStaging(options.scope);
    header = null;
    stagedNodes = [];
  }
  if (header?.complete && header.nextCursor === null) {
    await commitPreparedRecovery(runtime, authority, header.snapshotId, header.syncCursor, header.capability);
  } else {
    let pageCursor: string | null = header?.nextCursor ?? null;
    let pageNumber = header ? Number(header.lastPage) + 1 : 0;
    let previousDigest: string | null = header?.lastPageDigest ?? null;
    const stagedIds = new Set(stagedNodes.map((item) => item.colpId));
    let stagedSnapshotId = header?.snapshotId;
    let replacedStaging = false;
    const accumulator = createSnapshotV02Accumulator();
    if (header && stagedNodes.length > 0) {
      for (const page of snapshotV02PagesFromStaging({
        collectionId: options.scope.collectionId, header, nodes: stagedNodes,
      })) {
        const seeded = accumulator.add(page);
        if (!seeded.ok) throw new Error(snapshotV02RejectMessage(seeded.code));
      }
    }
    const resetStaging = () => {
      replacedStaging = true; pageCursor = null; pageNumber = 0; previousDigest = null;
      stagedIds.clear(); stagedSnapshotId = undefined; header = null; accumulator.reset();
    };
    let pageLimit = DEFAULT_PULL_LIMIT;
    while (true) {
      await options.boundary?.('before_snapshot_page');
      const endpoints = await options.endpoints(); const url = new URL(endpoints.syncSnapshot);
      url.searchParams.set('sessionId', authority.session.sessionId); url.searchParams.set('limit', String(pageLimit));
      if (pageCursor) url.searchParams.set('pageCursor', pageCursor);
      const response = await runtime.networkFetch(url.toString(), { redirect: 'error', cache: 'no-store',
        headers: runtime.headers(authority, options.origin) });
      if (response.status !== 200 || !jsonContentType(response)) {
        if (response.status === 429) throw httpOrSnapshotFailure(response, now());
        if (response.status === 413) {
          // F013: the negotiated page budget cannot carry `pageLimit` Nodes at
          // this position — halve the page and rebuild the staged chain from
          // page 0 (a signed page cursor pins its limit, so a smaller page
          // cannot resume the old chain). A single Node that still exceeds the
          // budget is inexpressible; surface payload_too_large so the engine
          // freezes terminally instead of retrying forever.
          if (pageLimit <= 1) {
            throw Object.assign(new SyncFailureError('payload_too_large'), { code: 'payload_too_large' });
          }
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          await discardExpiredRecoveryStaging(options.store, options.scope, 'payload_too_large');
          resetStaging();
          continue;
        }
        const denial = await snapshotFailure(response, options.requestTimeoutMilliseconds);
        // F006: the Snapshot cursor window lapsed behind this staged chain (resume denied with
        // `sync_cursor_expired`). Nothing that chain carries can be committed in place, so drop it
        // and rebuild once from page 0 under the same authority; a second denial escalates to the
        // freeze below instead of looping.
        if (isCursorExpiryCode(denial) && !replacedStaging && header) {
          await discardExpiredRecoveryStaging(options.store, options.scope, denial);
          resetStaging();
          continue;
        }
        // F013: a chain staged at a halved page limit cannot resume under the
        // default limit — its signed page cursor pins the smaller limit, so the
        // continuation is denied invalid_cursor_scope. Discard it once and
        // rebuild from page 0, exactly like the expiry restart above.
        if (denial === 'snapshot_400_invalid_cursor_scope' && !replacedStaging
            && header && pageCursor !== null) {
          await discardExpiredRecoveryStaging(options.store, options.scope, denial);
          resetStaging();
          continue;
        }
        throw new Error(denial);
      }
      const document = await readBoundedJson(response, sessionTransportBudget(authority.session).snapshotPageBytes,
        'snapshot_invalid', { timeoutMilliseconds: options.requestTimeoutMilliseconds });
      if (!syncSnapshotV02(document)) throw new SyncFailureError('snapshot_invalid');
      const snapshot = document as DurableSyncSnapshot;
      if (recoveryAuthority && snapshot.page.hasMore && snapshot.recoveryCapability !== undefined) {
        throw new SyncFailureError('recovery_capability_premature');
      }
      const version = readSnapshotMaterializationVersion(snapshot);
      if (stagedSnapshotId && stagedSnapshotId !== snapshot.snapshotId && !replacedStaging) {
        await options.store.discardRecoveryStaging(options.scope);
        resetStaging();
        continue;
      }
      if (failedSnapshotByStore.get(options.store) === snapshot.snapshotId) {
        throw new SyncFailureError('snapshot_graph_incomplete');
      }
      if (!snapshot.complete || snapshot.collection.id !== options.scope.collectionId
          || snapshot.page.sequence !== pageNumber + 1) throw new SyncFailureError('snapshot_chain_invalid');
      const rootId = snapshot.collection.rootNodeId;
      if (snapshot.collection.revision !== snapshot.revision
          || snapshot.annotations.length !== 0 || snapshot.attachments.length !== 0
          || snapshot.relations.length !== 0 || snapshot.tombstones.length !== 0
          || snapshot.nodes.some((node) => node.collectionId !== options.scope.collectionId
            || (node.id === rootId) !== (node.kind === 'root' && node.parentId === null)
            || (node.parentId === null) !== (node.id === rootId)
            || (node.id === rootId ? node.position != null : typeof node.position !== 'string'))) {
        throw new SyncFailureError('snapshot_semantic_invalid');
      }
      const accumulated = accumulator.add(toSnapshotV02Page(snapshot));
      if (!accumulated.ok) {
        if (!replacedStaging && (accumulated.code === 'graph_invalid' || accumulated.code === 'identity_conflict')) {
          await options.store.discardRecoveryStaging(options.scope);
          resetStaging();
          continue;
        }
        failedSnapshotByStore.set(options.store, snapshot.snapshotId);
        throw new Error(snapshotV02RejectMessage(accumulated.code));
      }
      const pageIds = new Set(snapshot.nodes.map((node) => node.id));
      if (pageIds.size !== snapshot.nodes.length || snapshot.nodes.some((node) => node.parentId !== null
          && !stagedIds.has(node.parentId) && !pageIds.has(node.parentId))) throw new SyncFailureError('snapshot_graph_incomplete');
      const mappings = snapshot.nodes.map((node): MappingInput => {
        const parentAuthority = snapshot.parentRevisions.find((item) => item.parentId === node.id);
        if ((node.kind === 'folder' || node.kind === 'root') && !parentAuthority) {
          throw new SyncFailureError('snapshot_parent_authority_missing');
        }
        return snapshotMapping(node, parentAuthority?.childrenRevision ?? null, runtime.digest);
      });
      const mappingById = new Map(mappings.map((mapping) => [mapping.colpId, mapping]));
      const pageDigest = runtime.digest(document); const complete = !snapshot.page.hasMore;
      if (complete && recoveryAuthority && !recoveryCapability(snapshot.recoveryCapability)) {
        throw new SyncFailureError('recovery_capability_invalid');
      }
      await options.store.stageRecoveryPage(options.scope, { snapshotId: snapshot.snapshotId,
        sessionId: authority.session.sessionId,
        revision: snapshot.revision, syncCursor: snapshot.syncCursor,
        capability: snapshot.recoveryCapability,
        identityDigest: snapshotIdentityDigest(snapshot, runtime.digest), rootNodeId: snapshot.collection.rootNodeId,
        page: pageNumber, pageDigest, materializationVersion: version,
        previousPageDigest: previousDigest, nextCursor: snapshot.page.nextCursor, complete,
        nodes: snapshot.nodes.map((node, index) => ({ colpId: node.id, parentId: node.parentId,
          position: String(node.position ?? `snapshot-${pageNumber}-${index}`),
          kind: node.kind === 'separator' ? 'Separator' : node.kind === 'bookmark' ? 'Bookmark' : 'Folder',
          payloadDigest: runtime.digest(node), mapping: mappingById.get(node.id)! })) });
      await options.boundary?.('after_snapshot_page'); mappings.forEach((mapping) => stagedIds.add(mapping.colpId));
      if (complete) {
        failedSnapshotByStore.delete(options.store);
        await assertCompleteSnapshotStaging(options.store, options.scope, snapshot.collection.rootNodeId);
        await commitPreparedRecovery(runtime, authority, snapshot.snapshotId, snapshot.syncCursor,
          snapshot.recoveryCapability); break; }
      if (!snapshot.page.nextCursor) throw new SyncFailureError('snapshot_chain_invalid');
      pageCursor = snapshot.page.nextCursor; previousDigest = pageDigest; pageNumber += 1;
    }
  }
  const cursor = await options.store.getCursor(options.scope);
  const ackedCursor = cursor?.cursor;
  if (!ackedCursor) throw new SyncFailureError('snapshot_cutover_missing');
  const capability = recoveryCapabilityOf(cursor) ?? ackedCursor;
  const intent = await options.store.getPendingAckIntent(options.scope);
  const durableIntent = intent ?? (await options.store.listAckIntents(options.scope)).find((item: AckIntentRecord) =>
    item.kind === 'bootstrap' && item.cursor === ackedCursor && item.state === 'complete');
  if (!durableIntent || durableIntent.kind !== 'bootstrap' || durableIntent.cursor !== ackedCursor) {
    throw new SyncFailureError('bootstrap_ack_intent_missing');
  }
  if (await runtime.sendAck(durableIntent, authority) === 'recovery') return runtime.state();
  const active = await runtime.renewBootstrapAuthority(capability);
  await runtime.transition('sleeping', { sessionId: active.session.sessionId,
    ...await readCompletedBootstrapState(options.store, options.scope), notBefore: now() + 1_000,
    lastPublishedCursor: capability, lastAckedCursor: capability }); options.schedule?.(1_000);
  return runtime.state();
}

async function commitPreparedRecovery(runtime: SnapshotRecoveryRuntime,
  authority: { readonly credential: { readonly accessToken: string }; readonly session: StoredSession },
  snapshotId: string, syncCursor: string, capability: string | undefined): Promise<void> {
  const endpoints = await runtime.options.endpoints();
  await persistSnapshotOpenConflicts({
    snapshotUrl: endpoints.syncSnapshot, sessionId: authority.session.sessionId, snapshotId,
    headers: runtime.headers(authority, runtime.options.origin), fetch: (url, init) => runtime.networkFetch(url, init),
    maxBytes: sessionTransportBudget(authority.session).snapshotPageBytes,
    ...(runtime.options.requestTimeoutMilliseconds === undefined
      ? {} : { timeoutMilliseconds: runtime.options.requestTimeoutMilliseconds }),
    persist: async (conflict) => {
      await runtime.options.store.putScopeDiagnostic(runtime.options.scope, {
        kind: 'snapshot_open_conflict', code: conflict.id,
        details: snapshotOpenConflictDetails(snapshotId, conflict),
      });
    },
  });
  if (await enforceSyncIssueCeiling(runtime.options.store, runtime.options.scope, runtime.now())) throw new SyncFailureError('sync_issue_ceiling');
  await runtime.projectRecovery(snapshotId);
  await runtime.options.store.commitRecovery(runtime.options.scope, snapshotId,
    runtime.ackEnvelope('bootstrap', authority.session.sessionId, syncCursor, capability,
      await pullAckWarnings(runtime.options.store, runtime.options.scope)));
}

function snapshotMapping(node: SnapshotNode, childrenRevision: string | null, digest: (value: unknown) => string): MappingInput {
  const nodeKind: MappingInput['nodeKind'] = node.kind === 'bookmark' ? 'bookmark'
    : node.kind === 'separator' ? 'separator' : 'folder';
  const content = snapshotProjectionContent(node) as JsonObject;
  return { nativeId: `recovery:${node.id}`, colpId: node.id, rootNativeId: 'recovery:root', nodeKind,
    ...(node.parentId ? { parentColpId: node.parentId } : {}), projection: { revision: node.revision,
      resourceRevision: node.revision, ...(nodeKind === 'folder' ? { childrenRevision } : {}),
      digest: digest(node), content } };
}

function snapshotIdentityDigest(snapshot: DurableSyncSnapshot, digest: (value: unknown) => string) {
  return digest({ protocolVersion: snapshot.protocolVersion, snapshotId: snapshot.snapshotId, mode: snapshot.mode,
    complete: snapshot.complete, collection: snapshot.collection, revision: snapshot.revision,
    generatedAt: snapshot.generatedAt, warnings: snapshot.warnings });
}

function jsonContentType(response: Response) {
  return /^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '');
}
function recoveryCapability(cursor: string | undefined) { return cursor?.startsWith('src1.') === true; }
function recoveryCapabilityOf(cursor: { readonly evidence?: unknown } | null | undefined) {
  const evidence = cursor?.evidence && typeof cursor.evidence === 'object'
    ? cursor.evidence as { readonly capability?: unknown } : {};
  return typeof evidence.capability === 'string' && evidence.capability.length > 0
    ? evidence.capability : undefined;
}
function httpOrSnapshotFailure(response: Response, now: number) {
  const error = new SyncFailureError('rate_limited') as Error & { retryAfterMilliseconds?: number };
  const value = response.headers.get('Retry-After'); let delay = 0;
  if (value && /^\d+$/u.test(value)) delay = Number(value) * 1_000;
  else if (value) { const date = Date.parse(value); if (Number.isFinite(date)) delay = Math.max(0, date - now); }
  error.retryAfterMilliseconds = Math.min(5 * 60_000, Math.max(1_000, delay));
  return error;
}
