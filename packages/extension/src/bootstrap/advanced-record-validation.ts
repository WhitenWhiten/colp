import type {
  AdvancedDesiredLocalState, AdvancedDesiredRemoteState, AdvancedLocalState, AdvancedMode,
  AdvancedNodeKind, AdvancedNodeValue, AdvancedParentRef, AdvancedRemoteState, AdvancedRevisionRef, AdvancedStep,
} from './advanced-plan-types.js';
import type { MountFact, RemoteNodeFact } from './matcher.js';

/**
 * Durable advanced-plan records are JSON, not trusted TypeScript. The
 * repository verifies digests and step order; this module verifies the domain
 * shape before activation or execution can cause a side effect. Any mismatch
 * fails closed with the same `advanced_plan_corrupt` code the repository uses.
 */
export const ADVANCED_PLAN_CORRUPT = 'advanced_plan_corrupt';

const SPECIAL_ROLES = ['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks'] as const;

export interface AdvancedSnapshotFactDefinition {
  readonly kind: 'snapshot-fact';
  readonly fact: RemoteNodeFact;
  readonly nativeId: string | null;
}

export function isAdvancedSnapshotFactDefinition(value: AdvancedStepDefinition):
  value is AdvancedSnapshotFactDefinition {
  return 'kind' in value && value.kind === 'snapshot-fact';
}

export interface AdvancedPlanMetadata {
  readonly mode: AdvancedMode;
  readonly confirmationId: string;
  readonly previewId?: string;
  readonly treeDigest: string;
  /** Older plans predate these metadata fields; readers default or omit them explicitly. */
  readonly boundaryVersion?: string;
  readonly remoteSnapshotId?: string;
  readonly remoteRevision?: string;
  readonly remoteCursor?: string;
  readonly mounts: readonly MountFact[];
  readonly selectedNativeIds?: readonly string[];
  readonly excludedNativeIds?: readonly string[];
  readonly discovered?: readonly { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }[];
}

export type AdvancedStepDefinition = AdvancedSnapshotFactDefinition | AdvancedStep;

export function parseAdvancedPlanMetadata(raw: unknown): AdvancedPlanMetadata {
  const metadata = object(raw);
  const mode = oneOf(metadata.mode, ['upload', 'download', 'mirror'] as const, 'mode');
  const mounts = parseMounts(metadata.mounts);
  const confirmationId = text(metadata.confirmationId, 'confirmationId');
  const treeDigest = text(metadata.treeDigest, 'treeDigest');
  const boundaryVersion = optionalText(metadata.boundaryVersion, 'boundaryVersion');
  const remoteSnapshotId = optionalText(metadata.remoteSnapshotId, 'remoteSnapshotId');
  const remoteRevision = optionalText(metadata.remoteRevision, 'remoteRevision');
  const remoteCursor = optionalText(metadata.remoteCursor, 'remoteCursor');
  const previewId = optionalText(metadata.previewId, 'previewId');
  const selectedNativeIds = metadata.selectedNativeIds === undefined ? undefined
    : stringArray(metadata.selectedNativeIds, 'selectedNativeIds');
  const excludedNativeIds = metadata.excludedNativeIds === undefined ? undefined
    : stringArray(metadata.excludedNativeIds, 'excludedNativeIds');
  const discovered = metadata.discovered === undefined ? undefined : discoveredArray(metadata.discovered);
  return Object.freeze({ mode, confirmationId, ...(previewId === undefined ? {} : { previewId }), treeDigest,
    ...(boundaryVersion === undefined ? {} : { boundaryVersion }),
    ...(remoteSnapshotId === undefined ? {} : { remoteSnapshotId }),
    ...(remoteRevision === undefined ? {} : { remoteRevision }),
    ...(remoteCursor === undefined ? {} : { remoteCursor }), mounts,
    ...(selectedNativeIds === undefined ? {} : { selectedNativeIds }),
    ...(excludedNativeIds === undefined ? {} : { excludedNativeIds }),
    ...(discovered === undefined ? {} : { discovered }) });
}

