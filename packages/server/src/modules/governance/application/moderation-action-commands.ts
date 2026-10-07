import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';
import {
  CollectionPreconditionError,
  ifMatchSatisfied,
  strongEntityTag,
} from '../../collections/index.js';
import { governanceTimestamp, GovernanceModerationError, parseOpaqueId } from '../domain/moderation.js';
import {
  hasOfficialWrite,
  isEnabledActionPair,
  parseActionInput,
  parseRevokeReason,
  targetsMatch,
  toAction,
  nextGovernanceRevision,
  type Action,
  type ActionInput,
} from '../domain/moderation-actions.js';
import type {
  ModerationActionRecord,
  ModerationCommandPorts,
} from './moderation-ports.js';

export const CREATE_MODERATION_ACTION_OPERATION = 'createModerationAction';
export const REVOKE_MODERATION_ACTION_OPERATION = 'revokeModerationAction';
export const MODERATION_ACTION_CONTRACT_VERSION = '1.0.0';

export type ModerationActionCommandResult =
  | { readonly kind: 'written'; readonly status: 200 | 201; readonly view: Action }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export async function createModerationAction(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly body: ActionInput;
  },
): Promise<ModerationActionCommandResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  await requireModerator(ports, input.actor.accountId);
  if (!isEnabledActionPair(input.body.target, input.body.action)) {
    throw new GovernanceModerationError('invalid_request', 'action target pair is not enabled');
  }
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const caseRecord = await ports.store.getCase(input.body.caseId);
  if (!caseRecord) {
    throw new GovernanceModerationError('resource_not_found', 'case was not found', 'conceal');
  }
  if (!targetsMatch(caseRecord.target, input.body.target)) {
    throw new GovernanceModerationError('invalid_request', 'action target must match the case target');
  }
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') return replay(claim);
  if (claim.kind !== 'claimed') return claim;
  const nowDate = await ports.clock.now();
  const now = governanceTimestamp(nowDate);
  const actionId = ports.ids.nextActionId();
  // Snapshot the affected owner at creation time so appeal rights stay with
  // the account that owned the target when the action was decided, even if
  // the parent resource is later deleted or transferred.
  const ownerAccountId = await ports.store.actionOwnerAccountId(input.body.target);
  const record: ModerationActionRecord = {
    id: actionId,
    caseId: caseRecord.id,
    target: input.body.target,
    targetFingerprint: caseRecord.targetFingerprint,
    action: input.body.action,
    reason: input.body.reason,
    actorAccountId: input.actor.accountId,
    state: 'active',
    revision: '1',
    createdAt: now,
    revokedAt: null,
    revokeReason: null,
    revokedByAccountId: null,
    ownerAccountId,
  };
  await ports.store.insertAction(record);
  await ports.audit.append({
    principalId: input.actor.principalId,
    eventType: 'moderation.action.created',
    details: {
      actionId,
      caseId: caseRecord.id,
      action: record.action,
      targetKind: record.target.kind,
      targetId: record.target.id,
    },
  });
  if ((record.action === 'delist' || record.action === 'hide_public')
    && (record.target.kind === 'collection' || record.target.kind === 'bookmark'
      || record.target.kind === 'digest_series' || record.target.kind === 'digest_edition')) {
    await appendControlOutbox(ports, record, actionId, nowDate, 'active');
  }
  if ((record.action === 'restrict_interaction' || record.action === 'restrict_publication')
    && record.target.kind === 'account') {
    await appendControlOutbox(ports, record, actionId, nowDate, 'active');
  }
  const view = toAction(record);
  await completeActionReceipt(ports.receipts, binding, input.fingerprint, 201, view);
  return { kind: 'written', status: 201, view };
}

