import { randomUUID } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionPreconditionError,
  NodeConflictError,
  strongEntityTag,
} from '../domain/index.js';
import type { ProductCollectionCanonicalPorts } from './ports.js';
import {
  createCollectionNode,
  createCollectionNodeCommandScope,
  type CreateCollectionNodeResult,
} from './create-collection-node.js';
import {
  moveCollectionNode,
  moveCollectionNodeCommandScope,
  type MoveCollectionNodeResult,
} from './move-collection-node.js';
import {
  isOrganizePlanExpired,
  ORGANIZE_PLAN_CONTRACT_VERSION,
  ORGANIZE_PLAN_MAX_ACTIONS,
  OrganizePlanInputError,
  OrganizePlanNotFoundError,
  organizePlanItemRoute,
  type OrganizePlanActionDto,
  type OrganizePlanCollectionPort,
  type OrganizePlanReadPort,
  type OrganizePlanReceiptPort,
  type OrganizePlanRecord,
  type OrganizePlanWritePort,
} from './create-collection-organize-plan.js';
import {
  captureCollectionTreeVersion,
  CollectionVersionNodeLimitError,
  type CollectionVersionStorePort,
} from './capture-collection-tree-version.js';
import { isInboxFolderTitle } from './organize-planner-tokens.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export const ORGANIZE_PLAN_APPLY_CONTRACT_VERSION = ORGANIZE_PLAN_CONTRACT_VERSION;

export interface OrganizePlanActionCommandIds {
  readonly createCommandId?: string;
  readonly moveCommandIds: readonly string[];
}

export type OrganizePlanApplyReceiptMap = Readonly<Record<string, OrganizePlanActionCommandIds>>;

export interface OrganizePlanApplyReceiptDto {
  readonly planId: string;
  readonly appliedActionIds: readonly string[];
  readonly createdFolderIds: readonly string[];
  readonly movedNodeIds: readonly string[];
}

export interface OrganizePlanApplyPort extends OrganizePlanReadPort, OrganizePlanWritePort {}

export interface ApplyCollectionOrganizePlanPorts {
  readonly receipts: OrganizePlanReceiptPort;
  readonly plans: OrganizePlanApplyPort;
  readonly collections: OrganizePlanCollectionPort;
  readonly mutations: ProductCollectionCanonicalPorts;
  readonly clock: { now(): Date | Promise<Date> };
  readonly commandIds?: { next(): string };
  readonly treeVersions?: {
    readonly enabled: boolean;
    readonly versions: CollectionVersionStorePort;
  };
}

export interface ApplyCollectionOrganizePlanInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly collectionId: string;
  readonly planId: string;
  readonly ifMatch: string;
  readonly actionIds: readonly string[];
}

export type ApplyCollectionOrganizePlanResult =
  | { readonly kind: 'succeeded'; readonly receipt: OrganizePlanApplyReceiptDto }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export class OrganizePlanInnerCommandError extends Error {
  readonly outcome: Exclude<ApplyCollectionOrganizePlanResult, { readonly kind: 'succeeded' }>;

  constructor(outcome: Exclude<ApplyCollectionOrganizePlanResult, { readonly kind: 'succeeded' }>) {
    super(`organize-plan inner command ${outcome.kind}`);
    this.name = 'OrganizePlanInnerCommandError';
    this.outcome = outcome;
  }
}

export function organizePlanApplyRoute(collectionId: string, planId: string): string {
  return `${organizePlanItemRoute(collectionId, planId)}/apply`;
}

export function organizePlanApplyCommandScope(collectionId: string, planId: string): string {
  return `collection:${collectionId}:organize-plan:${planId}:apply`;
}

