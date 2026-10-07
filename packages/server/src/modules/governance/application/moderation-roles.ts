import {
  GOVERNANCE_REASON_MAX,
  GovernanceModerationError,
  parseOpaqueId,
  type ModerationRole,
} from '../domain/moderation.js';
import type { ModerationRolePorts } from './moderation-ports.js';

export const MODERATION_ROLES_LIST = Object.freeze(['reviewer', 'moderator'] as const);

export interface ModerationRoleChangeResult {
  readonly accountId: string;
  readonly role: ModerationRole;
  readonly changed: boolean;
  readonly auditId: string | null;
}

export async function grantModerationRole(
  ports: ModerationRolePorts,
  input: {
    readonly accountId: string;
    readonly role: string;
    readonly reason: string;
    readonly actorPrincipalId?: string | null;
  },
): Promise<ModerationRoleChangeResult> {
  const parsed = parseRoleCommand(input);
  if (!await ports.roles.accountExists(parsed.accountId)) {
    throw new GovernanceModerationError('resource_not_found', 'account was not found', 'conceal');
  }
  const changed = await ports.roles.grant(parsed.accountId, parsed.role);
  if (!changed) {
    return { accountId: parsed.accountId, role: parsed.role, changed: false, auditId: null };
  }
  const auditId = await ports.audit.append({
    principalId: input.actorPrincipalId ?? null,
    eventType: 'moderation.role.granted',
    details: {
      accountId: parsed.accountId,
      role: parsed.role,
      reason: parsed.reason,
    },
  });
  return { accountId: parsed.accountId, role: parsed.role, changed: true, auditId };
}

export async function revokeModerationRole(
  ports: ModerationRolePorts,
  input: {
    readonly accountId: string;
    readonly role: string;
    readonly reason: string;
    readonly actorPrincipalId?: string | null;
  },
): Promise<ModerationRoleChangeResult> {
  const parsed = parseRoleCommand(input);
  if (!await ports.roles.accountExists(parsed.accountId)) {
    throw new GovernanceModerationError('resource_not_found', 'account was not found', 'conceal');
  }
  const changed = await ports.roles.revoke(parsed.accountId, parsed.role);
  if (!changed) {
    return { accountId: parsed.accountId, role: parsed.role, changed: false, auditId: null };
  }
  const auditId = await ports.audit.append({
    principalId: input.actorPrincipalId ?? null,
    eventType: 'moderation.role.revoked',
    details: {
      accountId: parsed.accountId,
      role: parsed.role,
      reason: parsed.reason,
    },
  });
  return { accountId: parsed.accountId, role: parsed.role, changed: true, auditId };
}

function parseRoleCommand(input: {
  readonly accountId: string;
  readonly role: string;
  readonly reason: string;
}): { readonly accountId: string; readonly role: ModerationRole; readonly reason: string } {
  const accountId = parseOpaqueId(input.accountId, 'accountId');
  if (input.role !== 'reviewer' && input.role !== 'moderator') {
    throw new GovernanceModerationError('invalid_request', 'role is invalid');
  }
  if (typeof input.reason !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  const reason = input.reason.trim().normalize('NFC');
  const length = [...reason].length;
  if (length < 1 || length > GOVERNANCE_REASON_MAX) {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  return { accountId, role: input.role, reason };
}
