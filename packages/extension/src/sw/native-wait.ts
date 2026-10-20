/**
 * S1 / B0-1 (SR-01): the service-worker transport for `native_result_unknown`.
 *
 * `confirmNativeWait` is the CAS; this module only resolves the ambient
 * dependencies (scope, durable store, bookmark permission, Chrome adapter,
 * engine wake) and turns the durable result into a JSON-safe response. Every
 * failure is returned as `{ ok: false, code }` so `onMessage` never sees a
 * rejection.
 */
import type { NativeWaitProjection } from '../native-create-executor.js';
import {
  confirmNativeWait, projectNativeWaits, type ConfirmNativeWaitInput, type NativeWaitStore,
} from '../native-wait.js';
import { createChromePullBookmarkApi } from '../pull-bookmark-api.js';
import type { PullBookmarkApi, PullNode } from '../pull-applier-types.js';
import { chromeCreate } from '../pull-projection.js';
import type { IntentRecord, SyncScope } from '../sync-state-store.js';
import { materializationChildEventId } from '../sync-state/materialization-wait-authority.js';
import type {
  NativeWaitConfirmRequest, NativeWaitRequest, NativeWaitResponse, PublicNativeWait, PublicNativeWaitCandidate,
} from '../types.js';

export interface NativeWaitDeps {
  /** Ambient sync scope; throws `not_connected` when no scope is bound. */
  readonly scope: () => Promise<SyncScope>;
  readonly store: NativeWaitStore;
  readonly permissionGranted: () => Promise<boolean>;
  /** Engine wake after a confirmation actually moved the durable intent. */
  readonly wake: () => void;
  /** Injectable bookmark adapter; production uses the hosted Chrome bookmarks. */
  readonly api?: () => PullBookmarkApi;
}

/**
 * Live-authority capability from `createSyncEffectAuthority`. When present, its
 * `api` is the only bookmark adapter this handler uses and `assertCurrent` is
 * re-checked before the native create, so a confirmation that raced an
 * authority change cannot land a node under the retired identity.
 */
export interface NativeWaitAuthority {
  readonly assertCurrent: () => Promise<void>;
  readonly api: PullBookmarkApi;
}

export async function handleNativeWaitRequest(
  message: NativeWaitRequest,
  deps: NativeWaitDeps,
  authority?: NativeWaitAuthority,
): Promise<NativeWaitResponse> {
  try {
    const scope = await deps.scope();
    if (message.kind === 'known.nativeWait.list') return await list(scope, deps);
    return await confirm(scope, message, deps, authority);
  } catch (error) {
    return { ok: false, code: nativeWaitErrorCode(error) };
  }
}

async function list(scope: SyncScope, deps: NativeWaitDeps): Promise<NativeWaitResponse> {
  const [waits, intents] = await Promise.all([
    projectNativeWaits(deps.store, scope), deps.store.listApplyIntents(scope),
  ]);
  const generations = new Map<string, number>();
  for (const intent of intents) {
    if (typeof intent.generation === 'number' && Number.isSafeInteger(intent.generation)) {
      generations.set(intent.intentId, intent.generation);
    }
  }
  return { ok: true, waits: waits.map((wait) => publicWait(wait, generations.get(wait.intentId) ?? scope.generation)) };
}

async function confirm(scope: SyncScope, message: NativeWaitConfirmRequest,
  deps: NativeWaitDeps, authority?: NativeWaitAuthority): Promise<NativeWaitResponse> {
  if (!await deps.permissionGranted()) return { ok: false, code: 'revoked' };
  const api = authority?.api ?? (deps.api ? deps.api() : createChromePullBookmarkApi());
  let create: (() => Promise<{ readonly id: string }>) | undefined;
  if (message.action === 'keep_local_and_create') {
    // A missing intent is left to `confirmNativeWait`, which names `intent_not_found`.
    const intent = await deps.store.getApplyIntent(scope, message.intentId);
    if (intent && !materializationChildEventId(intent)) {
      const planned = await planUserCreate(deps.store, scope, intent, api);
      if (!planned.ok) return { ok: false, code: planned.code };
      create = planned.create;
    }
  }
  const input: ConfirmNativeWaitInput = {
    scope, store: deps.store, waitRef: message.waitRef, intentId: message.intentId,
    generation: message.generation, action: message.action,
    ...(message.nativeId === undefined ? {} : { nativeId: message.nativeId }),
    permissionGranted: true,
    api,
    ...(authority ? { assertCurrent: authority.assertCurrent } : {}),
    ...(create ? { create } : {}),
  };
  const result = await confirmNativeWait(input);
  if (result.ok) deps.wake();
  return result;
}

