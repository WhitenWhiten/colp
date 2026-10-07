import { assertCanonicalCommandId, canonicalJson, type ProductCommandReceiptPort,
  type ProductCommandResult } from '../../commands/index.js';

export type SavedResourceType = 'collection' | 'node';
export const SAVED_RESOURCE_CONTRACT_VERSION = '1.0.0';
export type SavedResourceErrorCode = 'invalid_saved_resource_input'
  | 'invalid_saved_resource_target' | 'saved_resource_not_found';

export class SavedResourceError extends Error {
  constructor(readonly code: SavedResourceErrorCode, message: string) {
    super(message); this.name = 'SavedResourceError';
  }
}

export interface SavedResourceRecord {
  readonly id: string; readonly accountId: string; readonly resourceType: SavedResourceType;
  readonly resourceId: string; readonly savedAt: Date; readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}
export interface SavedResourceTargetFacts {
  readonly resourceType: SavedResourceType; readonly resourceId: string; readonly collectionId: string;
}
export interface SavedResourceAuditEvent {
  readonly principalId: string; readonly accountId: string;
  readonly eventType: 'saved_resource.saved' | 'saved_resource.unsaved';
  readonly resourceType: SavedResourceType; readonly changed: boolean; readonly createdAt: Date;
}
export interface SavedResourceCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly targets: { resolveAccessible(input: { readonly actorSubjectId: string;
    readonly resourceType: SavedResourceType; readonly resourceId: string }): Promise<SavedResourceTargetFacts | null> };
  readonly savedResources: {
    findLive(input: { readonly accountId: string; readonly resourceType: SavedResourceType;
      readonly resourceId: string }): Promise<SavedResourceRecord | null>;
    insertLive(input: { readonly accountId: string; readonly resourceType: SavedResourceType;
      readonly resourceId: string; readonly at: Date }): Promise<{ readonly record: SavedResourceRecord;
        readonly inserted: boolean }>;
    softDelete(input: { readonly accountId: string; readonly resourceType: SavedResourceType;
      readonly resourceId: string; readonly at: Date }): Promise<SavedResourceRecord | null>;
  };
  readonly audit: { append(event: SavedResourceAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}
export interface SavedResourceUnitOfWork {
  execute<Result>(work: (ports: SavedResourceCommandPorts) => Promise<Result>, request?: { readonly signal?: AbortSignal }): Promise<Result>;
}
export interface SavedResourceCommandInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string; readonly accountId: string };
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly target: { readonly resourceType: SavedResourceType; readonly resourceId: string };
}
export type SavedResourceCommandResult =
  | { readonly kind: 'saved'; readonly changed: boolean; readonly savedResource: SavedResourceRecord }
  | { readonly kind: 'unsaved'; readonly changed: boolean }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export function savedResourceCommandScope(action: 'save' | 'unsave', target: SavedResourceCommandInput['target']): string {
  return `saved-resource:${target.resourceType}:${target.resourceId}:${action}`;
}

