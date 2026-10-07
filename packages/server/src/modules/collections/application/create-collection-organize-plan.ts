import { createHash } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../commands/index.js';
import { formatUtcDateTime, generateOpaqueId, strongEntityTag } from '../domain/index.js';
import { selectOrganizeSource } from './organize-inbox-selection.js';
import type {
  OrganizePlanTarget,
  OrganizePlanner,
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
  OrganizePlannerOutput,
} from './organize-planner.js';

export const ORGANIZE_PLAN_COMMAND_SCOPE = 'collections:organize-plans:v1';
export const ORGANIZE_PLAN_CONTRACT_VERSION = '1.0.0';
export const ORGANIZE_PLAN_TTL_MS = 30 * 60 * 1000;
export const ORGANIZE_PLAN_CREATE_COOLDOWN_MS = 10_000;
export const ORGANIZE_PLAN_MAX_ACTIONS = 20;
export const ORGANIZE_PLAN_MAX_NODES_PER_ACTION = 50;
export const ORGANIZE_PLAN_MAX_SOURCE_FOLDERS = 20;

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type OrganizePlanStatus = 'open' | 'applied' | 'expired';

export class OrganizePlanInputError extends Error {
  readonly code = 'invalid_request' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OrganizePlanInputError';
  }
}

export class OrganizePlanNotFoundError extends Error {
  readonly code = 'resource_not_found' as const;
  constructor(message = 'The requested resource was not found.') {
    super(message);
    this.name = 'OrganizePlanNotFoundError';
  }
}

export class OrganizePlanRateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  constructor(message = 'Too many organize-plan create requests.') {
    super(message);
    this.name = 'OrganizePlanRateLimitError';
  }
}

export interface OrganizePlanActionDto {
  readonly id: string;
  readonly sourceFolderId: string;
  readonly sourceFolderTitle: string;
  readonly target: OrganizePlanTarget;
  readonly nodeIds: readonly string[];
  readonly count: number;
  readonly reason: string;
  readonly confidence: number;
}

export interface OrganizePlanDto {
  readonly planId: string;
  readonly etag: string;
  readonly expiresAt: string;
  readonly collectionRevision: string;
  readonly plannerId: string;
  readonly truncated: boolean;
  readonly actions: readonly OrganizePlanActionDto[];
}

export interface OrganizePlanRecord {
  readonly planId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly collectionRevision: string;
  readonly plannerId: string;
  readonly status: OrganizePlanStatus;
  readonly expiresAt: Date;
  readonly etag: string;
  readonly truncated: boolean;
  readonly actions: readonly OrganizePlanActionDto[];
  readonly appliedActionIds: readonly string[] | null;
  readonly applyReceipt: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrganizePlanCollectionSnapshot {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly contentRevision: string;
  readonly rootNodeId: string;
}

export interface OrganizePlanTree {
  readonly folders: readonly OrganizePlannerFolder[];
  readonly bookmarks: readonly OrganizePlannerBookmark[];
}

export interface OrganizePlanReceiptPort {
  claim(binding: ProductCommandBinding, fingerprint: string): Promise<ProductCommandClaim>;
  complete(binding: ProductCommandBinding, fingerprint: string, result: ProductCommandResult): Promise<void>;
  lookup(
    binding: ProductCommandBinding,
    fingerprint: string,
  ): Promise<
    | { readonly kind: 'absent' }
    | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
  >;
}

export interface OrganizePlanWritePort {
  expireOpen(accountId: string, collectionId: string, now: Date): Promise<void>;
  insert(row: OrganizePlanRecord): Promise<void>;
  findLatestCreatedAt(accountId: string, collectionId: string): Promise<Date | null>;
  persistApplyReceipt(input: {
    readonly planId: string;
    readonly accountId: string;
    readonly collectionId: string;
    readonly applyReceipt: unknown;
    readonly now: Date;
  }): Promise<void>;
  markApplied(input: {
    readonly planId: string;
    readonly accountId: string;
    readonly collectionId: string;
    readonly appliedActionIds: readonly string[];
    readonly now: Date;
  }): Promise<void>;
}

export interface OrganizePlanReadPort {
  getById(accountId: string, collectionId: string, planId: string): Promise<OrganizePlanRecord | null>;
}

export interface OrganizePlanCollectionPort {
  lockOwnedLive(collectionId: string, ownerSubjectId: string): Promise<OrganizePlanCollectionSnapshot | null>;
  loadLiveTree(collectionId: string): Promise<OrganizePlanTree>;
}

export interface CreateCollectionOrganizePlanPorts {
  readonly receipts: OrganizePlanReceiptPort;
  readonly plans: OrganizePlanWritePort;
  readonly collections: OrganizePlanCollectionPort;
  readonly planner: OrganizePlanner;
  readonly clock: { now(): Date | Promise<Date> };
  readonly ids?: { nextPlanId(): string; nextActionId(): string };
}

export interface CreateCollectionOrganizePlanInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly collectionId: string;
  readonly sourceFolderIds?: readonly string[];
}