export function parseMounts(raw: unknown): readonly MountFact[] {
  if (!Array.isArray(raw) || raw.length === 0) corrupt('mounts');
  const seen = new Set<string>();
  return Object.freeze(raw.map((candidate) => {
    const mount = object(candidate);
    const nativeRootId = text(mount.nativeRootId, 'mounts.nativeRootId');
    if (seen.has(nativeRootId)) corrupt('mounts.nativeRootId');
    seen.add(nativeRootId);
    const rootRole = mount.rootRole === undefined || mount.rootRole === null ? undefined
      : oneOf(mount.rootRole, SPECIAL_ROLES, 'mounts.rootRole');
    const customSourceKey = optionalText(mount.customSourceKey, 'mounts.customSourceKey');
    const remoteMountNodeId = mount.remoteMountNodeId === undefined || mount.remoteMountNodeId === null
      ? null : text(mount.remoteMountNodeId, 'mounts.remoteMountNodeId');
    return Object.freeze({ nativeRootId, remoteMountNodeId,
      ...(rootRole === undefined ? {} : { rootRole }), ...(customSourceKey === undefined ? {} : { customSourceKey }) });
  }));
}

export function parseRemoteNodeFact(raw: unknown): RemoteNodeFact {
  const fact = object(raw);
  const nodeId = text(fact.nodeId, 'fact.nodeId');
  const parentId = nullableText(fact.parentId, 'fact.parentId');
  const kind = oneOf(fact.kind, ['folder', 'bookmark', 'separator'] as const, 'fact.kind');
  const title = text(fact.title, 'fact.title', true);
  const revision = text(fact.revision, 'fact.revision');
  const url = optionalText(fact.url, 'fact.url');
  const folderRole = optionalText(fact.folderRole, 'fact.folderRole');
  const description = fact.description === undefined || fact.description === null ? undefined
    : optionalText(fact.description, 'fact.description');
  const tags = fact.tags === undefined ? undefined : stringArray(fact.tags, 'fact.tags');
  const extensions = fact.extensions === undefined ? undefined : object(fact.extensions);
  const managed = optionalBoolean(fact.managed, 'fact.managed');
  const privateLocal = optionalBoolean(fact.privateLocal, 'fact.privateLocal');
  const position = optionalText(fact.position, 'fact.position');
  const childrenRevision = optionalText(fact.childrenRevision, 'fact.childrenRevision');
  return Object.freeze({ nodeId, parentId, kind, title, revision,
    ...(url === undefined ? {} : { url }), ...(folderRole === undefined ? {} : { folderRole }),
    ...(description === undefined ? {} : { description }), ...(tags === undefined ? {} : { tags }),
    ...(extensions === undefined ? {} : { extensions }), ...(managed === undefined ? {} : { managed }),
    ...(privateLocal === undefined ? {} : { privateLocal }), ...(position === undefined ? {} : { position }),
    ...(childrenRevision === undefined ? {} : { childrenRevision }) });
}

