import { createHash } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../../commands/index.js';
import { AccountCredentialCommandError } from './errors.js';
import { effectiveCredentialState } from './dto.js';
import { ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION } from './types.js';
import { effectiveGrantState, grantEtag, toGrantDto } from './grant-dto.js';
import {
  currentMachineBinding,
  grantMatchesPlan,
  loadActiveChildSnapshot,
  storedBindingMatches,
} from './grant-plan.js';
import type { AccountCredentialCommandOutcome } from './commands.js';
import type {
  CredentialGrantCommandPorts,
  CredentialGrantDto,
  CredentialGrantInput,
  CredentialGrantRecord,
  PlanAuthorizationDto,
  StoredCredentialPlan,
} from './grant-types.js';
import { ACCOUNT_CREDENTIAL_GRANT_MAX_EXPIRY_MS } from './grant-types.js';

const CREATE_SCOPE = 'auth:account-credential-grant:create:v1';
const REVOKE_SCOPE = 'auth:account-credential-grant:revoke:v1';
const AUTHORIZE_SCOPE = 'auth:account-credential-grant:authorize-plan:v1';
const JSON_TYPE = 'application/json; charset=utf-8';

export async function createCredentialGrant(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly ownerAccountId: string;
    readonly ownerSubjectId: string;
    readonly commandId: string;
    readonly body: CredentialGrantInput;
  },
): Promise<AccountCredentialCommandOutcome<CredentialGrantDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: 'createCredentialGrant',
    ownerAccountId: input.ownerAccountId,
    body: input.body,
  });
  return execute(ports, {
    principalId: input.ownerAccountId,
    commandScope: CREATE_SCOPE,
    commandId,
    fingerprint,
    status: 201,
    write: async (now) => {
      const credential = await ports.credentials.lockById(input.body.credentialId);
      if (!credential || credential.kind !== 'child' || credential.accountId !== input.ownerAccountId) {
        throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
      }
      if (effectiveCredentialState(credential, now) !== 'active') {
        throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
      }
      assertGrantExpiry(input.body.expiresAt, now, credential.expiresAt);
      const owned = input.body.resource.kind === 'collection'
        ? await ports.resources.collectionOwnedBy(input.body.resource.id, input.ownerSubjectId)
        : await ports.resources.reportOwnedBy(input.body.resource.id, input.ownerSubjectId);
      if (!owned) {
        throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
      }
      const record: CredentialGrantRecord = {
        id: ports.ids.nextGrantId(),
        credentialId: credential.id,
        ownerAccountId: input.ownerAccountId,
        resource: { kind: input.body.resource.kind, id: input.body.resource.id },
        actions: Object.freeze([...input.body.actions]),
        state: 'active',
        revision: 1n,
        expiresAt: new Date(input.body.expiresAt),
        createdAt: now,
        revokedAt: null,
        revokeReason: null,
      };
      await ports.grants.insert(record);
      return record;
    },
  });
}

export async function revokeCredentialGrant(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly ownerAccountId: string;
    readonly grantId: string;
    readonly commandId: string;
    readonly ifMatch: string | undefined;
    readonly reason: string;
  },
): Promise<AccountCredentialCommandOutcome<CredentialGrantDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: 'revokeCredentialGrant',
    ownerAccountId: input.ownerAccountId,
    grantId: input.grantId,
    ifMatch: input.ifMatch ?? null,
    reason: input.reason,
  });
  const visible = await ports.grants.lockById(input.grantId);
  if (!visible || visible.ownerAccountId !== input.ownerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  return execute(ports, {
    principalId: input.ownerAccountId,
    commandScope: REVOKE_SCOPE,
    commandId,
    fingerprint,
    status: 200,
    ifMatch: input.ifMatch,
    current: visible,
    write: async (now) => {
      if (visible.state === 'revoked') return visible;
      const updated = await ports.grants.revoke({
        id: visible.id,
        expectedRevision: visible.revision,
        reason: input.reason,
        revokedAt: now,
        revision: visible.revision + 1n,
      });
      if (!updated) {
        throw new AccountCredentialCommandError(
          'precondition_failed',
          'The resource ETag does not match the current representation.',
          grantEtag(visible),
        );
      }
      return updated;
    },
  });
}