export type CreateCollectionOrganizePlanResult =
  | { readonly kind: 'succeeded'; readonly plan: OrganizePlanDto }
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

export function organizePlanCreateRoute(collectionId: string): string {
  return `/api/v1/collections/${collectionId}/organize-plans`;
}

export function organizePlanItemRoute(collectionId: string, planId: string): string {
  return `/api/v1/collections/${collectionId}/organize-plans/${planId}`;
}

export function organizePlanCreateFingerprint(input: {
  readonly collectionId: string;
  readonly sourceFolderIds: readonly string[];
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: organizePlanCreateRoute(input.collectionId),
    mediaType: 'application/json',
    body: { sourceFolderIds: input.sourceFolderIds },
  });
}

export function toOrganizePlanDto(record: OrganizePlanRecord): OrganizePlanDto {
  return {
    planId: record.planId,
    etag: record.etag,
    expiresAt: formatUtcDateTime(record.expiresAt),
    collectionRevision: record.collectionRevision,
    plannerId: record.plannerId,
    truncated: record.truncated,
    actions: record.actions,
  };
}

export function isOrganizePlanExpired(record: OrganizePlanRecord, now: Date): boolean {
  return record.status !== 'open' || record.expiresAt.getTime() <= now.getTime();
}

export function freezeOrganizePlanEtag(input: {
  readonly planId: string;
  readonly contentRevision: string;
  readonly actionIds: readonly string[];
}): string {
  const digest = createHash('sha256')
    .update([input.planId, input.contentRevision, ...[...input.actionIds].sort()].join('\n'), 'utf8')
    .digest('base64url');
  return strongEntityTag(digest);
}

export function truncateOrganizePlanActions(
  output: OrganizePlannerOutput,
  nextActionId: () => string,
): { readonly truncated: boolean; readonly actions: readonly OrganizePlanActionDto[] } {
  let truncated = output.truncated;
  const kept: OrganizePlanActionDto[] = [];
  for (const action of output.actions) {
    if (kept.length >= ORGANIZE_PLAN_MAX_ACTIONS) {
      truncated = true;
      break;
    }
    const nodeIds = [...action.nodeIds].sort().slice(0, ORGANIZE_PLAN_MAX_NODES_PER_ACTION);
    if (nodeIds.length < action.nodeIds.length) truncated = true;
    if (nodeIds.length === 0) continue;
    kept.push({
      id: nextActionId(),
      sourceFolderId: action.sourceFolderId,
      sourceFolderTitle: action.sourceFolderTitle,
      target: action.target,
      nodeIds,
      count: nodeIds.length,
      reason: action.reason,
      confidence: action.confidence,
    });
  }
  if (output.actions.length > ORGANIZE_PLAN_MAX_ACTIONS) truncated = true;
  return { truncated, actions: kept };
}