export async function revokeModerationAction(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly actionId: string;
    readonly ifMatch: string;
    readonly reason: string;
  },
): Promise<ModerationActionCommandResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const actionId = parseOpaqueId(input.actionId, 'actionId');
  await requireModerator(ports, input.actor.accountId);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const current = await ports.store.getAction(actionId);
  if (!current) {
    throw new GovernanceModerationError('resource_not_found', 'action was not found', 'conceal');
  }
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') return replay(claim);
  if (claim.kind !== 'claimed') return claim;
  if (!ifMatchSatisfied(input.ifMatch, current.revision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  if (current.state === 'revoked') {
    throw new GovernanceModerationError('invalid_request', 'action is already revoked');
  }
  const nowDate = await ports.clock.now();
  const updated = await applyLoadedActionRevoke(ports, {
    actor: input.actor,
    current,
    reason: input.reason,
    nowDate,
  });
  const view = toAction(updated);
  await completeActionReceipt(ports.receipts, binding, input.fingerprint, 200, view);
  return { kind: 'written', status: 200, view };
}

export async function applyLoadedActionRevoke(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly current: ModerationActionRecord;
    readonly reason: string;
    readonly nowDate: Date;
  },
): Promise<ModerationActionRecord> {
  const now = governanceTimestamp(input.nowDate);
  const updated: ModerationActionRecord = {
    ...input.current,
    state: 'revoked',
    revision: nextGovernanceRevision(input.current.revision),
    revokedAt: now,
    revokeReason: input.reason,
    revokedByAccountId: input.actor.accountId,
  };
  const wrote = await ports.store.updateAction(updated, input.current.revision);
  if (!wrote) {
    const latest = await ports.store.getAction(input.current.id);
    if (latest?.state === 'revoked') return latest;
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(input.current.revision) });
  }
  await ports.audit.append({
    principalId: input.actor.principalId,
    eventType: 'moderation.action.revoked',
    details: {
      actionId: input.current.id,
      caseId: input.current.caseId,
      action: input.current.action,
      targetKind: input.current.target.kind,
      targetId: input.current.target.id,
    },
  });
  if ((input.current.action === 'delist' || input.current.action === 'hide_public')
    && (input.current.target.kind === 'collection' || input.current.target.kind === 'bookmark'
      || input.current.target.kind === 'digest_series' || input.current.target.kind === 'digest_edition')) {
    await appendControlOutbox(ports, input.current, input.current.id, input.nowDate, 'revoked');
  }
  if ((input.current.action === 'restrict_interaction' || input.current.action === 'restrict_publication')
    && input.current.target.kind === 'account') {
    await appendControlOutbox(ports, input.current, input.current.id, input.nowDate, 'revoked');
  }
  return updated;
}

export { parseActionInput, parseRevokeReason };

async function appendControlOutbox(
  ports: ModerationCommandPorts,
  record: ModerationActionRecord,
  actionId: string,
  occurredAt: Date,
  state: 'active' | 'revoked',
): Promise<void> {
  if (record.target.kind === 'collection') {
    const publicationSlug = await ports.store.collectionPublicationSlug(record.target.id);
    await ports.outbox.appendCollectionControl({
      outboxId: ports.ids.nextOutboxId(),
      eventId: ports.ids.nextEventId(),
      collectionId: record.target.id,
      actionId,
      action: record.action as 'delist' | 'hide_public',
      state,
      publicationSlug,
      occurredAt,
    });
    return;
  }
  if (record.target.kind === 'bookmark') {
    const publicationSlug = await ports.store.collectionPublicationSlug(record.target.collectionId);
    const faviconObjectId = await ports.store.bookmarkFaviconObjectId(
      record.target.collectionId,
      record.target.id,
    );
    await ports.outbox.appendBookmarkControl({
      outboxId: ports.ids.nextOutboxId(),
      eventId: ports.ids.nextEventId(),
      collectionId: record.target.collectionId,
      nodeId: record.target.id,
      actionId,
      action: record.action as 'delist' | 'hide_public',
      state,
      publicationSlug,
      faviconObjectId,
      occurredAt,
    });
    return;
  }
  if (record.target.kind === 'digest_series' || record.target.kind === 'digest_edition') {
    const seriesId = record.target.kind === 'digest_edition' ? record.target.seriesId : record.target.id;
    const seriesSlug = await ports.store.digestSeriesSlug(seriesId);
    await ports.outbox.appendDigestControl({
      outboxId: ports.ids.nextOutboxId(),
      eventId: ports.ids.nextEventId(),
      seriesId,
      editionId: record.target.kind === 'digest_edition' ? record.target.id : null,
      actionId,
      action: record.action as 'delist' | 'hide_public',
      state,
      seriesSlug,
      occurredAt,
    });
    return;
  }
  if (record.target.kind !== 'account') return;
  const locator = await ports.store.accountPublicLocator(record.target.id);
  await ports.outbox.appendAccountControl({
    outboxId: ports.ids.nextOutboxId(),
    eventId: ports.ids.nextEventId(),
    accountId: record.target.id,
    actionId,
    action: record.action as 'restrict_interaction' | 'restrict_publication',
    state,
    handle: locator.handle,
    avatarObjectId: locator.avatarObjectId,
    occurredAt,
  });
}

async function requireModerator(ports: ModerationCommandPorts, accountId: string): Promise<void> {
  const roles = await ports.roles.getRoles(accountId);
  if (!hasOfficialWrite(roles)) {
    throw new GovernanceModerationError(
      'insufficient_permission',
      'official moderator role is required',
      'deny',
    );
  }
}

function replay(
  claim: Extract<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'replay' }>,
): Extract<ModerationActionCommandResult, { kind: 'replay' }> {
  return {
    kind: 'replay',
    status: claim.result.status,
    body: claim.result.body,
    stableHeaders: claim.result.stableHeaders,
    mediaType: claim.result.mediaType,
  };
}

async function completeActionReceipt(
  receipts: ProductCommandReceiptPort,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  status: 200 | 201,
  view: Action,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(view));
  await receipts.complete(binding, fingerprint, {
    status,
    body,
    stableHeaders: {
      etag: strongEntityTag(view.revision),
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: MODERATION_ACTION_CONTRACT_VERSION,
    targetIdentity: view.id,
  });
}