export function organizePlanApplyFingerprint(input: {
  readonly collectionId: string;
  readonly planId: string;
  readonly actionIds: readonly string[];
  readonly ifMatch: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: organizePlanApplyRoute(input.collectionId, input.planId),
    mediaType: 'application/json',
    body: { actionIds: input.actionIds },
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

export function organizePlanInternalCreateFingerprint(input: {
  readonly collectionId: string;
  readonly parentId: string;
  readonly title: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/collections/${input.collectionId}/nodes`,
    mediaType: 'application/json',
    body: {
      parentId: input.parentId,
      afterId: null,
      beforeId: null,
      node: {
        kind: 'folder',
        title: input.title,
        description: null,
        tags: [],
        visibility: 'inherit',
      },
    },
    query: {},
    conditions: {},
  });
}

export function organizePlanInternalMoveFingerprint(input: {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly newParentId: string;
  readonly baseSourceParentRevision: string;
  readonly baseTargetParentRevision: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}/move`,
    mediaType: 'application/json',
    body: {
      newParentId: input.newParentId,
      afterId: null,
      beforeId: null,
      baseSourceParentRevision: input.baseSourceParentRevision,
      baseTargetParentRevision: input.baseTargetParentRevision,
    },
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

export async function applyCollectionOrganizePlan(
  ports: ApplyCollectionOrganizePlanPorts,
  input: ApplyCollectionOrganizePlanInput,
): Promise<ApplyCollectionOrganizePlanResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new OrganizePlanInputError('The organize-plan actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)
    || typeof input.planId !== 'string' || !OPAQUE_ID.test(input.planId)) {
    throw new OrganizePlanNotFoundError();
  }
  const actionIds = normalizeActionIds(input.actionIds);
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new OrganizePlanInputError('commandId must be a canonical UUID v4.');
  }
  if (typeof input.ifMatch !== 'string' || input.ifMatch.length < 1) {
    throw new OrganizePlanInputError('If-Match is required for this operation.');
  }

  const fingerprint = organizePlanApplyFingerprint({
    collectionId: input.collectionId,
    planId: input.planId,
    actionIds,
    ifMatch: input.ifMatch,
  });
  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: organizePlanApplyCommandScope(input.collectionId, input.planId),
    commandId,
  };
  const existing = await ports.receipts.lookup(binding, fingerprint);
  if (existing.kind !== 'absent') return mapClaim(existing);

  const preview = await ports.plans.getById(input.actor.principalId, input.collectionId, input.planId);
  const now = await Promise.resolve(ports.clock.now());
  if (!preview || isOrganizePlanExpired(preview, now)) throw new OrganizePlanNotFoundError();
  if (input.ifMatch !== preview.etag) {
    throw new CollectionPreconditionError({ currentEtag: preview.etag });
  }

  selectActions(preview, actionIds);
  const collection = await ports.collections.lockOwnedLive(input.collectionId, input.actor.subjectId);
  if (!collection) throw new OrganizePlanNotFoundError();
  const plan = await ports.plans.getById(input.actor.principalId, input.collectionId, input.planId);
  if (!plan || isOrganizePlanExpired(plan, now)) throw new OrganizePlanNotFoundError();
  if (input.ifMatch !== plan.etag) {
    throw new CollectionPreconditionError({ currentEtag: plan.etag });
  }
  if (collection.contentRevision !== plan.collectionRevision) {
    throw new NodeConflictError('revision_conflict');
  }
  const selected = selectActions(plan, actionIds);

  await assertSelectedNodesStillValid(ports, plan, selected, collection.rootNodeId);

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const actor = {
    principalId: input.actor.principalId,
    principalType: 'account' as const,
    subjectId: input.actor.subjectId,
  };
  const applyReceipt = resolveApplyReceipt(plan, selected, () => nextCommandId(ports));
  await ports.plans.persistApplyReceipt({
    planId: plan.planId,
    accountId: input.actor.principalId,
    collectionId: input.collectionId,
    applyReceipt,
    now,
  });

  if (ports.treeVersions?.enabled === true) {
    try {
      await captureCollectionTreeVersion(
        { versions: ports.treeVersions.versions, clock: ports.clock },
        {
          accountId: input.actor.principalId,
          collection,
          kind: 'pre_mutation',
          label: 'Before organize',
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof CollectionVersionNodeLimitError)) throw error;
    }
  }

  const createdFolderIds: string[] = [];
  const movedNodeIds: string[] = [];
  for (const action of selected) {
    const mapped = applyReceipt[action.id];
    if (!mapped) throw new OrganizePlanInputError('apply receipt is missing selected action command ids.');
    let newParentId: string;
    if (action.target.type === 'create_folder') {
      if (typeof mapped.createCommandId !== 'string') {
        throw new OrganizePlanInputError('apply receipt is missing createCommandId.');
      }
      const created = await createCollectionNode(ports.mutations, {
        actor,
        command: {
          commandId: mapped.createCommandId,
          fingerprint: organizePlanInternalCreateFingerprint({
            collectionId: input.collectionId,
            parentId: collection.rootNodeId,
            title: action.target.title,
          }),
          commandScope: createCollectionNodeCommandScope(input.collectionId),
        },
        collectionId: input.collectionId,
        parentId: collection.rootNodeId,
        afterId: null,
        beforeId: null,
        node: {
          kind: 'folder',
          title: action.target.title,
          description: null,
          tags: [],
          visibility: 'inherit',
        },
      });
      newParentId = folderIdFromCreate(created);
      createdFolderIds.push(newParentId);
    } else {
      newParentId = action.target.folderId;
    }
    assertSafeNewParent(newParentId, collection.rootNodeId, action.sourceFolderId);

    for (const [index, nodeId] of action.nodeIds.entries()) {
      const moveCommandId = mapped.moveCommandIds[index];
      if (typeof moveCommandId !== 'string') {
        throw new OrganizePlanInputError('apply receipt is missing a moveCommandId.');
      }
      const bookmark = await requireLiveBookmark(
        ports.mutations,
        input.collectionId,
        nodeId,
        action.sourceFolderId,
      );
      const sourceParent = await requireLiveFolder(ports.mutations, input.collectionId, bookmark.parentId ?? '');
      const targetParent = await requireLiveFolder(ports.mutations, input.collectionId, newParentId);
      const ifMatch = strongEntityTag(bookmark.resourceRevision);
      const moved = await moveCollectionNode(ports.mutations, {
        actor,
        command: {
          commandId: moveCommandId,
          fingerprint: organizePlanInternalMoveFingerprint({
            collectionId: input.collectionId,
            nodeId,
            ifMatch,
            newParentId,
            baseSourceParentRevision: sourceParent.childrenRevision,
            baseTargetParentRevision: targetParent.childrenRevision,
          }),
          commandScope: moveCollectionNodeCommandScope(input.collectionId, nodeId),
        },
        collectionId: input.collectionId,
        nodeId,
        ifMatch,
        newParentId,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: sourceParent.childrenRevision,
        baseTargetParentRevision: targetParent.childrenRevision,
      });
      assertMoveSucceeded(moved);
      movedNodeIds.push(nodeId);
    }
  }

  await ports.plans.markApplied({
    planId: plan.planId,
    accountId: input.actor.principalId,
    collectionId: input.collectionId,
    appliedActionIds: actionIds,
    now,
  });
  const receipt: OrganizePlanApplyReceiptDto = {
    planId: plan.planId,
    appliedActionIds: actionIds,
    createdFolderIds,
    movedNodeIds,
  };
  await ports.receipts.complete(binding, fingerprint, applyProductResult(receipt));
  return { kind: 'succeeded', receipt };
}

export function normalizeOrganizePlanActionIds(raw: unknown): readonly string[] {
  return normalizeActionIds(raw);
}

function normalizeActionIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ORGANIZE_PLAN_MAX_ACTIONS) {
    throw new OrganizePlanInputError('actionIds is invalid.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
      throw new OrganizePlanInputError('actionIds is invalid.');
    }
    if (seen.has(value)) throw new OrganizePlanInputError('actionIds is invalid.');
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

function selectActions(
  plan: OrganizePlanRecord,
  actionIds: readonly string[],
): readonly OrganizePlanActionDto[] {
  const byId = new Map(plan.actions.map((action) => [action.id, action]));
  return actionIds.map((actionId) => {
    const action = byId.get(actionId);
    if (!action) throw new OrganizePlanInputError('actionIds is invalid.');
    return action;
  });
}

async function assertSelectedNodesStillValid(
  ports: ApplyCollectionOrganizePlanPorts,
  plan: OrganizePlanRecord,
  selected: readonly OrganizePlanActionDto[],
  rootId: string,
): Promise<void> {
  for (const action of selected) {
    if (action.target.type === 'create_folder') {
      if (action.target.parentId !== rootId) {
        throw new NodeConflictError('revision_conflict');
      }
      await requireLiveFolder(ports.mutations, plan.collectionId, rootId);
    } else {
      const folder = await requireLiveFolder(ports.mutations, plan.collectionId, action.target.folderId);
      if (folder.id === rootId || folder.id === action.sourceFolderId || isInboxFolderTitle(folder.title)) {
        throw new NodeConflictError('revision_conflict');
      }
    }
    for (const nodeId of action.nodeIds) {
      await requireLiveBookmark(ports.mutations, plan.collectionId, nodeId, action.sourceFolderId);
    }
  }
}

function assertSafeNewParent(newParentId: string, rootId: string, sourceFolderId: string): void {
  if (newParentId === rootId || newParentId === sourceFolderId) {
    throw new NodeConflictError('revision_conflict');
  }
}

async function requireLiveBookmark(
  mutations: ProductCollectionCanonicalPorts,
  collectionId: string,
  nodeId: string,
  sourceFolderId: string,
) {
  const node = await mutations.nodes.getNode(collectionId, nodeId);
  if (!node || node.deletedAt !== null || node.kind !== 'bookmark' || node.parentId !== sourceFolderId) {
    throw new NodeConflictError('revision_conflict');
  }
  return node;
}

async function requireLiveFolder(
  mutations: ProductCollectionCanonicalPorts,
  collectionId: string,
  folderId: string,
) {
  const node = await mutations.nodes.getNode(collectionId, folderId);
  if (!node || node.deletedAt !== null || node.kind !== 'folder') {
    throw new NodeConflictError('revision_conflict');
  }
  return node;
}

function nextCommandId(ports: ApplyCollectionOrganizePlanPorts): string {
  return assertCanonicalCommandId(ports.commandIds?.next() ?? randomUUID());
}

function resolveApplyReceipt(
  plan: OrganizePlanRecord,
  selected: readonly OrganizePlanActionDto[],
  nextId: () => string,
): OrganizePlanApplyReceiptMap {
  const existing = asReceiptMap(plan.applyReceipt);
  if (existing && selected.every((action) => {
    const mapped = existing[action.id];
    return mapped !== undefined
      && mapped.moveCommandIds.length === action.nodeIds.length
      && (action.target.type !== 'create_folder' || typeof mapped.createCommandId === 'string');
  })) {
    return existing;
  }
  const receipt: Record<string, OrganizePlanActionCommandIds> = {};
  for (const action of selected) {
    const moveCommandIds = action.nodeIds.map(() => nextId());
    receipt[action.id] = action.target.type === 'create_folder'
      ? { createCommandId: nextId(), moveCommandIds }
      : { moveCommandIds };
  }
  return receipt;
}

function asReceiptMap(value: unknown): OrganizePlanApplyReceiptMap | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const mapped: Record<string, OrganizePlanActionCommandIds> = {};
  for (const [actionId, raw] of Object.entries(record)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entry = raw as { createCommandId?: unknown; moveCommandIds?: unknown };
    if (!Array.isArray(entry.moveCommandIds)
      || !entry.moveCommandIds.every((id): id is string => typeof id === 'string')) {
      return null;
    }
    mapped[actionId] = {
      ...(typeof entry.createCommandId === 'string' ? { createCommandId: entry.createCommandId } : {}),
      moveCommandIds: entry.moveCommandIds,
    };
  }
  return mapped;
}