export function parseAdvancedStepDefinition(raw: unknown): AdvancedStepDefinition {
  const definition = object(raw);
  if (definition.kind === 'snapshot-fact') {
    const fact = parseRemoteNodeFact(definition.fact);
    const nativeId = definition.nativeId === null || definition.nativeId === undefined
      ? null : text(definition.nativeId, 'nativeId');
    return Object.freeze({ kind: 'snapshot-fact', fact, nativeId });
  }
  const stepId = text(definition.stepId, 'step.stepId');
  const order = integer(definition.order, 'step.order');
  const dependsOn = stringArray(definition.dependsOn, 'step.dependsOn');
  const side = oneOf(definition.side, ['remote', 'local'] as const, 'step.side');
  const action = oneOf(definition.action, ['create', 'update', 'move', 'delete', 'remove'] as const, 'step.action');
  const operation = text(definition.operation, 'step.operation');
  const common = { stepId, order, dependsOn, side, action, operation };
  if (side === 'remote' && action === 'create') {
    expect(operation, 'create_node');
    const source = object(definition.source);
    const parent = parseParentRef(definition.parent);
    const payload = object(definition.payload);
    expect(payload.type, 'create_node'); parseParentRef(payload.parent);
    if (payload.afterId !== null || payload.beforeId !== null) corrupt('payload');
    parseNodeValue(payload.node);
    if (definition.before !== null) corrupt('before');
    parseDesiredRemote(definition.after);
    return Object.freeze({ ...common, side, action, source: { nativeId: text(source.nativeId, 'source.nativeId'),
      fact: parseLocalState(source.fact) }, parent, payload: payload as never,
    before: null, after: definition.after as AdvancedDesiredRemoteState } as AdvancedStep);
  }
  if (side === 'remote' && action === 'update') {
    expect(operation, 'update_node_content');
    const target = object(definition.target);
    text(target.nodeId, 'target.nodeId'); text(target.nativeId, 'target.nativeId');
    const payload = object(definition.payload);
    expect(payload.type, 'update_node_content'); text(payload.targetId, 'payload.targetId');
    text(payload.baseRevision, 'payload.baseRevision'); stringMap(payload.base, 'payload.base');
    stringMap(payload.value, 'payload.value');
    parseRemoteState(definition.before); parseDesiredRemote(definition.after);
    return Object.freeze({ ...common, side, action, target: target as never, payload: payload as never,
      before: definition.before as AdvancedRemoteState, after: definition.after as AdvancedDesiredRemoteState } as AdvancedStep);
  }
  if (side === 'remote' && action === 'move') {
    expect(operation, 'move_node');
    const source = object(definition.source); text(source.nodeId, 'source.nodeId'); parseRemoteState(source.fact);
    const target = object(definition.target); text(target.nodeId, 'target.nodeId'); text(target.nativeId, 'target.nativeId');
    const parent = parseParentRef(definition.parent);
    const payload = object(definition.payload);
    expect(payload.type, 'move_node'); text(payload.targetId, 'payload.targetId');
    parseRevisionRef(payload.baseRevision); parseParentRef(payload.newParent);
    if (payload.afterId !== null || payload.beforeId !== null) corrupt('payload');
    text(payload.baseSourceParentRevision, 'payload.baseSourceParentRevision');
    parseRevisionRef(payload.baseTargetParentRevision);
    parseRemoteState(definition.before); parseDesiredRemote(definition.after);
    return Object.freeze({ ...common, side, action, source: source as never, target: target as never, parent,
      payload: payload as never, before: definition.before as AdvancedRemoteState,
      after: definition.after as AdvancedDesiredRemoteState } as AdvancedStep);
  }
  if (side === 'remote' && action === 'delete') {
    expectOneOf(operation, ['delete_node', 'delete_subtree'], 'step.operation');
    const target = object(definition.target); text(target.nodeId, 'target.nodeId');
    const payload = object(definition.payload);
    expectOneOf(payload.type, ['delete_node', 'delete_subtree'], 'payload.type');
    expect(payload.type, operation);
    text(payload.targetId, 'payload.targetId'); text(payload.baseRevision, 'payload.baseRevision');
    parseRemoteState(definition.before);
    if (definition.after !== null) corrupt('after');
    return Object.freeze({ ...common, side, action, target: target as never, payload: payload as never,
      before: definition.before as AdvancedRemoteState, after: null } as AdvancedStep);
  }
  if (side === 'local' && action === 'create') {
    expect(operation, 'create');
    const source = object(definition.source); text(source.nodeId, 'source.nodeId'); parseRemoteState(source.fact);
    const parent = parseParentRef(definition.parent);
    const payload = object(definition.payload);
    expect(payload.type, 'create'); parseParentRef(payload.parent);
    integer(payload.index, 'payload.index'); parseNodeValue(payload.node);
    if (definition.before !== null) corrupt('before');
    parseDesiredLocal(definition.after);
    return Object.freeze({ ...common, side, action, source: source as never, parent, payload: payload as never,
      before: null, after: definition.after as AdvancedDesiredLocalState } as AdvancedStep);
  }
  if (side === 'local' && (action === 'update' || action === 'move')) {
    expect(operation, action);
    const parent = action === 'move' ? parseParentRef(definition.parent) : undefined;
    const source = object(definition.source); text(source.nodeId, 'source.nodeId'); parseRemoteState(source.fact);
    const target = object(definition.target); text(target.nativeId, 'target.nativeId'); text(target.nodeId, 'target.nodeId');
    const payload = object(definition.payload);
    expect(payload.type, action); text(payload.nativeId, 'payload.nativeId');
    if (action === 'update') { parseNodeValue(payload.before); parseNodeValue(payload.after); }
    else { parseParentRef(payload.newParent); integer(payload.index, 'payload.index'); }
    parseLocalState(definition.before); parseDesiredLocal(definition.after);
    return Object.freeze({ ...common, side, action, source: source as never, target: target as never,
      ...(parent === undefined ? {} : { parent }),
      payload: payload as never, before: definition.before as AdvancedLocalState,
      after: definition.after as AdvancedDesiredLocalState } as AdvancedStep);
  }
  if (side === 'local' && action === 'remove') {
    expect(operation, 'remove');
    const target = object(definition.target); text(target.nativeId, 'target.nativeId');
    const payload = object(definition.payload);
    expect(payload.type, 'remove'); text(payload.nativeId, 'payload.nativeId');
    if (payload.recursive !== false) corrupt('payload.recursive');
    parseLocalState(definition.before);
    if (definition.after !== null) corrupt('after');
    return Object.freeze({ ...common, side, action, target: target as never, payload: payload as never,
      before: definition.before as AdvancedLocalState, after: null } as AdvancedStep);
  }
  return corrupt('step');
}

