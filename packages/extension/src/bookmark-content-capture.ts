import { bookmarkKind, bookmarkRepresentability, digestJson, nativeContent, nodeContent, type BookmarkEventNode } from './bookmark-event-codec.js';
import { validateFolderDescription } from './folder-description-store.js';
import { sameTags } from './local-metadata-state.js';
import { extensionsPinned, withPinExtension } from './bookmark-pin-order.js';
import { recordIngressDiagnostic } from './bookmark-event-ingress.js';
import type { BookmarkEventApi } from './bookmark-event-queue.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { ProjectionChangeFields } from './recovery-overlay.js';
import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Result = { readonly outcome: 'staged' | 'duplicate' | 'filtered' | 'apply_intent_reserved' | 'identity_unproven' | 'set_aside'; readonly eventId?: string };
export function createBookmarkContentCapture(options: {
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>; readonly api: BookmarkEventApi;
  readonly identityFor: (nativeId: string) => Promise<EventIdentity | null>;
  readonly canWrite: (nativeId: string, identity: EventIdentity, observed?: BookmarkEventNode) => Promise<boolean>;
  readonly reservedByProjection: (kind: 'change', nativeId: string, correlation: string, changes?: ProjectionChangeFields) => Promise<boolean>;
  readonly correlationFor: (kind: 'change', nativeId: string, details: JsonObject) => string;
  readonly stage: (kind: 'change', nativeId: string, details: JsonObject, eventId: string, correlation?: string) => Promise<Result>;
  readonly uuid: () => string;
  readonly captureUnmapped?: (nativeId: string, fields: JsonObject) => Promise<Result | null>;
}) {
  const { identityFor, canWrite, reservedByProjection, correlationFor, stage, uuid } = options;

  async function changed(nativeId: string, rawChanges: { readonly title?: string; readonly url?: string },
    source: 'scan' | 'callback' = 'scan'): Promise<Result> {
    const identity = await identityFor(nativeId);
    if (!identity && source === 'callback') return await options.captureUnmapped?.(nativeId, rawChanges) ?? { outcome: 'filtered' };
    let observed: BookmarkEventNode | undefined;
    try { observed = (await options.api.get(nativeId))[0]; } catch { observed = undefined; }
    const allowed = identity && await canWrite(nativeId, identity, observed);
    if (!identity || !identity.content || !allowed) return { outcome: 'filtered' };
    const priorContent = identity.content; const priorNativeContent = nativeContent(priorContent);
    const callbackPostState = { ...priorNativeContent, ...rawChanges };
    const representability = bookmarkRepresentability({ type: identity.nodeKind === 'bookmark' ? 'bookmark' : 'folder',
      title: String(callbackPostState.title ?? ''), ...(callbackPostState.url ? { url: callbackPostState.url } : {}) });
    if (representability !== 'supported') {
      await recordIngressDiagnostic(options.store, options.scope, representability);
      return { outcome: 'filtered' };
    }
    const callbackFields = Object.fromEntries(Object.entries(rawChanges)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const observedNativeContent = observed ? nodeContent(observed) : undefined;
    // Completed pages have already installed their projection. A callback that
    // differs from that projection and agrees with the live browser is new work,
    // even if it repeats an older remote value inside the intent TTL. Keep
    // in-flight intents and delayed callbacks whose live state moved on eligible.
    const allowCompletedChangeEcho = !observedNativeContent
      || !Object.entries(callbackFields).some(([field, value]) => priorNativeContent[field] !== value)
      || !Object.entries(callbackFields).every(([field, value]) => observedNativeContent[field] === value);
    const callbackCorrelationId = correlationFor('change', nativeId, callbackPostState);
    const callbackEvidence = { eventDigest: callbackCorrelationId, nativeId };
    if (await options.store.observeApplyIntentEvent(options.scope, callbackCorrelationId, callbackEvidence, allowCompletedChangeEcho)
        || await options.store.observeApplyIntentPostState(options.scope, nativeId, digestJson(callbackPostState), callbackEvidence, allowCompletedChangeEcho)) {
      return { outcome: 'apply_intent_reserved' };
    }
    if (await options.store.observeApplyIntentChangeFields(options.scope, nativeId, callbackFields, allowCompletedChangeEcho)
        || await reservedByProjection('change', nativeId, `recovery:update:${identity.colpId}`, callbackFields)) {
      return { outcome: 'apply_intent_reserved' };
    }
    const current = observed;
    const pullProjectionPending = current
      ? await options.store.hasActiveApplyIntentForNativeTarget(options.scope, nativeId) : false;
    const observedContent = source === 'callback' || pullProjectionPending ? callbackPostState
      : current ? nodeContent(current) : callbackPostState;
    const changes: JsonObject = Object.fromEntries(Object.entries(observedContent).filter((entry): entry is [string, string] =>
      (entry[0] === 'title' || entry[0] === 'url') && typeof entry[1] === 'string'
      && priorNativeContent[entry[0]] !== entry[1]));
    if (Object.keys(changes).length === 0) return { outcome: 'filtered' };
    const nextContent = { ...identity.content, ...changes };
    const nativePostState = nativeContent(nextContent);
    const correlationId = correlationFor('change', nativeId, nativePostState);
    const evidence = { eventDigest: correlationId, nativeId };
    if (await options.store.observeApplyIntentEvent(options.scope, correlationId, evidence, allowCompletedChangeEcho)
        || await options.store.observeApplyIntentPostState(options.scope, nativeId, digestJson(nativePostState), evidence, allowCompletedChangeEcho)) {
      return { outcome: 'apply_intent_reserved' };
    }
    const eventId = uuid();
    return stage('change', nativeId, { operation: { type: 'update_node_content', targetId: identity.colpId,
      baseRevision: identity.revision, dependencies: [],
      payload: { base: Object.fromEntries(Object.keys(changes).map(key => [key, identity.content![key] ?? null])),
        value: changes } }, mapping: { nativeId, colpId: identity.colpId,
      rootNativeId: identity.rootNativeId, ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}),
      ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
      projection: { revision: `local-${eventId}`,
        ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}), digest: digestJson(nextContent),
        content: nextContent } } }, eventId, correlationId);
  }

  /** Extra folder metadata uses the same durable content-update queue as native title edits. */
  async function described(nativeId: string, description: string | null,
    baseline?: { readonly revision: string; readonly description: string | null; readonly eventId?: string }): Promise<Result> {
    validateFolderDescription(description);
    const identity = await identityFor(nativeId);
    const observed = (await options.api.get(nativeId))[0];
    if (!identity?.content || !observed || bookmarkKind(observed) !== 'folder'
        || !await canWrite(nativeId, identity, observed)) return { outcome: 'filtered' };
    const currentDescription = identity.content.description ?? null;
    if (currentDescription === description && (!baseline || baseline.description === description
        || identity.revision.startsWith('local-'))) return { outcome: 'filtered' };
    const eventId = baseline?.eventId ?? uuid(), nextContent = { ...identity.content, description };
    return stage('change', nativeId, { operation: { type: 'update_node_content', targetId: identity.colpId,
      baseRevision: baseline?.revision ?? identity.revision, dependencies: [],
      payload: { base: { description: baseline ? baseline.description : currentDescription }, value: { description } } },
      mapping: { nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId, nodeKind: 'folder',
        ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
        projection: { revision: `local-${eventId}`, ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
          digest: digestJson(nativeContent(nextContent)), contentDigest: digestJson(nextContent), content: nextContent } } }, eventId);
  }

  async function tagged(nativeId: string, tags: readonly string[], baseline: {
    readonly revision: string; readonly tags: readonly string[]; readonly eventId: string;
  }): Promise<Result> {
    if (tags.length > 64 || tags.some(tag => !tag || tag.length > 64) || new Set(tags).size !== tags.length) throw new Error('bookmark_annotation_invalid');
    const identity = await identityFor(nativeId), observed = (await options.api.get(nativeId))[0];
    if (!identity?.content || !observed || bookmarkKind(observed) !== 'bookmark'
      || !await canWrite(nativeId, identity, observed)) return { outcome: 'filtered' };
    const current = Array.isArray(identity.content.tags) ? identity.content.tags as string[] : [];
    if (sameTags(current, tags) && (sameTags(baseline.tags, tags) || identity.revision.startsWith('local-'))) return { outcome: 'filtered' };
    const nextContent = { ...identity.content, tags: [...tags] };
    return stage('change', nativeId, { operation: { type: 'update_node_content', targetId: identity.colpId,
      baseRevision: baseline.revision, dependencies: [], payload: { base: { tags: [...baseline.tags] }, value: { tags: [...tags] } } },
      mapping: { nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId, nodeKind: 'bookmark',
        ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
        projection: { revision: `local-${baseline.eventId}`, ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
          digest: digestJson(nativeContent(nextContent)), contentDigest: digestJson(nextContent), content: nextContent } } }, baseline.eventId);
  }

  /** The pin travels as the bookmark's extension map, so base and value carry the whole map. */
  async function pinned(nativeId: string, value: boolean, baseline: {
    readonly revision: string; readonly extensions: JsonObject; readonly eventId: string;
  }): Promise<Result> {
    const identity = await identityFor(nativeId), observed = (await options.api.get(nativeId))[0];
    if (!identity?.content || !observed || bookmarkKind(observed) !== 'bookmark'
      || !await canWrite(nativeId, identity, observed)) return { outcome: 'filtered' };
    const current = asObject(identity.content.extensions);
    if (extensionsPinned(current) === value && (extensionsPinned(baseline.extensions) === value || identity.revision.startsWith('local-'))) {
      return { outcome: 'filtered' };
    }
    // Stored rows reject shared references, so every map is its own copy.
    const next = structuredClone(withPinExtension(baseline.extensions, value)) as JsonObject;
    const nextContent = { ...identity.content, extensions: structuredClone(withPinExtension(current, value)) as JsonObject };
    return stage('change', nativeId, { operation: { type: 'update_node_content', targetId: identity.colpId,
      baseRevision: baseline.revision, dependencies: [], payload: { base: { extensions: structuredClone(baseline.extensions) }, value: { extensions: next } } },
      mapping: { nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId, nodeKind: 'bookmark',
        ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
        projection: { revision: `local-${baseline.eventId}`, ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
          digest: digestJson(nativeContent(nextContent)), contentDigest: digestJson(nextContent), content: nextContent } } }, baseline.eventId);
  }

  return Object.freeze({ changed, described, tagged, pinned });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
