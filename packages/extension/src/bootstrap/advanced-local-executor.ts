import { digestJson } from '../bookmark-event-codec.js';
import { rejectedChromeBookmarkUrl } from '../pull-projection.js';
import type { createSyncStateStore, JsonObject, MappingInput, SyncScope } from '../sync-state-store.js';
import type { AdvancedStepRecord } from '../sync-state/advanced-repository.js';
import type { AdvancedParentRef, AdvancedStep } from './advanced-plan-types.js';
import type { RemoteNodeFact } from './matcher.js';
import type { StepOutcome } from './advanced-executor.js';
import { resolveAdvancedReference } from './advanced-remote-executor.js';

type Store = ReturnType<typeof createSyncStateStore>;
type LocalStep = Extract<AdvancedStep, { side: 'local' }>;
export interface AdvancedNativeNode {
  readonly id: string; readonly parentId?: string; readonly title: string; readonly url?: string;
  readonly index?: number; readonly unmodifiable?: string;
}
export interface AdvancedNativeApi {
  get(id: string): Promise<readonly AdvancedNativeNode[]>;
  getChildren(id: string): Promise<readonly AdvancedNativeNode[]>;
  create(input: { parentId: string; title: string; url?: string; index: number }): Promise<AdvancedNativeNode>;
  update(id: string, input: { title?: string; url?: string }): Promise<AdvancedNativeNode>;
  move(id: string, input: { parentId: string; index: number }): Promise<AdvancedNativeNode>;
  remove(id: string): Promise<void>;
}