function folderIdFromCreate(result: CreateCollectionNodeResult): string {
  if (result.kind === 'created') return result.node.id;
  if (result.kind === 'replay' && result.status >= 200 && result.status < 300) {
    try {
      const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as { node?: { id?: unknown } };
      if (typeof parsed.node?.id === 'string' && parsed.node.id.length > 0) return parsed.node.id;
    } catch {
      // fall through to inner outcome mapping
    }
  }
  throw innerOutcome(result);
}

function assertMoveSucceeded(result: MoveCollectionNodeResult): void {
  if (result.kind === 'moved') return;
  if (result.kind === 'replay' && result.status >= 200 && result.status < 300) return;
  throw innerOutcome(result);
}

function innerOutcome(
  result: CreateCollectionNodeResult | MoveCollectionNodeResult,
): OrganizePlanInnerCommandError {
  switch (result.kind) {
    case 'created':
    case 'moved':
      throw new Error('unhandled organize apply inner command outcome');
    case 'in_progress':
      return new OrganizePlanInnerCommandError({
        kind: 'in_progress',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    case 'replay':
      return new OrganizePlanInnerCommandError({
        kind: 'replay',
        status: result.status,
        body: result.body,
        stableHeaders: result.stableHeaders,
        mediaType: result.mediaType,
      });
    case 'reused':
      return new OrganizePlanInnerCommandError({ kind: 'reused' });
    case 'expired':
      return new OrganizePlanInnerCommandError({ kind: 'expired' });
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function applyProductResult(receipt: OrganizePlanApplyReceiptDto): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(receipt), 'utf8');
  return {
    status: 200,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: ORGANIZE_PLAN_APPLY_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): ApplyCollectionOrganizePlanResult {
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return { kind: 'expired' };
  return { kind: 'reused' };
}