type PlannedCreate = { readonly ok: true; readonly create: () => Promise<{ readonly id: string }> }
  | { readonly ok: false; readonly code: 'request_invalid' };

/**
 * `keep_local_and_create` needs a real Chrome create: the intent's parent, the
 * node content the remote authority asked for, and an index that comes from the
 * intent's own anchors (or the live child list). Anything we cannot prove is
 * refused instead of inventing a placement.
 */
async function planUserCreate(store: NativeWaitStore, scope: SyncScope, intent: IntentRecord,
  api: PullBookmarkApi): Promise<PlannedCreate> {
  const parentNativeId = intent.nativeParentId;
  if (typeof parentNativeId !== 'string' || parentNativeId.length === 0) return { ok: false, code: 'request_invalid' };
  const content = await createContent(store, scope, intent);
  if (!content) return { ok: false, code: 'request_invalid' };
  const index = await createIndex(intent, parentNativeId, api);
  if (index === undefined) return { ok: false, code: 'request_invalid' };
  return { ok: true, create: () => api.create({ parentId: parentNativeId, index, ...content }) };
}

/** The node the remote authority asked to land, read from the staged pull event. */
async function createContent(store: NativeWaitStore, scope: SyncScope,
  intent: IntentRecord): Promise<{ readonly title?: string; readonly url?: string } | undefined> {
  if (typeof intent.eventId !== 'string' || intent.eventId.length === 0) return undefined;
  const event = await store.getPullEvent(scope, intent.eventId);
  const effect = (event?.payload as { readonly effect?: unknown } | undefined)?.effect;
  const node = (effect as { readonly node?: unknown } | undefined)?.node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  try { return chromeCreate(node as PullNode); }
  catch { return undefined; }
}

async function createIndex(intent: IntentRecord, parentNativeId: string,
  api: PullBookmarkApi): Promise<number | undefined> {
  const anchored = intent.anchors?.index;
  if (typeof anchored === 'number' && Number.isSafeInteger(anchored) && anchored >= 0) return anchored;
  try { return (await api.getChildren(parentNativeId)).length; }
  catch { return undefined; }
}

function publicWait(wait: NativeWaitProjection, generation: number): PublicNativeWait {
  return {
    waitRef: wait.waitRef, intentId: wait.intentId, colpId: wait.colpId, waitReason: wait.waitReason,
    ...(wait.title ? { title: wait.title } : {}),
    ...(wait.url ? { url: wait.url } : {}),
    candidates: wait.candidates.map(candidate), affectedRange: { parentNativeId: wait.affectedRange.parentNativeId },
    generation,
  };
}

function candidate(input: NativeWaitProjection['candidates'][number]): PublicNativeWaitCandidate {
  return {
    nativeId: input.nativeId,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

/**
 * Codes stay code-shaped; prose (a `TypeError` from a broken store read) must not
 * reach the page as a fake diagnostic.
 */
function nativeWaitErrorCode(error: unknown): string {
  const shaped = /^[a-z][a-z0-9_:-]{0,63}$/u;
  const code = error && typeof error === 'object' && typeof (error as { readonly code?: unknown }).code === 'string'
    ? String((error as { readonly code: string }).code) : '';
  if (shaped.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return shaped.test(message) ? message : 'request_invalid';
}