export async function executeAdvancedLocalStep(input: {
  readonly store: Store; readonly scope: SyncScope; readonly api: AdvancedNativeApi;
  readonly record: AdvancedStepRecord; readonly step: LocalStep; readonly completed: readonly AdvancedStepRecord[];
}): Promise<StepOutcome> {
  const { api, step, record, store, scope, completed } = input;
  if (step.action === 'create') {
    const parentId = resolveAdvancedReference(step.parent, completed, 'nativeId');
    const parent = (await api.get(parentId))[0];
    if (!parent || parent.url || parent.unmodifiable) return changed();
    const index = liveChildIndex(localStepIndex(step), parentId, completed);
    let created: AdvancedNativeNode | undefined;
    if (typeof record.evidence?.nativeId === 'string') created = (await api.get(record.evidence.nativeId))[0];
    if (!created && record.state === 'executing') {
      const observed = record.evidence?.observedNativeIds;
      if (Array.isArray(observed) && observed.length === 1 && typeof observed[0] === 'string') {
        created = (await api.get(observed[0]))[0];
      } else {
        // A crash without callback/return evidence cannot prove which identical
        // native node was ours. Never create another or guess by URL/title.
        return { state: 'changed', code: 'advanced_create_identity_unproven' };
      }
    }
    if (!created) {
      // Chrome cannot store this bookmark. Skip the step instead of throwing:
      // advanceConfirmedPlan only continues after a normal outcome.
      const rejected = rejectedBookmarkWrite(step.payload.node);
      if (rejected) return { state: 'complete', evidence: { targetId: step.source.nodeId, code: rejected } };
      created = await api.create({ parentId, title: step.payload.node.title,
        ...(step.payload.node.url === undefined ? {} : { url: step.payload.node.url }), index });
      await store.settleAdvancedStep(scope, record.planId, record.order,
        { expectedState: 'executing', state: 'executing', evidence: { nativeId: created.id,
          ...(nativeIndex(created) === undefined ? {} : { index: nativeIndex(created)! }) } });
    }
    if (!created || created.id !== (record.evidence?.nativeId ?? created.id)
        || !sameContent(created, step.payload.node) || !nativeParentEquals(created.parentId, parentId)
        || !indexMatches(nativeIndex(created), index)) return changed();
    await bindLocal(input, step.source.nodeId, created.id, parentId);
    return { state: 'complete', evidence: { nativeId: created.id, targetId: step.source.nodeId,
      ...(nativeIndex(created) === undefined ? {} : { index: nativeIndex(created)! }) } };
  }
  let current: AdvancedNativeNode | undefined;
  try { current = (await api.get(step.target.nativeId))[0]; }
  catch (error) {
    // Missing nodes are only accepted after an attempted remove, verified by
    // the parent's children; arbitrary Chrome failures remain retryable.
    if (step.action !== 'remove' || !step.before.parentNativeId || !missingNativeError(error)) throw error;
    const children = await api.getChildren(step.before.parentNativeId);
    if (children.some((child) => child.id === step.target.nativeId)) throw error;
  }
  if (step.action === 'remove') {
    if (!current) {
      await store.deleteMapping(scope, step.target.nativeId);
      return { state: 'complete', evidence: { nativeId: step.target.nativeId } };
    }
    const expected = expectedLocalPosition(step, completed);
    if (current.id !== step.target.nativeId || !sameContent(current, expected.content)
        || !nativeParentEquals(current.parentId, expected.parentId) || !indexMatches(nativeIndex(current), expected.index)
        || current.unmodifiable) return changed();
    if (!current.url && (await api.getChildren(current.id)).length > 0) return changed();
    await api.remove(current.id);
    await store.deleteMapping(scope, current.id);
    return { state: 'complete', evidence: { nativeId: current.id,
      ...(nativeIndex(current) === undefined ? {} : { index: nativeIndex(current)! }) } };
  }
  if (!current || current.unmodifiable) return changed();
  const parentId = resolveAdvancedReference(step.after.parent, completed, 'nativeId');
  const desired = step.after.node;
  const desiredIndex = step.action === 'move' ? liveChildIndex(localStepIndex(step), parentId, completed)
    : numberValue(step.after.index) ?? step.before.index;
  const expected = expectedLocalPosition(step, completed);
  if (current.id === step.target.nativeId && sameWritableContent(current, desired)
      && nativeParentEquals(current.parentId, parentId) && indexMatches(nativeIndex(current), desiredIndex)) {
    await bindLocal(input, step.target.nodeId, current.id, parentId);
    return { state: 'complete', evidence: { nativeId: current.id, targetId: step.target.nodeId,
      ...(nativeIndex(current) === undefined ? {} : { index: nativeIndex(current)! }),
      ...(step.action === 'move' && expected.index !== undefined ? { beforeIndex: expected.index } : {}) } };
  }
  // A preceding step in this same immutable plan may have changed the content
  // or shifted the child index. The simulated postcondition is the only
  // admissible replacement for Before; an unaccounted live change stops the
  // confirmed plan instead of silently overwriting it.
  if (current.id !== step.target.nativeId || !sameWritableContent(current, expected.content)
      || !nativeParentEquals(current.parentId, expected.parentId)
      || !indexMatches(nativeIndex(current), expected.index)) return changed();
  if (step.action === 'update') {
    const url = chromeWritableUrl(desired);
    await api.update(current.id, { title: desired.title, ...(url === undefined ? {} : { url }) });
  } else {
    const parent = (await api.get(parentId))[0];
    if (!parent || parent.url || parent.unmodifiable) return changed();
    await api.move(current.id, { parentId, index: desiredIndex });
  }
  const verified = (await api.get(current.id))[0];
  if (!verified || verified.id !== step.target.nativeId || !sameWritableContent(verified, desired)
      || !nativeParentEquals(verified.parentId, parentId)
      || !indexMatches(nativeIndex(verified), desiredIndex)) return changed();
  await bindLocal(input, step.target.nodeId, current.id, parentId);
  return { state: 'complete', evidence: { nativeId: current.id, targetId: step.target.nodeId,
    ...(nativeIndex(verified) === undefined ? {} : { index: nativeIndex(verified)! }),
    ...(step.action === 'move' && expected.index !== undefined ? { beforeIndex: expected.index } : {}) } };
}