function parseParentRef(raw: unknown): AdvancedParentRef {
  const ref = object(raw);
  const kind = oneOf(ref.kind, ['remote-node', 'native-node', 'step'] as const, 'parent.kind');
  if (kind === 'step') return Object.freeze({ kind, stepId: text(ref.stepId, 'parent.stepId') });
  return Object.freeze({ kind, id: text(ref.id, 'parent.id') });
}

function parseRevisionRef(raw: unknown): AdvancedRevisionRef {
  if (typeof raw === 'string') return text(raw, 'revision');
  const ref = object(raw);
  if (ref.kind !== 'step') corrupt('revision.kind');
  return Object.freeze({ kind: 'step', stepId: text(ref.stepId, 'revision.stepId'),
    field: oneOf(ref.field, ['revision', 'childrenRevision'] as const, 'revision.field') });
}

function parseNodeValue(raw: unknown): AdvancedNodeValue {
  const node = object(raw);
  return Object.freeze({ kind: kindOf(node.kind), title: text(node.title, 'node.title', true),
    ...optionalFields({ url: optionalText(node.url, 'node.url'), folderRole: optionalText(node.folderRole, 'node.folderRole') }) });
}

function parseRemoteState(raw: unknown): AdvancedRemoteState {
  const state = object(raw);
  return Object.freeze({ nodeId: text(state.nodeId, 'state.nodeId'),
    parentId: nullableText(state.parentId, 'state.parentId'), kind: kindOf(state.kind),
    title: text(state.title, 'state.title', true), revision: text(state.revision, 'state.revision'),
    ...optionalFields({ url: optionalText(state.url, 'state.url'),
      position: state.position === null || state.position === undefined ? undefined : optionalText(state.position, 'state.position'),
      childrenRevision: state.childrenRevision === null || state.childrenRevision === undefined ? undefined
        : optionalText(state.childrenRevision, 'state.childrenRevision'),
      folderRole: optionalText(state.folderRole, 'state.folderRole') }) });
}

