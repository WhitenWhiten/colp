import { createBookmarkEventQueue, type BookmarkEventApi } from '../bookmark-event-queue.js';
import { digestJson } from '../bookmark-event-codec.js';
import type { BookmarkCaptureEvent } from '../bookmark-listener-lifecycle.js';
import type { createSyncStateStore, JsonObject, SyncScope } from '../sync-state-store.js';
import type { AdvancedStep } from './advanced-plan-types.js';
import type { AdvancedStepRecord } from '../sync-state/advanced-repository.js';
import { activeAdvancedPlan, captureAdvancedCreate } from './advanced-run.js';
import { resolveAdvancedReference } from './advanced-remote-executor.js';

/** User events remain in the existing durable inbox while a confirmed plan
 * owns execution. Only proven echoes are suppressed; the inbox drains after
 * the plan so a restart cannot erase intervening user changes. */
export async function captureWhileAdvanced(input: {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly api: BookmarkEventApi; readonly event: BookmarkCaptureEvent;
}): Promise<boolean> {
  const { store, scope, event } = input;
  if (event.kind === 'created' && await captureAdvancedCreate(store, scope, event.nativeId, event.node)) return true;
  const active = await activeAdvancedPlan(store, scope);
  if ((event.kind === 'changed' || event.kind === 'moved')
      && await captureAdvancedUpdateMoveEcho(store, scope, event, active)) return true;
  if (event.kind === 'removed' && await captureAdvancedRemoveEcho(store, scope, event, active)) return true;
  if (!active) return false;
  const queue = createBookmarkEventQueue({ store, scope, api: input.api, autoFlush: false });
  if (event.kind === 'created') await queue.created(event.nativeId, event.node);
  else if (event.kind === 'changed') await queue.changed(event.nativeId, event.changes);
  else if (event.kind === 'moved') await queue.moved(event.nativeId, event.move);
  else if (event.kind === 'removed') await queue.removed(event.nativeId, event.removal);
  else if (event.kind === 'children_reordered' || event.kind === 'reordered') {
    await queue.reordered(event.nativeId, event.childIds);
  }
  return true;
}

async function captureAdvancedRemoveEcho(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  event: Extract<BookmarkCaptureEvent, { kind: 'removed' }>, active: Awaited<ReturnType<typeof activeAdvancedPlan>>)
  : Promise<boolean> {
  const plans = active ? [active] : (await store.listAdvancedPlans(scope)).filter((plan) => plan.state === 'completed');
  for (const plan of plans) {
    const loaded = await store.readAdvancedPlan(scope, plan.planId); if (!loaded) continue;
    for (const record of loaded.steps) {
      const step = record.definition as unknown as AdvancedStep;
      if (step.side !== 'local' || step.action !== 'remove' || step.target.nativeId !== event.nativeId
          || (record.state !== 'executing' && record.state !== 'terminal')) continue;
      // After completion the mapping is deliberately gone. The immutable
      // before-state and terminal API evidence prove this removal's identity.
      if (record.state === 'terminal' && (record.evidence?.nativeId !== event.nativeId
          || await store.getMappingByNativeId(scope, event.nativeId))) continue;
      const node = event.removal.node;
      const index = typeof record.evidence?.index === 'number' ? record.evidence.index : step.before.index;
      if (!node || node.id !== event.nativeId || event.removal.parentId !== step.before.parentNativeId
          || node.title !== step.before.title || (node.url ?? '') !== (step.before.url ?? '')
          || (typeof index === 'number' && event.removal.index !== index)) continue;
      if (await store.recordAdvancedEcho(scope, plan.planId, record.order, { stepDigest: record.digest,
        evidence: { kind: 'removed', nativeId: event.nativeId, parentId: event.removal.parentId,
          index: event.removal.index } })) return true;
    }
  }
  return false;
}

