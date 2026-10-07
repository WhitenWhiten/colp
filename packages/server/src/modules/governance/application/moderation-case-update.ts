import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';
import {
  CollectionPreconditionError,
  ifMatchSatisfied,
  strongEntityTag,
} from '../../collections/index.js';
import { governanceTimestamp, GovernanceModerationError } from '../domain/moderation.js';
import {
  applyCaseStatusTransition,
  hasOfficialWrite,
  parseCasePatch,
  requireClosingResolution,
  nextGovernanceRevision,
  type CasePatch,
} from '../domain/moderation-actions.js';
import {
  toOfficialCase,
  type ModerationCaseRecord,
  type ModerationCommandPorts,
} from './moderation-ports.js';
import type { OfficialCase } from '../domain/moderation.js';

export const UPDATE_MODERATION_CASE_OPERATION = 'updateModerationCase';
export const MODERATION_CASE_CONTRACT_VERSION = '1.0.0';

export type UpdateModerationCaseResult =
  | { readonly kind: 'updated'; readonly status: 200; readonly view: OfficialCase }
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

export async function updateModerationCase(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly caseId: string;
    readonly ifMatch: string;
    readonly patch: CasePatch;
  },
): Promise<UpdateModerationCaseResult> {
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
  const current = await ports.store.getCase(input.caseId);
  if (!current) {
    throw new GovernanceModerationError('resource_not_found', 'case was not found', 'conceal');
  }
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind !== 'claimed') return claim;
  if (!ifMatchSatisfied(input.ifMatch, current.revision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  const nextStatus = applyCaseStatusTransition(current.status, input.patch.status);
  const publicResolution = input.patch.publicResolution === undefined
    ? current.publicResolution
    : input.patch.publicResolution;
  requireClosingResolution(nextStatus, publicResolution);
  let assignedToAccountId = input.patch.assignedToAccountId === undefined
    ? current.assignedToAccountId
    : input.patch.assignedToAccountId;
  if (assignedToAccountId !== null) {
    const assigneeRoles = await ports.roles.getRoles(assignedToAccountId);
    if (!assigneeRoles.has('reviewer') && !assigneeRoles.has('moderator')) {
      throw new GovernanceModerationError('invalid_request', 'assignee must have an official role');
    }
  }
  const now = governanceTimestamp(await ports.clock.now());
  const updated: ModerationCaseRecord = {
    ...current,
    status: nextStatus,
    publicResolution,
    assignedToAccountId,
    internalNote: input.patch.internalNote === undefined
      ? current.internalNote
      : input.patch.internalNote,
    revision: nextGovernanceRevision(current.revision),
    updatedAt: now,
  };
  const wrote = await ports.store.updateCase(updated, current.revision);
  if (!wrote) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  await ports.audit.append({
    principalId: input.actor.principalId,
    eventType: 'moderation.case.updated',
    details: {
      caseId: current.id,
      status: updated.status,
      assignedToAccountId: updated.assignedToAccountId,
    },
  });
  const view = toOfficialCase(updated);
  await completeCaseReceipt(ports.receipts, binding, input.fingerprint, view);
  return { kind: 'updated', status: 200, view };
}

export { parseCasePatch };

async function completeCaseReceipt(
  receipts: ProductCommandReceiptPort,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  view: OfficialCase,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(view));
  await receipts.complete(binding, fingerprint, {
    status: 200,
    body,
    stableHeaders: {
      etag: strongEntityTag(view.case.revision),
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: MODERATION_CASE_CONTRACT_VERSION,
    targetIdentity: view.case.id,
  });
}