export async function saveResource(ports: SavedResourceCommandPorts,
  input: SavedResourceCommandInput): Promise<SavedResourceCommandResult> {
  const value = validateInput(input, 'save');
  const binding = { principalId: value.actor.principalId, commandScope: value.command.commandScope,
    commandId: value.command.commandId };
  const claim = await ports.receipts.claim(binding, value.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const target = await ports.targets.resolveAccessible({ actorSubjectId: value.actor.subjectId,
    resourceType: value.target.resourceType, resourceId: value.target.resourceId });
  if (!target || target.resourceType !== value.target.resourceType
      || target.resourceId !== value.target.resourceId
      || typeof target.collectionId !== 'string' || target.collectionId.length === 0) {
    throw new SavedResourceError('saved_resource_not_found', 'Saved resource target was not found.');
  }
  const now = await ports.clock.now();
  const existing = await ports.savedResources.findLive({ accountId: value.actor.accountId, ...value.target });
  const outcome = existing ? { record: existing, inserted: false }
    : await ports.savedResources.insertLive({ accountId: value.actor.accountId, ...value.target, at: now });
  assertOwnedLiveRecord(outcome.record, value.actor.accountId, value.target);
  await ports.audit.append({ principalId: value.actor.principalId, accountId: value.actor.accountId,
    eventType: 'saved_resource.saved', resourceType: value.target.resourceType,
    changed: outcome.inserted, createdAt: now });
  await ports.receipts.complete(binding, value.command.fingerprint, saveProductResult(outcome.record, outcome.inserted));
  return { kind: 'saved', changed: outcome.inserted, savedResource: outcome.record };
}

export async function unsaveResource(ports: SavedResourceCommandPorts,
  input: SavedResourceCommandInput): Promise<SavedResourceCommandResult> {
  const value = validateInput(input, 'unsave');
  const binding = { principalId: value.actor.principalId, commandScope: value.command.commandScope,
    commandId: value.command.commandId };
  const claim = await ports.receipts.claim(binding, value.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const now = await ports.clock.now();
  const removed = await ports.savedResources.softDelete({ accountId: value.actor.accountId, ...value.target, at: now });
  if (removed) assertOwnedDeletedRecord(removed, value.actor.accountId, value.target);
  await ports.audit.append({ principalId: value.actor.principalId, accountId: value.actor.accountId,
    eventType: 'saved_resource.unsaved', resourceType: value.target.resourceType,
    changed: removed !== null, createdAt: now });
  await ports.receipts.complete(binding, value.command.fingerprint, unsaveProductResult(value.target));
  return { kind: 'unsaved', changed: removed !== null };
}

interface ValidatedInput extends SavedResourceCommandInput {
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string };
}
function validateInput(input: SavedResourceCommandInput, action: 'save' | 'unsave'): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command || !input.target) {
    throw new SavedResourceError('invalid_saved_resource_input', 'Saved resource command input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.actor.accountId,
    input.command.fingerprint, input.target.resourceId]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SavedResourceError('invalid_saved_resource_input', 'Saved resource identity fields are required.');
    }
  }
  if (input.target.resourceType !== 'collection' && input.target.resourceType !== 'node') {
    throw new SavedResourceError('invalid_saved_resource_target', 'Only Collection and Node targets can be saved.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new SavedResourceError('invalid_saved_resource_input', 'commandId must be a canonical UUID v4.'); }
  return { ...input, command: { commandId, fingerprint: input.command.fingerprint,
    commandScope: input.command.commandScope?.trim() || savedResourceCommandScope(action, input.target) } };
}
function saveProductResult(record: SavedResourceRecord, changed: boolean): ProductCommandResult {
  return { status: changed ? 201 : 200, body: Buffer.from(canonicalJson({ resourceType: record.resourceType,
    resourceId: record.resourceId, savedAt: record.savedAt.toISOString(), changed })), stableHeaders: {
    'cache-control': 'private, no-store', 'content-type': 'application/json',
  }, mediaType: 'application/json', contractVersion: SAVED_RESOURCE_CONTRACT_VERSION,
  targetIdentity: `${record.resourceType}:${record.resourceId}` };
}
function assertOwnedLiveRecord(record: SavedResourceRecord, accountId: string,
  target: SavedResourceCommandInput['target']): void {
  if (record.accountId !== accountId || record.resourceType !== target.resourceType
      || record.resourceId !== target.resourceId || record.deletedAt !== null
      || !(record.savedAt instanceof Date) || !Number.isFinite(record.savedAt.getTime())
      || !(record.updatedAt instanceof Date) || !Number.isFinite(record.updatedAt.getTime())
      || record.updatedAt.getTime() < record.savedAt.getTime()) {
    throw new SavedResourceError('invalid_saved_resource_input', 'Saved resource storage returned invalid authority facts.');
  }
}
function assertOwnedDeletedRecord(record: SavedResourceRecord, accountId: string,
  target: SavedResourceCommandInput['target']): void {
  if (record.accountId !== accountId || record.resourceType !== target.resourceType
      || record.resourceId !== target.resourceId || !(record.deletedAt instanceof Date)
      || !Number.isFinite(record.deletedAt.getTime()) || record.deletedAt.getTime() !== record.updatedAt.getTime()) {
    throw new SavedResourceError('invalid_saved_resource_input', 'Saved resource storage returned invalid deletion facts.');
  }
}
function unsaveProductResult(target: SavedResourceCommandInput['target']): ProductCommandResult {
  return { status: 204, body: Buffer.alloc(0), stableHeaders: { 'cache-control': 'private, no-store' },
    mediaType: 'application/json', contractVersion: SAVED_RESOURCE_CONTRACT_VERSION,
    targetIdentity: `${target.resourceType}:${target.resourceId}` };
}
function mapClaim(claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>): SavedResourceCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