export async function createCollectionOrganizePlan(
  ports: CreateCollectionOrganizePlanPorts,
  input: CreateCollectionOrganizePlanInput,
): Promise<CreateCollectionOrganizePlanResult> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new OrganizePlanInputError('The organize-plan actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)) {
    throw new OrganizePlanNotFoundError();
  }
  const sourceFolderIds = normalizeSourceFolderIds(input.sourceFolderIds);
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new OrganizePlanInputError('commandId must be a canonical UUID v4.');
  }
  const fingerprint = organizePlanCreateFingerprint({
    collectionId: input.collectionId,
    sourceFolderIds,
  });
  const binding: ProductCommandBinding = {
    principalId: input.actor.principalId,
    commandScope: ORGANIZE_PLAN_COMMAND_SCOPE,
    commandId,
  };
  const existing = await ports.receipts.lookup(binding, fingerprint);
  if (existing.kind !== 'absent') return mapClaim(existing);

  const collection = await ports.collections.lockOwnedLive(
    input.collectionId,
    input.actor.subjectId,
  );
  if (!collection) throw new OrganizePlanNotFoundError();

  const now = await Promise.resolve(ports.clock.now());
  const latest = await ports.plans.findLatestCreatedAt(input.actor.principalId, input.collectionId);
  if (latest && now.getTime() - latest.getTime() < ORGANIZE_PLAN_CREATE_COOLDOWN_MS) {
    throw new OrganizePlanRateLimitError();
  }

  const tree = await ports.collections.loadLiveTree(input.collectionId);
  const selected = selectOrganizeSource({
    rootId: collection.rootNodeId,
    folders: tree.folders,
    bookmarks: tree.bookmarks,
  });
  const inboxSet = new Set(selected.inboxFolderIds);
  let inboxFolderIds = selected.inboxFolderIds;
  let bookmarks = selected.bookmarks;
  if (sourceFolderIds.length > 0) {
    for (const folderId of sourceFolderIds) {
      if (!inboxSet.has(folderId)) throw new OrganizePlanNotFoundError();
    }
    const requested = new Set(sourceFolderIds);
    inboxFolderIds = selected.inboxFolderIds.filter((id) => requested.has(id));
    bookmarks = selected.bookmarks.filter((bookmark) => requested.has(bookmark.parentId));
  }

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const planned = await ports.planner.plan({
    rootId: collection.rootNodeId,
    folders: selected.folders,
    bookmarks,
    inboxFolderIds,
  });
  const nextActionId = () => ports.ids?.nextActionId() ?? generateOpaqueId();
  const { truncated, actions } = truncateOrganizePlanActions(planned, nextActionId);
  const planId = ports.ids?.nextPlanId() ?? generateOpaqueId();
  const expiresAt = new Date(now.getTime() + ORGANIZE_PLAN_TTL_MS);
  const etag = freezeOrganizePlanEtag({
    planId,
    contentRevision: collection.contentRevision,
    actionIds: actions.map((action) => action.id),
  });
  const record: OrganizePlanRecord = {
    planId,
    accountId: input.actor.principalId,
    collectionId: input.collectionId,
    collectionRevision: collection.contentRevision,
    plannerId: planned.plannerId,
    status: 'open',
    expiresAt,
    etag,
    truncated,
    actions,
    appliedActionIds: null,
    applyReceipt: null,
    createdAt: now,
    updatedAt: now,
  };
  const dto = toOrganizePlanDto(record);
  try {
    await ports.plans.expireOpen(input.actor.principalId, input.collectionId, now);
    await ports.plans.insert(record);
  } catch (error: unknown) {
    if (error instanceof OrganizePlanRateLimitError) {
      await ports.receipts.complete(binding, fingerprint, rateLimitedResult());
      throw error;
    }
    throw error;
  }
  await ports.receipts.complete(binding, fingerprint, productResult(dto, input.collectionId));
  return { kind: 'succeeded', plan: dto };
}

function normalizeSourceFolderIds(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ORGANIZE_PLAN_MAX_SOURCE_FOLDERS) {
    throw new OrganizePlanInputError('sourceFolderIds is invalid.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
      throw new OrganizePlanInputError('sourceFolderIds is invalid.');
    }
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

function productResult(plan: OrganizePlanDto, collectionId: string): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(plan), 'utf8');
  return {
    status: 201,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      etag: plan.etag,
      location: organizePlanItemRoute(collectionId, plan.planId),
    },
    mediaType: 'application/json',
    contractVersion: ORGANIZE_PLAN_CONTRACT_VERSION,
  };
}

function rateLimitedResult(): ProductCommandResult {
  const body = Buffer.from(JSON.stringify({
    error: { code: 'rate_limited', message: 'Too many organize-plan create requests.' },
  }), 'utf8');
  return {
    status: 429,
    body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: ORGANIZE_PLAN_CONTRACT_VERSION,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CreateCollectionOrganizePlanResult {
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
