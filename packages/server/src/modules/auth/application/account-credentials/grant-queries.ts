import { AccountCredentialCommandError } from './errors.js';
import { AccountCredentialCursorError } from './cursor.js';
import { grantEtag, toGrantDto } from './grant-dto.js';
import type { CredentialGrantCursorCodec } from './grant-cursor.js';
import { currentMachineBinding, loadActiveChildSnapshot, storedBindingMatches } from './grant-plan.js';
import type {
  CredentialGrantCommandPorts,
  CredentialGrantDto,
  CredentialGrantListFilters,
  CredentialGrantPageDto,
  CredentialGrantRecord,
  CredentialPlanViewDto,
} from './grant-types.js';
import { ACCOUNT_CREDENTIAL_PAGE_BYTE_BUDGET } from './types.js';

export async function getOwnedGrant(
  ports: CredentialGrantCommandPorts,
  input: { readonly ownerAccountId: string; readonly grantId: string },
): Promise<{ readonly grant: CredentialGrantDto; readonly etag: string }> {
  const record = await ports.grants.findById(input.grantId);
  if (!record || record.ownerAccountId !== input.ownerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  const now = await ports.clock.now();
  return { grant: toGrantDto(record, now), etag: grantEtag(record) };
}

export async function listOwnedGrants(
  ports: CredentialGrantCommandPorts & { readonly grantCursors: CredentialGrantCursorCodec },
  input: { readonly ownerAccountId: string; readonly filters: CredentialGrantListFilters },
): Promise<CredentialGrantPageDto> {
  const now = await ports.clock.now();
  const after = input.filters.cursor
    ? decodeGrantCursor(ports.grantCursors, input.filters.cursor, now, {
      viewer: input.ownerAccountId,
      credentialId: input.filters.credentialId,
    })
    : undefined;
  const matched: CredentialGrantRecord[] = [];
  let cursor = after;
  const batch = Math.max(input.filters.limit + 1, 32);
  while (matched.length <= input.filters.limit) {
    const rows = await ports.grants.listOwned({
      ownerAccountId: input.ownerAccountId,
      credentialId: input.filters.credentialId,
      after: cursor,
      limit: batch,
    });
    if (rows.length === 0) break;
    matched.push(...rows);
    if (rows.length < batch) break;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (matched.length > input.filters.limit) break;
  }
  const items: CredentialGrantDto[] = [];
  const included: CredentialGrantRecord[] = [];
  for (const row of matched) {
    if (included.length >= input.filters.limit) break;
    const dto = toGrantDto(row, now);
    const candidateCursor = ports.grantCursors.sign({
      viewer: input.ownerAccountId,
      credentialId: input.filters.credentialId ?? null,
      afterCreatedAt: row.createdAt.toISOString(),
      afterId: row.id,
      issuedAt: now.toISOString(),
    }, now);
    const serialized = Buffer.byteLength(JSON.stringify({
      items: [...items, dto],
      nextCursor: candidateCursor,
    }), 'utf8');
    if (serialized > ACCOUNT_CREDENTIAL_PAGE_BYTE_BUDGET) break;
    items.push(dto);
    included.push(row);
  }
  const last = included[included.length - 1];
  const nextCursor = last && included.length < matched.length
    ? ports.grantCursors.sign({
      viewer: input.ownerAccountId,
      credentialId: input.filters.credentialId ?? null,
      afterCreatedAt: last.createdAt.toISOString(),
      afterId: last.id,
      issuedAt: now.toISOString(),
    }, now)
    : null;
  return { items, nextCursor };
}

export async function getCredentialPlanView(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly accountId: string;
    readonly planKind: 'collection' | 'report';
    readonly planId: string;
  },
): Promise<CredentialPlanViewDto> {
  const plan = await ports.plans.getPlan(input.planKind, input.planId);
  if (!plan || plan.binding.principalId !== input.accountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential plan was not found.');
  }
  const credential = await ports.credentials.findByMcpClientId(plan.binding.clientId);
  if (!credential || credential.kind !== 'child' || credential.accountId !== input.accountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential plan was not found.');
  }
  if (!await ports.plans.verifyDigest(plan)) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential plan was not found.');
  }
  const snapshot = await loadActiveChildSnapshot(ports, credential.id);
  const current = snapshot
    ? await currentMachineBinding(ports, snapshot, plan.binding.resourceAudience)
    : null;
  const now = await ports.clock.now();
  return {
    planKind: plan.planKind,
    planId: plan.planId,
    credentialId: credential.id,
    planDigest: plan.operationsDigest,
    status: projectPlanStatus(plan, now),
    bindingCurrent: current !== null && storedBindingMatches(plan.binding, current),
    requiredScopes: Object.freeze([...plan.requiredScopes]),
    expiresAt: plan.expiresAt,
  };
}

function decodeGrantCursor(
  codec: CredentialGrantCursorCodec,
  token: string,
  now: Date,
  binding: { readonly viewer: string; readonly credentialId?: string },
): { readonly createdAt: Date; readonly id: string } {
  try {
    const payload = codec.verify(token, now, binding);
    return { createdAt: new Date(payload.afterCreatedAt), id: payload.afterId };
  } catch (error) {
    if (error instanceof AccountCredentialCursorError) throw error;
    throw new AccountCredentialCursorError('invalid_cursor');
  }
}

function projectPlanStatus(plan: {
  readonly planKind: 'collection' | 'report';
  readonly status: string;
  readonly approvalStatus: string | null;
  readonly expiresAt: string;
}, now: Date): CredentialPlanViewDto['status'] {
  if (plan.status === 'consumed' || plan.status === 'committed') return 'committed';
  if (plan.status === 'committing') return 'committing';
  if (plan.status === 'cancelled') return 'cancelled';
  if (plan.status === 'expired' || Date.parse(plan.expiresAt) <= now.getTime()) return 'expired';
  if (plan.planKind === 'report' && plan.status === 'pending' && plan.approvalStatus === 'approved') {
    return 'approved';
  }
  if (plan.status === 'approved') return 'approved';
  return 'pending';
}
