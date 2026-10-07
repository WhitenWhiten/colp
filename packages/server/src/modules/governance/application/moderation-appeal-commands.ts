import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';
import {
  CollectionPreconditionError,
  ifMatchSatisfied,
  strongEntityTag,
} from '../../collections/index.js';
import { governanceTimestamp, GovernanceModerationError } from '../domain/moderation.js';
import { hasOfficialWrite, nextGovernanceRevision } from '../domain/moderation-actions.js';
import {
  parseAppealDecision,
  parseAppealInput,
  toAppeal,
  type Appeal,
  type AppealDecisionInput,
  type AppealInput,
} from '../domain/moderation-appeals.js';
import { applyLoadedActionRevoke } from './moderation-action-commands.js';
import type {
  ModerationAppealRecord,
  ModerationCommandPorts,
} from './moderation-ports.js';

export const CREATE_MODERATION_APPEAL_OPERATION = 'createModerationAppeal';
export const DECIDE_MODERATION_APPEAL_OPERATION = 'decideModerationAppeal';
export const MODERATION_APPEAL_CONTRACT_VERSION = '1.0.0';

export type ModerationAppealCommandResult =
  | { readonly kind: 'written'; readonly status: 200 | 201; readonly view: Appeal }
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

export async function createModerationAppeal(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly body: AppealInput;
  },
): Promise<ModerationAppealCommandResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const action = await ports.store.getAction(input.body.actionId);
  if (!action) {
    throw new GovernanceModerationError('resource_not_found', 'action was not found', 'conceal');
  }
  if (!await ports.store.isAffectedOwner(input.actor.accountId, action.id)) {
    throw new GovernanceModerationError('resource_not_found', 'action was not found', 'conceal');
  }
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') return replay(claim);
  if (claim.kind !== 'claimed') return claim;
  if (action.state !== 'active') {
    throw new GovernanceModerationError('invalid_request', 'only an active action can be appealed');
  }
  const existing = await ports.store.findOpenAppeal(action.id);
  if (existing) {
    throw new GovernanceModerationError('revision_conflict', 'an open appeal already exists for this action');
  }
  const now = governanceTimestamp(await ports.clock.now());
  const record: ModerationAppealRecord = {
    id: ports.ids.nextAppealId(),
    actionId: action.id,
    appellantAccountId: input.actor.accountId,
    description: input.body.description,
    status: 'submitted',
    resolution: null,
    revision: '1',
    createdAt: now,
    updatedAt: now,
    decidedByAccountId: null,
  };
  const inserted = await ports.store.insertAppeal(record);
  if (inserted === 'duplicate_open') {
    throw new GovernanceModerationError('revision_conflict', 'an open appeal already exists for this action');
  }
  await ports.audit.append({
    principalId: input.actor.principalId,
    eventType: 'moderation.appeal.created',
    details: { appealId: record.id, actionId: action.id },
  });
  const view = toAppeal(record);
  await completeAppealReceipt(ports.receipts, binding, input.fingerprint, 201, view);
  return { kind: 'written', status: 201, view };
}

export async function decideModerationAppeal(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly appealId: string;
    readonly ifMatch: string;
    readonly body: AppealDecisionInput;
  },
): Promise<ModerationAppealCommandResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const roles = await ports.roles.getRoles(input.actor.accountId);
  if (!hasOfficialWrite(roles)) {
    throw new GovernanceModerationError(
      'insufficient_permission',
      'official moderator role is required',
      'deny',
    );
  }
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const current = await ports.store.getAppeal(input.appealId);
  if (!current) {
    throw new GovernanceModerationError('resource_not_found', 'appeal was not found', 'conceal');
  }
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') return replay(claim);
  if (claim.kind !== 'claimed') return claim;
  if (!ifMatchSatisfied(input.ifMatch, current.revision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  if (current.status !== 'submitted') {
    throw new GovernanceModerationError('revision_conflict', 'appeal already has a final decision');
  }
  const nowDate = await ports.clock.now();
  const now = governanceTimestamp(nowDate);
  const updated: ModerationAppealRecord = {
    ...current,
    status: input.body.decision === 'uphold' ? 'upheld' : 'rejected',
    resolution: input.body.resolution,
    revision: nextGovernanceRevision(current.revision),
    updatedAt: now,
    decidedByAccountId: input.actor.accountId,
  };
  const wrote = await ports.store.updateAppeal(updated, current.revision);
  if (!wrote) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  if (input.body.decision === 'uphold') {
    const action = await ports.store.getAction(current.actionId);
    if (action && action.state === 'active') {
      await applyLoadedActionRevoke(ports, {
        actor: input.actor,
        current: action,
        reason: input.body.resolution,
        nowDate,
      });
    }
  }
  await ports.audit.append({
    principalId: input.actor.principalId,
    eventType: 'moderation.appeal.decided',
    details: {
      appealId: current.id,
      actionId: current.actionId,
      decision: input.body.decision,
    },
  });
  const view = toAppeal(updated);
  await completeAppealReceipt(ports.receipts, binding, input.fingerprint, 200, view);
  return { kind: 'written', status: 200, view };
}

export { parseAppealDecision, parseAppealInput };

function replay(
  claim: Extract<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'replay' }>,
): Extract<ModerationAppealCommandResult, { kind: 'replay' }> {
  return {
    kind: 'replay',
    status: claim.result.status,
    body: claim.result.body,
    stableHeaders: claim.result.stableHeaders,
    mediaType: claim.result.mediaType,
  };
}

async function completeAppealReceipt(
  receipts: ProductCommandReceiptPort,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  status: 200 | 201,
  view: Appeal,
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
    contractVersion: MODERATION_APPEAL_CONTRACT_VERSION,
    targetIdentity: view.id,
  });
}
