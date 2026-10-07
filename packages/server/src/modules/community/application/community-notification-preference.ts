/**
 * CS-05 community reply notifications: putCommunityNotificationPreference
 * — PUT /api/v1/me/community-notification-preferences.
 *
 * One `notification_preferences` row per recipient for channel
 * 'community'. The absent row is the virtual default (`enabled=true`,
 * revision '1', `updatedAt` = the recipient account creation stamp); the
 * first successful CAS stores revision 2. The independent preference ETag
 * compares verbatim in If-Match — a stale tag is 412 precondition_failed
 * with the current tag attached. Disabling the preference suppresses new
 * deliveries (worker preference gate) AND conceals the inbox; re-enabling
 * restores the durable rows.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import {
  COMMUNITY_NOTIFICATION_PREFERENCE_FIRST_REVISION,
  COMMUNITY_NOTIFICATION_PREFERENCE_PRECONDITION_MESSAGE,
  COMMUNITY_NOTIFICATION_PREFERENCE_VIRTUAL_REVISION,
  communityNotificationPreferenceView,
  type CommunityNotificationPreference,
} from './community-notification.js';
import {
  COMMUNITY_NOTIFICATION_CONTRACT_VERSION,
  COMMUNITY_NOTIFICATION_PREFERENCE_SCOPE,
  communityNotificationConcealed,
  communityNotificationInvalidRequest,
  communityNotificationPreconditionFailed,
  communityNotificationResult,
  mapCommunityNotificationClaim,
  validateCommunityNotificationActor,
  validateCommunityNotificationCommandId,
  validateCommunityNotificationIfMatch,
  type CommunityNotificationActor,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationCommandResult,
} from './community-notification-command.js';

/** Normalized PutCommunityNotificationPreference body {enabled}. */
export interface CommunityNotificationPreferenceWrite {
  readonly enabled: boolean;
}

export interface CommunityNotificationPreferenceInput {
  readonly actor: CommunityNotificationActor;
  readonly enabled: unknown;
  readonly ifMatch: unknown;
  readonly commandId: string;
}

/**
 * Parse the closed PutCommunityNotificationPreference object {enabled}.
 * Unknown keys reject; `enabled` must be a literal boolean; null is never
 * equivalent to missing.
 */
export function parseCommunityNotificationPreferenceBody(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw communityNotificationInvalidRequest(
      'The community notification preference body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'enabled') {
    throw communityNotificationInvalidRequest(
      'The community notification preference body is invalid.');
  }
  if (typeof record.enabled !== 'boolean') {
    throw communityNotificationInvalidRequest(
      'The community notification preference enabled flag is invalid.');
  }
  return record.enabled;
}

export function communityNotificationPreferenceFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly enabled: boolean;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    enabled: input.enabled,
    contractVersion: COMMUNITY_NOTIFICATION_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

/**
 * Write the community preference: the If-Match tag must equal the current
 * preference ETag (the virtual tag before any write); the stored revision
 * increments the compared one (virtual '1' → first row 2). Every write
 * appends an immutable audit event.
 */
export async function putCommunityNotificationPreference(
  ports: CommunityNotificationCommandPorts,
  input: CommunityNotificationPreferenceInput,
): Promise<CommunityNotificationCommandResult<CommunityNotificationPreference>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw communityNotificationInvalidRequest('Community notification command input is required.');
  }
  validateCommunityNotificationActor(input.actor);
  const enabled = parseCommunityNotificationPreferenceBody({ enabled: input.enabled });
  const ifMatch = validateCommunityNotificationIfMatch(input.ifMatch);
  const commandId = validateCommunityNotificationCommandId(input.commandId);
  const fingerprint = communityNotificationPreferenceFingerprint({
    actorPrincipalId: input.actor.principalId, enabled,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_NOTIFICATION_PREFERENCE_SCOPE,
    commandId,
  };
  const account = await ports.actor.lockActiveAccount(input.actor.principalId);
  if (account === null || account.subjectId !== input.actor.subjectId) {
    throw communityNotificationConcealed();
  }
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapCommunityNotificationClaim(claim);
  const existing = await ports.preferences.lockCommunity(input.actor.principalId);
  const currentRevision = existing === null
    ? COMMUNITY_NOTIFICATION_PREFERENCE_VIRTUAL_REVISION
    : existing.revision.toString();
  const currentEtag = ports.etags.preference({
    recipientAccountId: input.actor.principalId,
    revision: currentRevision,
  });
  if (ifMatch !== currentEtag) {
    throw communityNotificationPreconditionFailed(
      COMMUNITY_NOTIFICATION_PREFERENCE_PRECONDITION_MESSAGE, currentEtag);
  }
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw communityNotificationInvalidRequest('The command clock returned invalid time.');
  }
  const stored = existing === null
    ? await ports.preferences.insertCommunity(input.actor.principalId, {
      enabled,
      revision: COMMUNITY_NOTIFICATION_PREFERENCE_FIRST_REVISION,
      updatedAt: now,
    })
    : await ports.preferences.updateCommunity(
      input.actor.principalId, enabled, existing.revision, now,
    );
  if (stored === null) {
    throw communityNotificationPreconditionFailed(
      COMMUNITY_NOTIFICATION_PREFERENCE_PRECONDITION_MESSAGE, currentEtag);
  }
  await ports.audit.append({
    eventType: 'community.notification_preference_updated',
    principalId: input.actor.principalId,
    details: {
      channel: 'community',
      enabled,
      revision: stored.revision.toString(),
    },
    createdAt: now,
  });
  const preference = communityNotificationPreferenceView(stored);
  await ports.receipts.complete(binding, fingerprint,
    communityNotificationResult(preference, ports.etags.preference({
      recipientAccountId: input.actor.principalId,
      revision: preference.revision,
    })));
  return { kind: 'succeeded', value: preference };
}