interface ExpectedLocalPosition {
  readonly parentId: string | null;
  readonly index?: number;
  readonly content: { readonly title?: unknown; readonly url?: unknown };
}

/**
 * Replays only structural mutations already completed by this plan against a
 * target's snapshot position. Chrome reindexes siblings after every create,
 * move, and remove; those shifts are expected. The target's own content,
 * parent, and identity still have to match the resulting precondition.
 */
function expectedLocalPosition(step: Exclude<LocalStep, Extract<LocalStep, { action: 'create' }>>,
  completed: readonly AdvancedStepRecord[]): ExpectedLocalPosition {
  const targetId = step.target.nativeId;
  let parentId = step.before.parentNativeId;
  let index = step.before.index;
  let content: { readonly title?: unknown; readonly url?: unknown } = step.before;
  for (const record of completed) {
    if (record.definition.side !== 'local') continue;
    const prior = record.definition as unknown as LocalStep;
    if (prior.action === 'create') {
      const createdId = stringValue(record.evidence?.nativeId);
      // A skipped bookmark never occupied a Chrome slot, so it must not shift siblings.
      if (!createdId) continue;
      const insertionParent = resolveLocalReference(prior.parent, completed);
      const insertionIndex = numberValue(record.evidence?.index) ?? numberValue(prior.payload.index)
        ?? numberValue(prior.after?.index);
      if (createdId === targetId) {
        parentId = insertionParent; index = insertionIndex;
        content = prior.payload.node;
      } else if (insertionParent === parentId && index !== undefined && insertionIndex !== undefined
          && insertionIndex <= index) {
        index += 1;
      }
      continue;
    }
    const priorTarget = prior.action === 'remove' ? prior.target.nativeId : prior.target.nativeId;
    if (priorTarget === targetId && prior.action !== 'remove') {
      const after = prior.after;
      if (after) {
        parentId = resolveLocalReference(after.parent, completed);
        index = numberValue(after.index) ?? index;
        content = after.node;
      }
      continue;
    }
    if (prior.action === 'remove') {
      const removalParent = prior.before.parentNativeId;
      const removalIndex = numberValue(record.evidence?.index) ?? prior.before.index;
      if (removalParent === parentId && index !== undefined && removalIndex !== undefined
          && removalIndex < index) index -= 1;
      continue;
    }
    if (prior.action !== 'move') continue;
    const sourceParent = prior.before.parentNativeId;
    const sourceIndex = numberValue(record.evidence?.beforeIndex) ?? prior.before.index;
    const destinationParent = resolveLocalReference(prior.after.parent, completed);
    const destinationIndex = numberValue(record.evidence?.index) ?? numberValue(prior.payload.index)
      ?? numberValue(prior.after.index);
    if (sourceParent === parentId && index !== undefined && sourceIndex !== undefined
        && sourceIndex < index) index -= 1;
    if (destinationParent === parentId && index !== undefined && destinationIndex !== undefined
        && destinationIndex <= index) index += 1;
  }
  return { parentId, ...(index === undefined ? {} : { index }), content };
}

function resolveLocalReference(reference: AdvancedParentRef, completed: readonly AdvancedStepRecord[]): string {
  return resolveAdvancedReference(reference, completed, 'nativeId');
}

function localStepIndex(step: Extract<LocalStep, { action: 'create' | 'move' }>): number {
  const index = numberValue(step.payload.index) ?? numberValue(step.after.index);
  return index ?? 0;
}