async function captureAdvancedUpdateMoveEcho(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  event: Extract<BookmarkCaptureEvent, { kind: 'changed' | 'moved' }>, active: Awaited<ReturnType<typeof activeAdvancedPlan>>)
  : Promise<boolean> {
  const plans = active ? [active] : (await store.listAdvancedPlans(scope)).filter((plan) => plan.state === 'completed');
  for (const plan of plans) {
    const loaded = await store.readAdvancedPlan(scope, plan.planId); if (!loaded) continue;
    const completed = loaded.steps.filter((step) => step.state === 'terminal');
    for (const record of loaded.steps) {
      const step = record.definition as unknown as AdvancedStep;
      if (record.state !== 'executing' && record.state !== 'terminal') continue;
      if (step.side !== 'local' || step.action !== (event.kind === 'changed' ? 'update' : 'move')) continue;
      if (step.target.nativeId !== event.nativeId) continue;
      const localStep = step as Extract<AdvancedStep, { side: 'local'; action: 'update' | 'move' }>;
      const evidence = await exactEchoEvidence(store, scope, event, record, localStep, completed);
      if (!evidence) continue;
      if (await store.recordAdvancedEcho(scope, plan.planId, record.order, {
        stepDigest: record.digest, evidence,
      })) return true;
    }
  }
  return false;
}

async function exactEchoEvidence(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  event: Extract<BookmarkCaptureEvent, { kind: 'changed' | 'moved' }>,
  record: AdvancedStepRecord,
  step: Extract<AdvancedStep, { side: 'local'; action: 'update' | 'move' }>,
  completed: readonly AdvancedStepRecord[]): Promise<JsonObject | null> {
  const mapping = await store.getMappingByNativeId(scope, event.nativeId);
  const source = step.source.fact;
  if (!mapping || mapping.colpId !== source.nodeId || mapping.projection.revision !== source.revision) return null;
  const after = step.after;
  if (!after) return null;
  const expectedParent = resolveAdvancedReference(after.parent, completed, 'nativeId');
  if (mapping.parentNativeId !== expectedParent || !matchesContent(mapping.projection.content, after.node)) return null;
  if (event.kind === 'changed') {
    const changes = event.changes;
    if (Object.keys(changes).length === 0 || Object.keys(changes).some((key) => key !== 'title' && key !== 'url')
        || !Object.entries(changes).every(([key, value]) => key === 'title'
          ? after.node.title === value : after.node.url === value)) return null;
    return { kind: event.kind, nativeId: event.nativeId, sourceRevision: source.revision,
      mappingRevision: mapping.projection.revision, eventDigest: digestJson({ kind: event.kind,
        nativeId: event.nativeId, changes }), changes: { ...changes },
      expected: { title: after.node.title, ...(after.node.url === undefined ? {} : { url: after.node.url }) } };
  }
  const expectedIndex = typeof record.evidence?.index === 'number'
    ? record.evidence.index : (after as unknown as { readonly index?: unknown }).index;
  const beforeIndex = typeof record.evidence?.beforeIndex === 'number'
    ? record.evidence.beforeIndex : (step.before as unknown as { readonly index?: unknown }).index;
  if (typeof expectedIndex !== 'number' || event.move.parentId !== expectedParent || event.move.index !== expectedIndex
      || (typeof step.before.parentNativeId === 'string' && event.move.oldParentId !== step.before.parentNativeId)
      || (typeof beforeIndex === 'number' && event.move.oldIndex !== beforeIndex)) return null;
  return { kind: event.kind, nativeId: event.nativeId, sourceRevision: source.revision,
    mappingRevision: mapping.projection.revision, eventDigest: digestJson({ kind: event.kind,
      nativeId: event.nativeId, move: event.move }), parentId: event.move.parentId, index: event.move.index,
    oldParentId: event.move.oldParentId, oldIndex: event.move.oldIndex };
}

function matchesContent(content: JsonObject | undefined, desired: { readonly title?: unknown; readonly url?: unknown }): boolean {
  return Boolean(content && content.title === desired.title && (content.url ?? '') === (desired.url ?? ''));
}