function parseLocalState(raw: unknown): AdvancedLocalState {
  const state = object(raw);
  return Object.freeze({ nativeId: text(state.nativeId, 'state.nativeId'),
    mountNativeRootId: text(state.mountNativeRootId, 'state.mountNativeRootId'),
    parentNativeId: nullableText(state.parentNativeId, 'state.parentNativeId'), kind: kindOf(state.kind),
    title: text(state.title, 'state.title', true),
    ...optionalFields({ url: optionalText(state.url, 'state.url'),
      index: state.index === undefined ? undefined : integer(state.index, 'state.index'),
      folderRole: optionalText(state.folderRole, 'state.folderRole') }) });
}

function parseDesiredRemote(raw: unknown): AdvancedDesiredRemoteState {
  const desired = object(raw);
  const nodeId = desired.nodeId === null ? null : text(desired.nodeId, 'after.nodeId');
  return Object.freeze({ nodeId, parent: parseParentRef(desired.parent), node: parseNodeValue(desired.node) });
}

function parseDesiredLocal(raw: unknown): AdvancedDesiredLocalState {
  const desired = object(raw);
  const nativeId = desired.nativeId === null ? null : text(desired.nativeId, 'after.nativeId');
  return Object.freeze({ nativeId, parent: parseParentRef(desired.parent), node: parseNodeValue(desired.node),
    ...(desired.index === undefined ? {} : { index: integer(desired.index, 'after.index') }) });
}

function discoveredArray(raw: unknown): readonly { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }[] {
  if (!Array.isArray(raw)) corrupt('discovered');
  return Object.freeze(raw.map((candidate) => {
    const row = object(candidate);
    return Object.freeze({ nativeId: text(row.nativeId, 'discovered.nativeId'),
      ancestorNativeIds: stringArray(row.ancestorNativeIds, 'discovered.ancestorNativeIds') });
  }));
}

function stringMap(raw: unknown, label: string): void {
  const map = object(raw);
  for (const key of Object.keys(map)) text(map[key], `${label}.${key}`, true);
}

function optionalFields<T extends Record<string, string | number | undefined>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function kindOf(raw: unknown): AdvancedNodeKind {
  return oneOf(raw, ['folder', 'bookmark', 'separator'] as const, 'kind');
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) corrupt('object');
  return raw as Record<string, unknown>;
}

function text(raw: unknown, label: string, allowEmpty = false): string {
  if (typeof raw !== 'string' || (!allowEmpty && raw.length === 0)) corrupt(label);
  return raw;
}

function optionalText(raw: unknown, label: string): string | undefined {
  return raw === undefined ? undefined : text(raw, label);
}

function nullableText(raw: unknown, label: string): string | null {
  return raw === null ? null : text(raw, label);
}

function integer(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) corrupt(label);
  return raw;
}

function optionalBoolean(raw: unknown, label: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') corrupt(label);
  return raw;
}

function stringArray(raw: unknown, label: string): readonly string[] {
  if (!Array.isArray(raw)) corrupt(label);
  return Object.freeze(raw.map((value) => text(value, label)));
}

function oneOf<const T extends readonly string[]>(raw: unknown, values: T, label: string): T[number] {
  if (typeof raw !== 'string' || !values.includes(raw)) corrupt(label);
  return raw as T[number];
}

function expect(raw: unknown, value: string): void {
  if (raw !== value) corrupt('operation');
}

function expectOneOf(raw: unknown, values: readonly string[], label: string): void {
  if (typeof raw !== 'string' || !values.includes(raw)) corrupt(label);
}

function corrupt(_label: string): never {
  throw new Error(ADVANCED_PLAN_CORRUPT);
}