export async function authorizePlanWithCredentialGrant(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly ownerAccountId: string;
    readonly grantId: string;
    readonly commandId: string;
    readonly ifMatch: string | undefined;
    readonly planKind: 'collection' | 'report';
    readonly planId: string;
    readonly planDigest: string;
  },
): Promise<AccountCredentialCommandOutcome<PlanAuthorizationDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: 'authorizePlanWithCredentialGrant',
    ownerAccountId: input.ownerAccountId,
    grantId: input.grantId,
    ifMatch: input.ifMatch ?? null,
    planKind: input.planKind,
    planId: input.planId,
    planDigest: input.planDigest,
  });
  const grant = await ports.grants.lockById(input.grantId);
  if (!grant || grant.ownerAccountId !== input.ownerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  const binding = {
    principalId: input.ownerAccountId,
    commandScope: AUTHORIZE_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') return mapReplay(claim);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  assertIfMatch(input.ifMatch, grant);
  const now = await ports.clock.now();
  if (effectiveGrantState(grant, now) !== 'active') {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  const plan = await requireMatchingPlan(ports, grant, input);
  const existing = await ports.grants.findPlanAuthorization(input.planKind, input.planId);
  if (!existing) {
    try {
      await ports.plans.approvePlan(plan);
    } catch (error) {
      // AC-F010: a race can flip the plan between requireMatchingPlan and
      // approvePlan. The stores surface that denial with 'expired' /
      // 'approval_conflict'; translate it into the same semantic 4xx so the
      // client never sees a retryable 503 for a dead plan. Genuine store
      // failures (connectivity etc.) keep their original error.
      const code = error instanceof Error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code === 'expired' || code === 'approval_conflict') {
        throw new AccountCredentialCommandError('invalid_request', 'The credential plan is no longer authorizable.');
      }
      throw error;
    }
    await ports.grants.savePlanAuthorization({
      planKind: input.planKind,
      planId: input.planId,
      grantId: grant.id,
      grantRevision: grant.revision,
      credentialId: grant.credentialId,
      planDigest: plan.operationsDigest,
      authorizedAt: now,
    });
  } else if (existing.grantId !== grant.id || existing.planDigest !== plan.operationsDigest) {
    throw new AccountCredentialCommandError('invalid_request', 'The credential grant request is invalid.');
  }
  const body: PlanAuthorizationDto = {
    planId: plan.planId,
    grantId: grant.id,
    planKind: plan.planKind,
    planDigest: plan.operationsDigest,
    approved: true,
    expiresAt: plan.expiresAt,
  };
  const etag = grantEtag(grant);
  await complete(ports, binding, fingerprint, 200, body, etag);
  return { kind: 'succeeded', body, etag };
}

export async function assertGrantStillValidForPlan(
  ports: CredentialGrantCommandPorts,
  input: { readonly planKind: 'collection' | 'report'; readonly planId: string },
  options: { readonly lock?: boolean } = {},
): Promise<void> {
  const authorization = options.lock
    ? await ports.grants.lockPlanAuthorization(input.planKind, input.planId)
    : await ports.grants.findPlanAuthorization(input.planKind, input.planId);
  if (!authorization) return;
  const grant = options.lock
    ? await ports.grants.lockById(authorization.grantId)
    : await ports.grants.findById(authorization.grantId);
  const now = await ports.clock.now();
  if (!grant || grant.revision !== authorization.grantRevision || effectiveGrantState(grant, now) !== 'active') {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant is no longer valid.');
  }
  const plan = await ports.plans.getPlan(input.planKind, input.planId);
  if (!plan || plan.operationsDigest !== authorization.planDigest || !grantMatchesPlan(grant, plan)) {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant is no longer valid.');
  }
  const snapshot = await loadActiveChildSnapshot(ports, grant.credentialId);
  if (!snapshot) {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant is no longer valid.');
  }
  const current = await currentMachineBinding(ports, snapshot, plan.binding.resourceAudience);
  if (!storedBindingMatches(plan.binding, current)) {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant is no longer valid.');
  }
}

async function requireMatchingPlan(
  ports: CredentialGrantCommandPorts,
  grant: CredentialGrantRecord,
  input: {
    readonly ownerAccountId: string;
    readonly planKind: 'collection' | 'report';
    readonly planId: string;
    readonly planDigest: string;
  },
): Promise<StoredCredentialPlan> {
  const plan = await ports.plans.getPlan(input.planKind, input.planId);
  if (!plan || plan.binding.principalId !== input.ownerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential plan was not found.');
  }
  if (plan.operationsDigest !== input.planDigest || !await ports.plans.verifyDigest(plan)) {
    throw new AccountCredentialCommandError('invalid_request', 'The credential grant request is invalid.');
  }
  // AC-F010: authorize a plan only while it is still authorizable. The
  // downstream stores refuse consumed/committed/cancelled/expired plans;
  // failing here surfaces a semantic 4xx instead of a retryable 503 the
  // SDK would keep re-issuing as `same_request` against a dead plan.
  const now = await ports.clock.now();
  const expired = plan.status === 'expired' || Date.parse(plan.expiresAt) <= now.getTime();
  const authorizable = plan.status === 'pending'
    || (input.planKind === 'collection' && plan.status === 'approved');
  if (expired || !authorizable) {
    throw new AccountCredentialCommandError('invalid_request', 'The credential plan is no longer authorizable.');
  }
  const credential = await ports.credentials.findByMcpClientId(plan.binding.clientId);
  if (!credential || credential.id !== grant.credentialId || credential.accountId !== input.ownerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential plan was not found.');
  }
  if (!grantMatchesPlan(grant, plan)) {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant does not cover this plan.');
  }
  const snapshot = await loadActiveChildSnapshot(ports, grant.credentialId);
  if (!snapshot) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  const current = await currentMachineBinding(ports, snapshot, plan.binding.resourceAudience);
  if (!storedBindingMatches(plan.binding, current)) {
    throw new AccountCredentialCommandError('insufficient_permission', 'The credential grant does not cover this plan.');
  }
  return plan;
}

function assertGrantExpiry(expiresAt: string, now: Date, credentialExpiresAt: Date): void {
  const at = Date.parse(expiresAt);
  const delta = at - now.getTime();
  if (!Number.isFinite(at) || delta <= 0 || delta > ACCOUNT_CREDENTIAL_GRANT_MAX_EXPIRY_MS) {
    throw new AccountCredentialCommandError('invalid_request', 'Grant expiry is outside the allowed window.');
  }
  if (at > credentialExpiresAt.getTime()) {
    throw new AccountCredentialCommandError('invalid_request', 'Grant expiry cannot exceed the credential.');
  }
}

async function execute(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly principalId: string;
    readonly commandScope: string;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly status: number;
    readonly ifMatch?: string;
    readonly current?: CredentialGrantRecord;
    readonly write: (now: Date) => Promise<CredentialGrantRecord>;
  },
): Promise<AccountCredentialCommandOutcome<CredentialGrantDto>> {
  const binding = {
    principalId: input.principalId,
    commandScope: input.commandScope,
    commandId: input.commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') return mapReplay(claim);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  if (input.current) assertIfMatch(input.ifMatch, input.current);
  const now = await ports.clock.now();
  const record = await input.write(now);
  const body = toGrantDto(record, now);
  const etag = grantEtag(record);
  await complete(ports, binding, input.fingerprint, input.status, body, etag);
  return { kind: 'succeeded', body, etag };
}

function assertIfMatch(ifMatch: string | undefined, current: CredentialGrantRecord): void {
  if (ifMatch === undefined) {
    throw new AccountCredentialCommandError('precondition_required', 'If-Match is required for this operation.');
  }
  if (ifMatch !== grantEtag(current)) {
    throw new AccountCredentialCommandError(
      'precondition_failed',
      'The resource ETag does not match the current representation.',
      grantEtag(current),
    );
  }
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson({
    contractVersion: ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION,
    value,
  }), 'utf8').digest('hex');
}

async function complete(
  ports: CredentialGrantCommandPorts,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  status: number,
  body: unknown,
  etag: string,
): Promise<void> {
  await ports.receipts.complete(binding, fingerprint, {
    status,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': JSON_TYPE,
      etag,
    },
    mediaType: JSON_TYPE,
    contractVersion: ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION,
  } satisfies ProductCommandResult);
}

function mapReplay(claim: Extract<ProductCommandClaim, { kind: 'replay' }>): AccountCredentialCommandOutcome<never> {
  return {
    kind: 'replay',
    status: claim.result.status,
    body: claim.result.body,
    stableHeaders: claim.result.stableHeaders,
    mediaType: claim.result.mediaType,
  };
}

function mapClaim(claim: ProductCommandClaim): AccountCredentialCommandOutcome<never> {
  if (claim.kind === 'in_progress') return { kind: 'in_progress', retryAfterSeconds: claim.retryAfterSeconds };
  if (claim.kind === 'reused') return { kind: 'reused' };
  if (claim.kind === 'expired') return { kind: 'expired' };
  throw new Error('unexpected credential grant command claim');
}