function nativeIndex(node: AdvancedNativeNode): number | undefined {
  return numberValue(node.index);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nativeParentEquals(actual: string | undefined, expected: string | null | undefined): boolean {
  return (actual ?? null) === (expected ?? null);
}

/** Older test adapters omit index; real Chrome always returns it. */
function indexMatches(actual: number | undefined, expected: number | undefined): boolean {
  return actual === undefined || expected === undefined || actual === expected;
}

async function bindLocal(input: { readonly store: Store; readonly scope: SyncScope;
  readonly completed: readonly AdvancedStepRecord[] }, nodeId: string, nativeId: string, parentNativeId: string): Promise<void> {
  const seeded = input.completed.find((row) => row.definition.kind === 'snapshot-fact'
    && (row.definition.fact as JsonObject)?.nodeId === nodeId)?.definition.fact;
  if (!seeded || typeof seeded !== 'object' || Array.isArray(seeded)) throw new Error('advanced_snapshot_fact_missing');
  const fact = seeded as unknown as RemoteNodeFact;
  const parent = await input.store.getMappingByNativeId(input.scope, parentNativeId);
  if (!parent) throw new Error('advanced_parent_mapping_missing');
  const existing = await input.store.getMappingByColpId(input.scope, nodeId);
  if (existing && existing.nativeId !== nativeId) {
    if (!existing.nativeId.startsWith('unmounted:') && !existing.nativeId.startsWith('recovery:')) {
      throw new Error('advanced_step_changed');
    }
    await input.store.deleteMapping(input.scope, existing.nativeId);
  }
  const content: JsonObject = { title: fact.title, ...(fact.url === undefined ? {} : { url: fact.url }),
    ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) };
  const mapping: MappingInput = { nativeId, colpId: nodeId, parentNativeId, parentColpId: parent.colpId,
    rootNativeId: parent.rootNativeId, nodeKind: fact.kind,
    ...(parent.mountId ? { mountId: parent.mountId } : {}), ...(parent.rootRole ? { rootRole: parent.rootRole } : {}),
    projection: { revision: fact.revision, resourceRevision: fact.revision, digest: digestJson(content),
      contentDigest: digestJson(content), content,
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) } };
  await input.store.putMapping(input.scope, mapping);
}

function sameContent(node: AdvancedNativeNode, expected: { readonly title?: unknown; readonly url?: unknown }): boolean {
  return node.title === expected.title && (node.url ?? '') === (expected.url ?? '');
}

/** Folders have no bookmark URL. A rejected bookmark URL must not be written. */
function rejectedBookmarkWrite(node: { readonly kind: string; readonly url?: string }): string | null {
  if (node.kind !== 'bookmark') return null;
  return rejectedChromeBookmarkUrl(node.url);
}

function chromeWritableUrl(node: { readonly kind: string; readonly url?: string }): string | undefined {
  if (node.kind !== 'bookmark' || node.url === undefined || rejectedChromeBookmarkUrl(node.url)) return undefined;
  return node.url;
}

/** Update and move may keep a local URL when the remote one cannot be stored. */
function sameWritableContent(node: AdvancedNativeNode, expected: { readonly title?: unknown; readonly url?: unknown }): boolean {
  if (node.title !== expected.title) return false;
  if (typeof expected.url === 'string' && rejectedChromeBookmarkUrl(expected.url)) return true;
  return (node.url ?? '') === (expected.url ?? '');
}

function liveChildIndex(planned: number, parentId: string, completed: readonly AdvancedStepRecord[]): number {
  let skipped = 0;
  for (const record of completed) {
    if (record.definition.side !== 'local') continue;
    const prior = record.definition as unknown as LocalStep;
    if (prior.action !== 'create' || stringValue(record.evidence?.nativeId)) continue;
    if (resolveLocalReference(prior.parent, completed) !== parentId) continue;
    const priorIndex = numberValue(prior.payload.index) ?? numberValue(prior.after?.index) ?? 0;
    if (priorIndex < planned) skipped += 1;
  }
  return Math.max(0, planned - skipped);
}

function changed(): StepOutcome { return { state: 'changed', code: 'advanced_step_changed' }; }
function missingNativeError(error: unknown): boolean {
  return error instanceof Error && /^(?:Can't find bookmark for id\.?|No bookmark node with id(?: .+)?|Bookmark node not found\.?)$/u.test(error.message);
}
