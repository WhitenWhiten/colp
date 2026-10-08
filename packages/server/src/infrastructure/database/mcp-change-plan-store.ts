import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  OperationResult,
  ScopeName,
} from '@know-n/colp/types';
import type { DatabaseSchema } from './runtime.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
} from './unit-of-work.js';

/**
 * MCP-W02 PostgreSQL adapter for session-free Change Plan, Approval, and
 * first Commit receipt authority.
 *
 * The public COLP ports are host-owned interfaces in `colp/src/mcp/change-plan.ts`;
 * this adapter exposes the same structural port shapes while adding transaction-bound
 * variants for the COLP commit coordinator. Every input and persisted binding is
 * token-free and must not contain any MCP Session field.
 */

export type PostgresMcpStoredPlan = Readonly<{
  readonly planId: string;
  readonly expiresAt: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly requiresApproval: boolean;
  readonly approvalMethod?: string;
  readonly approvalUri?: string;
  readonly summary: string;
  readonly impact: ChangePlanImpact;
  readonly requiredScopes: readonly ScopeName[];
  readonly baseRevisions: Readonly<Record<string, string>>;
  readonly operations: readonly ChangePlanOperation[];
  readonly operationsDigest: string;
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** Untrusted model/user note. Never interpolate into approval summary text. */
  readonly untrustedNote: string;
  readonly createdAt: string;
  readonly status: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired';
}>;

export type PostgresMcpPlanCommitResult = Readonly<{
  readonly planId: string;
  readonly committedAt: string;
  readonly operations: readonly OperationResult[];
}>;

export type PostgresMcpApprovalBeginResult =
  | { readonly status: 'ready' }
  | { readonly status: 'already_consumed'; readonly firstResult: PostgresMcpPlanCommitResult }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'missing'
        | 'binding_mismatch'
        | 'digest_mismatch'
        | 'concurrent_lost'
        | 'expired'
        | 'plan_cancelled';
    };

export interface PostgresMcpChangePlanStorePort {
  readonly save: (plan: PostgresMcpStoredPlan) => void | PromiseLike<void>;
  readonly get: (
    planId: string,
  ) => PostgresMcpStoredPlan | undefined | PromiseLike<PostgresMcpStoredPlan | undefined>;
  readonly update: (plan: PostgresMcpStoredPlan) => void | PromiseLike<void>;
}

export interface PostgresMcpApprovalStorePort {
  readonly markApproved: (
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => void | PromiseLike<void>;
  readonly beginCommit: (
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
      idempotencyKey: string;
    }>,
  ) => PostgresMcpApprovalBeginResult | PromiseLike<PostgresMcpApprovalBeginResult>;
  readonly finalizeCommit: (
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
      result: PostgresMcpPlanCommitResult;
    }>,
  ) => void | PromiseLike<void>;
  readonly abortCommit: (
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
    }>,
  ) => void | PromiseLike<void>;
}

export interface PostgresMcpChangePlanCommitPlanStorePort {
  readonly lock: (
    transaction: DatabaseTransaction,
    planId: string,
  ) => PostgresMcpStoredPlan | undefined | PromiseLike<PostgresMcpStoredPlan | undefined>;
  readonly update: (
    transaction: DatabaseTransaction,
    plan: PostgresMcpStoredPlan,
  ) => void | PromiseLike<void>;
}

export interface PostgresMcpChangePlanCommitApprovalStorePort {
  readonly markApproved: (
    transaction: DatabaseTransaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => void | PromiseLike<void>;
  readonly beginCommit: (
    transaction: DatabaseTransaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
      idempotencyKey: string;
    }>,
  ) => PostgresMcpApprovalBeginResult | PromiseLike<PostgresMcpApprovalBeginResult>;
  readonly finalizeCommit: (
    transaction: DatabaseTransaction,
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
      result: PostgresMcpPlanCommitResult;
    }>,
  ) => void | PromiseLike<void>;
}

export interface PostgresMcpRetentionPurgeResult {
  readonly receipts: number;
  readonly approvals: number;
  readonly plans: number;
}

export interface PostgresMcpChangePlanStore {
  readonly planStore: PostgresMcpChangePlanStorePort;
  readonly listByPrincipalIds: (
    filter: PostgresMcpPlanListFilter,
  ) => Promise<readonly PostgresMcpStoredPlan[]>;
  readonly approvalStore: PostgresMcpApprovalStorePort;
  readonly commitPlanStore: PostgresMcpChangePlanCommitPlanStorePort;
  readonly commitApprovalStore: PostgresMcpChangePlanCommitApprovalStorePort;
  readonly expireDuePlans: () => Promise<number>;
  readonly purgeRetained: () => Promise<PostgresMcpRetentionPurgeResult>;
}

/** Must stay aligned with write-approval-api DEFAULT_LIST_LIMIT. */
const MCP_PLAN_LIST_MAX_LIMIT = 100;

export interface PostgresMcpPlanListFilter {
  readonly principalIds: readonly string[];
  readonly limit: number;
}

export type PostgresMcpChangePlanStoreErrorCode =
  | 'legacy_session_field_rejected'
  | 'invalid_plan'
  | 'plan_not_found'
  | 'binding_mismatch'
  | 'digest_mismatch'
  | 'approval_conflict'
  | 'receipt_not_found';

export class PostgresMcpChangePlanStoreError extends Error {
  readonly code: PostgresMcpChangePlanStoreErrorCode;

  constructor(code: PostgresMcpChangePlanStoreErrorCode, message: string) {
    super(message);
    this.name = 'PostgresMcpChangePlanStoreError';
    this.code = code;
  }
}

type DatabaseExecutor = Kysely<DatabaseSchema> | DatabaseTransaction;

interface PlanRow {
  plan_id: string;
  binding_kind: string;
  principal_id: string;
  client_id: string;
  credential_binding_id: string;
  resource_audience: string;
  security_epoch: string;
  binding_digest: string;
  binding_json: Record<string, unknown>;
  status: PostgresMcpStoredPlan['status'];
  risk: PostgresMcpStoredPlan['risk'];
  requires_approval: boolean;
  approval_method: string | null;
  approval_uri: string | null;
  summary: string;
  impact_json: Record<string, unknown>;
  required_scopes_json: readonly string[];
  base_revisions_json: Record<string, string>;
  operations_json: readonly unknown[];
  operations_digest: string;
  untrusted_note: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  retained_until: Date;
}

interface ApprovalRow {
  plan_id: string;
  binding_digest: string;
  operations_digest: string;
  decided_at: Date;
  consumed_at: Date | null;
  retained_until: Date;
}

interface ReceiptRow {
  plan_id: string;
  idempotency_key: string;
  binding_digest: string;
  operations_digest: string;
  result_json: Record<string, unknown> | null;
  result_digest: string | null;
  claimed_at: Date;
  completed_at: Date | null;
  retained_until: Date;
}

const PLAN_SELECT = sql.raw(`
  plan_id, binding_kind, principal_id, client_id, credential_binding_id,
  resource_audience, security_epoch, binding_digest, binding_json, status, risk,
  requires_approval, approval_method, approval_uri, summary, impact_json,
  required_scopes_json, base_revisions_json, operations_json, operations_digest,
  untrusted_note, expires_at, created_at, updated_at, retained_until
`);

const LEGACY_MCP_SESSION_KEYS = Object.freeze([
  'session',
  'sessionId',
  'session_id',
  'mcpSessionId',
  'mcp_session_id',
  'Mcp-Session-Id',
]);

const MCP_PLAN_RETENTION_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export function assertNoLegacyMcpSessionFields(
  value: unknown,
  path = '$',
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const normalized = key.replaceAll('-', '_').toLowerCase();
      if (
        LEGACY_MCP_SESSION_KEYS.includes(key)
        || normalized === 'session'
        || normalized === 'sessionid'
        || normalized === 'session_id'
        || normalized === 'mcpsessionid'
        || normalized === 'mcp_session_id'
      ) {
        throw new PostgresMcpChangePlanStoreError(
          'legacy_session_field_rejected',
          `MCP Plan/Approval/receipt input must not contain legacy Session field at ${path}.${key}`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        assertNoLegacyMcpSessionFields(descriptor.value, `${path}.${key}`, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

export function createMcpBindingDigest(
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  const owned = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(binding));
  const facts = [
    owned.kind,
    owned.principalId,
    owned.clientId,
    owned.credentialBindingId,
    owned.resourceAudience,
    owned.securityEpoch,
  ];
  return createHash('sha256').update(facts.join('\0'), 'utf8').digest('hex');
}

export interface PostgresMcpChangePlanRow {
  readonly plan_id: string;
  readonly binding_kind: 'authenticated';
  readonly principal_id: string;
  readonly client_id: string;
  readonly credential_binding_id: string;
  readonly resource_audience: string;
  readonly security_epoch: string;
  readonly binding_digest: string;
  readonly binding_json: McpAuthenticatedAuthorizationBinding;
  readonly status: PostgresMcpStoredPlan['status'];
  readonly risk: PostgresMcpStoredPlan['risk'];
  readonly requires_approval: boolean;
  readonly approval_method: string | null;
  readonly approval_uri: string | null;
  readonly summary: string;
  readonly impact_json: ChangePlanImpact;
  readonly required_scopes_json: readonly ScopeName[];
  readonly base_revisions_json: Readonly<Record<string, string>>;
  readonly operations_json: readonly ChangePlanOperation[];
  readonly operations_digest: string;
  readonly untrusted_note: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly retained_until: string;
}

export function buildPostgresMcpChangePlanRow(
  plan: PostgresMcpStoredPlan,
): PostgresMcpChangePlanRow {
  assertNoLegacyMcpSessionFields(plan);
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    throw new PostgresMcpChangePlanStoreError('invalid_plan', 'MCP Change Plan must be an object.');
  }
  const binding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(plan.binding));
  const statuses: readonly PostgresMcpStoredPlan['status'][] = Object.freeze([
    'pending',
    'approved',
    'committing',
    'consumed',
    'cancelled',
    'expired',
  ]);
  if (!statuses.includes(plan.status)) {
    throw new PostgresMcpChangePlanStoreError('invalid_plan', 'MCP Change Plan status is invalid.');
  }
  if (typeof plan.operationsDigest !== 'string' || plan.operationsDigest.length === 0) {
    throw new PostgresMcpChangePlanStoreError('invalid_plan', 'MCP Change Plan operations digest is required.');
  }
  const expiresAt = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new PostgresMcpChangePlanStoreError(
      'invalid_plan',
      'MCP Change Plan expiresAt must be a parseable timestamp.',
    );
  }
  const retainedUntil = new Date(expiresAt + MCP_PLAN_RETENTION_AFTER_EXPIRY_MS).toISOString();
  return Object.freeze({
    plan_id: plan.planId,
    binding_kind: binding.kind,
    principal_id: binding.principalId,
    client_id: binding.clientId,
    credential_binding_id: binding.credentialBindingId,
    resource_audience: binding.resourceAudience,
    security_epoch: binding.securityEpoch,
    binding_digest: createMcpBindingDigest(binding),
    binding_json: binding,
    status: plan.status,
    risk: plan.risk,
    requires_approval: plan.requiresApproval,
    approval_method: plan.approvalMethod ?? null,
    approval_uri: plan.approvalUri ?? null,
    summary: plan.summary,
    impact_json: plan.impact,
    required_scopes_json: plan.requiredScopes,
    base_revisions_json: plan.baseRevisions,
    operations_json: plan.operations,
    operations_digest: plan.operationsDigest,
    untrusted_note: plan.untrustedNote,
    expires_at: plan.expiresAt,
    created_at: plan.createdAt,
    retained_until: retainedUntil,
  });
}

export function createPostgresMcpChangePlanStore(
  db: Kysely<DatabaseSchema>,
): PostgresMcpChangePlanStore {
  const withUnitOfWork = <Result>(
    callback: (transaction: DatabaseTransaction) => Promise<Result>,
  ): Promise<Result> => createUnitOfWork(db).execute(({ transaction }) => callback(transaction));

  const planStore: PostgresMcpChangePlanStorePort = Object.freeze({
    save(plan: PostgresMcpStoredPlan) {
      return savePlan(db, plan);
    },
    get(planId: string) {
      return getPlan(db, planId);
    },
    update(plan: PostgresMcpStoredPlan) {
      return updatePlan(db, plan);
    },
  });

  const listByPrincipalIds = (filter: PostgresMcpPlanListFilter): Promise<readonly PostgresMcpStoredPlan[]> =>
    listPlansByPrincipalIds(db, filter);

  const approvalStore: PostgresMcpApprovalStorePort = Object.freeze({
    markApproved(input: {
      readonly planId: string;
      readonly binding: McpAuthenticatedAuthorizationBinding;
      readonly operationsDigest: string;
    }) {
      return withUnitOfWork((transaction) => markApprovedInternal(transaction, input));
    },
    beginCommit(input: {
      readonly planId: string;
      readonly binding: McpAuthenticatedAuthorizationBinding;
      readonly operationsDigest: string;
      readonly idempotencyKey: string;
    }) {
      return withUnitOfWork((transaction) =>
        beginCommitInternal(transaction, input, { updatePlanStatus: true }));
    },
    finalizeCommit(input: {
      readonly planId: string;
      readonly idempotencyKey: string;
      readonly result: PostgresMcpPlanCommitResult;
    }) {
      return withUnitOfWork((transaction) =>
        finalizeCommitInternal(transaction, input, { updatePlanStatus: true }));
    },
    abortCommit(input: { readonly planId: string; readonly idempotencyKey: string }) {
      return withUnitOfWork((transaction) => abortCommitInternal(transaction, input));
    },
  });

  const commitPlanStore: PostgresMcpChangePlanCommitPlanStorePort = Object.freeze({
    lock(transaction: DatabaseTransaction, planId: string) {
      return lockPlan(transaction, planId);
    },
    update(transaction: DatabaseTransaction, plan: PostgresMcpStoredPlan) {
      return updatePlan(transaction, plan);
    },
  });

  const commitApprovalStore: PostgresMcpChangePlanCommitApprovalStorePort = Object.freeze({
    markApproved(
      transaction: DatabaseTransaction,
      input: {
        readonly planId: string;
        readonly binding: McpAuthenticatedAuthorizationBinding;
        readonly operationsDigest: string;
      },
    ) {
      return markApprovedInternal(transaction, input);
    },
    beginCommit(
      transaction: DatabaseTransaction,
      input: {
        readonly planId: string;
        readonly binding: McpAuthenticatedAuthorizationBinding;
        readonly operationsDigest: string;
        readonly idempotencyKey: string;
      },
    ) {
      return beginCommitInternal(transaction, input, { updatePlanStatus: false });
    },
    finalizeCommit(
      transaction: DatabaseTransaction,
      input: {
        readonly planId: string;
        readonly idempotencyKey: string;
        readonly result: PostgresMcpPlanCommitResult;
      },
    ) {
      return finalizeCommitInternal(transaction, input, { updatePlanStatus: false });
    },
  });

  return Object.freeze({
    planStore,
    listByPrincipalIds,
    approvalStore,
    commitPlanStore,
    commitApprovalStore,
    expireDuePlans() {
      return expireDuePlansAt(db);
    },
    purgeRetained() {
      return purgeRetainedAt(db);
    },
  });
}

export async function expireDuePlansAt(
  executor: DatabaseExecutor,
): Promise<number> {
  const expired = await sql<{ plan_id: string }>`
    WITH candidates AS (
      SELECT plan_id
      FROM mcp_change_plans
      WHERE status IN ('pending', 'approved')
        AND expires_at <= current_timestamp
      FOR UPDATE SKIP LOCKED
    )
    UPDATE mcp_change_plans plan
    SET status = 'expired', updated_at = current_timestamp
    FROM candidates
    WHERE plan.plan_id = candidates.plan_id
    RETURNING plan.plan_id
  `.execute(executor);
  return expired.rows.length;
}

export async function purgeRetainedAt(
  executor: DatabaseExecutor,
): Promise<PostgresMcpRetentionPurgeResult> {
  const receipts = await sql<{ plan_id: string }>`
    DELETE FROM mcp_commit_receipts receipt
    USING mcp_change_plans plan
    WHERE receipt.plan_id = plan.plan_id
      AND receipt.completed_at IS NOT NULL
      AND receipt.retained_until <= current_timestamp
    RETURNING receipt.plan_id
  `.execute(executor);
  const approvals = await sql<{ plan_id: string }>`
    DELETE FROM mcp_approvals approval
    USING mcp_change_plans plan
    WHERE approval.plan_id = plan.plan_id
      AND approval.retained_until <= current_timestamp
      AND (
        approval.consumed_at IS NOT NULL
        OR plan.status IN ('consumed', 'cancelled', 'expired')
      )
    RETURNING approval.plan_id
  `.execute(executor);
  const plans = await sql<{ plan_id: string }>`
    DELETE FROM mcp_change_plans
    WHERE status IN ('consumed', 'cancelled', 'expired')
      AND retained_until <= current_timestamp
    RETURNING plan_id
  `.execute(executor);
  return Object.freeze({
    receipts: receipts.rows.length,
    approvals: approvals.rows.length,
    plans: plans.rows.length,
  });
}

async function savePlan(
  executor: DatabaseExecutor,
  plan: PostgresMcpStoredPlan,
): Promise<void> {
  const row = buildPostgresMcpChangePlanRow(plan);
  await sql`
    INSERT INTO mcp_change_plans (
      plan_id, binding_kind, principal_id, client_id, credential_binding_id,
      resource_audience, security_epoch, binding_digest, binding_json, status,
      risk, requires_approval, approval_method, approval_uri, summary, impact_json,
      required_scopes_json, base_revisions_json, operations_json, operations_digest,
      untrusted_note, expires_at, created_at, retained_until, updated_at
    ) VALUES (
      ${row.plan_id}, ${row.binding_kind}, ${row.principal_id}, ${row.client_id},
      ${row.credential_binding_id}, ${row.resource_audience}, ${row.security_epoch},
      ${row.binding_digest}, ${JSON.stringify(row.binding_json)}::jsonb, ${row.status},
      ${row.risk}, ${row.requires_approval}, ${row.approval_method}, ${row.approval_uri},
      ${row.summary}, ${JSON.stringify(row.impact_json)}::jsonb,
      ${JSON.stringify(row.required_scopes_json)}::jsonb,
      ${JSON.stringify(row.base_revisions_json)}::jsonb,
      ${JSON.stringify(row.operations_json)}::jsonb, ${row.operations_digest},
      ${row.untrusted_note}, ${row.expires_at}::timestamptz, ${row.created_at}::timestamptz,
      ${row.retained_until}::timestamptz, current_timestamp
    )
  `.execute(executor);
}

async function getPlan(
  executor: DatabaseExecutor,
  planId: string,
): Promise<PostgresMcpStoredPlan | undefined> {
  assertPlanId(planId);
  const result = await sql<PlanRow>`
    SELECT ${PLAN_SELECT}
    FROM mcp_change_plans
    WHERE plan_id = ${planId}
  `.execute(executor);
  return result.rows[0] === undefined ? undefined : mapPlanRow(result.rows[0]);
}

async function listPlansByPrincipalIds(
  executor: DatabaseExecutor,
  filter: PostgresMcpPlanListFilter,
): Promise<readonly PostgresMcpStoredPlan[]> {
  const principalIds = filter.principalIds;
  if (
    !Array.isArray(principalIds)
    || principalIds.length === 0
    || principalIds.length > 2
    || principalIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)
  ) {
    throw new PostgresMcpChangePlanStoreError(
      'invalid_plan',
      'MCP Plan principal id filter must contain one or two non-empty strings.',
    );
  }
  if (
    !Number.isSafeInteger(filter.limit)
    || filter.limit < 1
    || filter.limit > MCP_PLAN_LIST_MAX_LIMIT
  ) {
    throw new PostgresMcpChangePlanStoreError(
      'invalid_plan',
      'MCP Plan list limit must be a positive integer within the page budget.',
    );
  }
  const result = await sql<PlanRow>`
    SELECT ${PLAN_SELECT}
    FROM mcp_change_plans
    WHERE principal_id IN (${sql.join(principalIds, sql`, `)})
    ORDER BY created_at DESC, plan_id
    LIMIT ${filter.limit}
  `.execute(executor);
  return Object.freeze(result.rows.map((row) => mapPlanRow(row)));
}

async function lockPlan(
  executor: DatabaseExecutor,
  planId: string,
): Promise<PostgresMcpStoredPlan | undefined> {
  assertPlanId(planId);
  const result = await sql<PlanRow>`
    SELECT ${PLAN_SELECT}
    FROM mcp_change_plans
    WHERE plan_id = ${planId}
    FOR UPDATE
  `.execute(executor);
  return result.rows[0] === undefined ? undefined : mapPlanRow(result.rows[0]);
}

async function updatePlan(
  executor: DatabaseExecutor,
  plan: PostgresMcpStoredPlan,
): Promise<void> {
  const row = buildPostgresMcpChangePlanRow(plan);
  const updated = await sql<{ plan_id: string }>`
    UPDATE mcp_change_plans
    SET binding_kind = ${row.binding_kind},
        principal_id = ${row.principal_id},
        client_id = ${row.client_id},
        credential_binding_id = ${row.credential_binding_id},
        resource_audience = ${row.resource_audience},
        security_epoch = ${row.security_epoch},
        binding_digest = ${row.binding_digest},
        binding_json = ${JSON.stringify(row.binding_json)}::jsonb,
        status = ${row.status},
        risk = ${row.risk},
        requires_approval = ${row.requires_approval},
        approval_method = ${row.approval_method},
        approval_uri = ${row.approval_uri},
        summary = ${row.summary},
        impact_json = ${JSON.stringify(row.impact_json)}::jsonb,
        required_scopes_json = ${JSON.stringify(row.required_scopes_json)}::jsonb,
        base_revisions_json = ${JSON.stringify(row.base_revisions_json)}::jsonb,
        operations_json = ${JSON.stringify(row.operations_json)}::jsonb,
        operations_digest = ${row.operations_digest},
        untrusted_note = ${row.untrusted_note},
        expires_at = ${row.expires_at}::timestamptz,
        created_at = ${row.created_at}::timestamptz,
        retained_until = ${row.retained_until}::timestamptz,
        updated_at = current_timestamp
    WHERE plan_id = ${row.plan_id}
    RETURNING plan_id
  `.execute(executor);
  if (updated.rows.length !== 1) {
    throw new PostgresMcpChangePlanStoreError(
      'plan_not_found',
      'MCP Change Plan could not be updated with the same binding and operations digest.',
    );
  }
}

async function markApprovedInternal(
  executor: DatabaseExecutor,
  input: Readonly<{
    planId: string;
    binding: McpAuthenticatedAuthorizationBinding;
    operationsDigest: string;
  }>,
): Promise<void> {
  assertNoLegacyMcpSessionFields(input);
  assertPlanId(input.planId);
  const binding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(input.binding));
  const bindingDigest = createMcpBindingDigest(binding);
  const plan = await sql<{
    plan_id: string;
    status: PostgresMcpStoredPlan['status'];
    binding_digest: string;
    operations_digest: string;
    expired: boolean;
  }>`
    SELECT plan_id, status, binding_digest, operations_digest,
           (expires_at <= current_timestamp) AS expired
    FROM mcp_change_plans
    WHERE plan_id = ${input.planId}
    FOR UPDATE
  `.execute(executor);
  if (plan.rows.length !== 1) {
    throw new PostgresMcpChangePlanStoreError('plan_not_found', 'MCP Change Plan was not found.');
  }
  const planRow = plan.rows[0]!;
  if (planRow.binding_digest !== bindingDigest) {
    throw new PostgresMcpChangePlanStoreError(
      'binding_mismatch',
      'MCP Approval binding does not match the stored Plan.',
    );
  }
  if (planRow.operations_digest !== input.operationsDigest) {
    throw new PostgresMcpChangePlanStoreError(
      'digest_mismatch',
      'MCP Approval operations digest does not match the stored Plan.',
    );
  }
  if (planRow.status !== 'pending' && planRow.status !== 'approved') {
    throw new PostgresMcpChangePlanStoreError(
      'approval_conflict',
      'MCP Change Plan is not in an approvable state.',
    );
  }
  if (planRow.expired) {
    throw new PostgresMcpChangePlanStoreError(
      'approval_conflict',
      'MCP Change Plan has expired before approval.',
    );
  }

  const inserted = await sql<{ plan_id: string }>`
    INSERT INTO mcp_approvals (plan_id, binding_digest, operations_digest)
    VALUES (${input.planId}, ${bindingDigest}, ${input.operationsDigest})
    ON CONFLICT (plan_id) DO NOTHING
    RETURNING plan_id
  `.execute(executor);
  if (inserted.rows.length === 1) return;

  const approval = await sql<ApprovalRow>`
    SELECT plan_id, binding_digest, operations_digest, decided_at, consumed_at, retained_until
    FROM mcp_approvals
    WHERE plan_id = ${input.planId}
    FOR UPDATE
  `.execute(executor);
  const existing = approval.rows[0];
  if (existing === undefined) {
    throw new PostgresMcpChangePlanStoreError(
      'approval_conflict',
      'MCP Approval row disappeared during concurrent decision.',
    );
  }
  if (existing.binding_digest !== bindingDigest) {
    throw new PostgresMcpChangePlanStoreError(
      'binding_mismatch',
      'MCP Approval cannot be rebound to a different authorization binding.',
    );
  }
  if (existing.operations_digest !== input.operationsDigest) {
    throw new PostgresMcpChangePlanStoreError(
      'digest_mismatch',
      'MCP Approval cannot be rebound to a different operations digest.',
    );
  }
  if (existing.consumed_at !== null) {
    throw new PostgresMcpChangePlanStoreError(
      'approval_conflict',
      'MCP Approval is already consumed.',
    );
  }
}

async function beginCommitInternal(
  executor: DatabaseExecutor,
  input: Readonly<{
    planId: string;
    binding: McpAuthenticatedAuthorizationBinding;
    operationsDigest: string;
    idempotencyKey: string;
  }>,
  options: Readonly<{ updatePlanStatus: boolean }>,
): Promise<PostgresMcpApprovalBeginResult> {
  assertNoLegacyMcpSessionFields(input);
  assertPlanId(input.planId);
  assertIdempotencyKey(input.idempotencyKey);
  const binding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(input.binding));
  const bindingDigest = createMcpBindingDigest(binding);

  const plan = await sql<{
    plan_id: string;
    status: PostgresMcpStoredPlan['status'];
    requires_approval: boolean;
    binding_digest: string;
    operations_digest: string;
    expired: boolean;
  }>`
    SELECT plan_id, status, requires_approval, binding_digest, operations_digest,
           (expires_at <= current_timestamp) AS expired
    FROM mcp_change_plans
    WHERE plan_id = ${input.planId}
    FOR UPDATE
  `.execute(executor);
  const planRow = plan.rows[0];
  if (planRow === undefined) return rejected('missing');
  if (planRow.binding_digest !== bindingDigest) return rejected('binding_mismatch');
  if (planRow.operations_digest !== input.operationsDigest) return rejected('digest_mismatch');

  if (planRow.status === 'consumed') {
    const receipt = await readReceipt(executor, input.planId, input.idempotencyKey, true);
    if (
      receipt !== undefined
      && receipt.completed_at !== null
      && receipt.result_json !== null
      && receipt.result_digest !== null
    ) {
      if (receipt.binding_digest !== bindingDigest) return rejected('binding_mismatch');
      if (receipt.operations_digest !== input.operationsDigest) return rejected('digest_mismatch');
      return alreadyConsumed(receipt);
    }
    return rejected('concurrent_lost');
  }
  if (planRow.status === 'committing') return rejected('concurrent_lost');
  if (planRow.status === 'cancelled' || planRow.status === 'expired') {
    const receipt = await readReceipt(executor, input.planId, input.idempotencyKey, true);
    if (
      receipt !== undefined
      && receipt.completed_at !== null
      && receipt.result_json !== null
      && receipt.result_digest !== null
    ) {
      if (receipt.binding_digest !== bindingDigest) return rejected('binding_mismatch');
      if (receipt.operations_digest !== input.operationsDigest) return rejected('digest_mismatch');
      return alreadyConsumed(receipt);
    }
    // FIX-L-052: a cancelled Plan is schema-terminal; reject the claim with the
    // dedicated reason instead of attempting the illegal cancelled -> committing
    // transition that the guard would refuse with an internal 23514.
    if (planRow.status === 'cancelled') return rejected('plan_cancelled');
  }
  if (planRow.status === 'expired' || planRow.expired) return rejected('expired');

  // FIX-M-016 unified claim gate: low-risk ready Plans (requires_approval
  // false) claim directly under binding/receipt/row lock; approval-required
  // Plans must be `approved` and carry a live Approval row.
  const lowRiskReady = !planRow.requires_approval
    && (planRow.status === 'pending' || planRow.status === 'approved');
  if (!lowRiskReady) {
    if (planRow.status !== 'approved') {
      return rejected('missing');
    }

    const approval = await sql<ApprovalRow>`
      SELECT plan_id, binding_digest, operations_digest, decided_at, consumed_at, retained_until
      FROM mcp_approvals
      WHERE plan_id = ${input.planId}
      FOR UPDATE
    `.execute(executor);
    const approvalRow = approval.rows[0];
    if (approvalRow === undefined) return rejected('missing');
    if (approvalRow.binding_digest !== bindingDigest) return rejected('binding_mismatch');
    if (approvalRow.operations_digest !== input.operationsDigest) return rejected('digest_mismatch');
    if (approvalRow.consumed_at !== null) return rejected('concurrent_lost');
  }

  const inserted = await sql<{ idempotency_key: string }>`
    INSERT INTO mcp_commit_receipts (
      plan_id, idempotency_key, binding_digest, operations_digest
    ) VALUES (
      ${input.planId}, ${input.idempotencyKey}, ${bindingDigest}, ${input.operationsDigest}
    )
    ON CONFLICT (plan_id, idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `.execute(executor);
  if (inserted.rows.length === 1) {
    if (options.updatePlanStatus) {
      await setPlanStatus(executor, input.planId, 'committing');
    }
    return Object.freeze({ status: 'ready' as const });
  }

  const receipt = await readReceipt(executor, input.planId, input.idempotencyKey, true);
  if (
    receipt !== undefined
    && receipt.completed_at !== null
    && receipt.result_json !== null
    && receipt.result_digest !== null
  ) {
    if (receipt.binding_digest !== bindingDigest) return rejected('binding_mismatch');
    if (receipt.operations_digest !== input.operationsDigest) return rejected('digest_mismatch');
    return alreadyConsumed(receipt);
  }
  return rejected('concurrent_lost');
}

async function finalizeCommitInternal(
  executor: DatabaseExecutor,
  input: Readonly<{
    planId: string;
    idempotencyKey: string;
    result: PostgresMcpPlanCommitResult;
  }>,
  options: Readonly<{ updatePlanStatus: boolean }>,
): Promise<void> {
  assertNoLegacyMcpSessionFields(input);
  assertNoLegacyMcpSessionFields(input.result);
  assertPlanId(input.planId);
  assertIdempotencyKey(input.idempotencyKey);
  if (input.result.planId !== input.planId) {
    throw new PostgresMcpChangePlanStoreError(
      'invalid_plan',
      'MCP Commit result planId must match the claimed Plan.',
    );
  }
  const resultJson = JSON.stringify(input.result);
  const resultDigest = createHash('sha256').update(resultJson, 'utf8').digest('hex');
  const updated = await sql<{ plan_id: string }>`
    UPDATE mcp_commit_receipts
    SET result_json = ${resultJson}::jsonb,
        result_digest = ${resultDigest},
        completed_at = current_timestamp,
        retained_until = current_timestamp + interval '30 days'
    WHERE plan_id = ${input.planId}
      AND idempotency_key = ${input.idempotencyKey}
      AND completed_at IS NULL
    RETURNING plan_id
  `.execute(executor);
  if (updated.rows.length !== 1) {
    throw new PostgresMcpChangePlanStoreError(
      'receipt_not_found',
      'MCP Commit receipt claim was not found for finalization.',
    );
  }
  // FIX-M-016: low-risk ready Plans have no Approval row to consume; only
  // approval-required Plans must consume exactly one live Approval here.
  const plan = await sql<{ requires_approval: boolean }>`
    SELECT requires_approval
    FROM mcp_change_plans
    WHERE plan_id = ${input.planId}
  `.execute(executor);
  const requiresApproval = plan.rows[0]?.requires_approval ?? true;
  const consumed = await sql<{ plan_id: string }>`
    UPDATE mcp_approvals
    SET consumed_at = current_timestamp
    WHERE plan_id = ${input.planId}
      AND consumed_at IS NULL
    RETURNING plan_id
  `.execute(executor);
  if (consumed.rows.length !== 1 && requiresApproval) {
    throw new PostgresMcpChangePlanStoreError(
      'approval_conflict',
      'MCP Approval was already consumed or missing during finalization.',
    );
  }
  if (options.updatePlanStatus) {
    await setPlanStatus(executor, input.planId, 'consumed');
  }
}

async function abortCommitInternal(
  executor: DatabaseExecutor,
  input: Readonly<{ planId: string; idempotencyKey: string }>,
): Promise<void> {
  assertNoLegacyMcpSessionFields(input);
  assertPlanId(input.planId);
  assertIdempotencyKey(input.idempotencyKey);
  const deleted = await sql<{ idempotency_key: string }>`
    DELETE FROM mcp_commit_receipts
    WHERE plan_id = ${input.planId}
      AND idempotency_key = ${input.idempotencyKey}
      AND completed_at IS NULL
    RETURNING idempotency_key
  `.execute(executor);
  if (deleted.rows.length === 0) return;
  const plan = await sql<{ requires_approval: boolean }>`
    SELECT requires_approval
    FROM mcp_change_plans
    WHERE plan_id = ${input.planId}
  `.execute(executor);
  await setPlanStatus(
    executor,
    input.planId,
    plan.rows[0]?.requires_approval === false ? 'pending' : 'approved',
  );
}

async function setPlanStatus(
  executor: DatabaseExecutor,
  planId: string,
  status: PostgresMcpStoredPlan['status'],
): Promise<void> {
  const updated = await sql<{ plan_id: string }>`
    UPDATE mcp_change_plans
    SET status = ${status}, updated_at = current_timestamp
    WHERE plan_id = ${planId}
    RETURNING plan_id
  `.execute(executor);
  if (updated.rows.length !== 1) {
    throw new PostgresMcpChangePlanStoreError(
      'plan_not_found',
      'MCP Change Plan status could not be advanced.',
    );
  }
}

async function readReceipt(
  executor: DatabaseExecutor,
  planId: string,
  idempotencyKey: string,
  lock: boolean,
): Promise<ReceiptRow | undefined> {
  const result = lock
    ? await sql<ReceiptRow>`
        SELECT plan_id, idempotency_key, binding_digest, operations_digest,
               result_json, result_digest, claimed_at, completed_at, retained_until
        FROM mcp_commit_receipts
        WHERE plan_id = ${planId}
          AND idempotency_key = ${idempotencyKey}
        FOR UPDATE
      `.execute(executor)
    : await sql<ReceiptRow>`
        SELECT plan_id, idempotency_key, binding_digest, operations_digest,
               result_json, result_digest, claimed_at, completed_at, retained_until
        FROM mcp_commit_receipts
        WHERE plan_id = ${planId}
          AND idempotency_key = ${idempotencyKey}
      `.execute(executor);
  return result.rows[0];
}

function alreadyConsumed(row: ReceiptRow): PostgresMcpApprovalBeginResult {
  const result = row.result_json as unknown as PostgresMcpPlanCommitResult;
  if (result.planId !== row.plan_id || !Array.isArray(result.operations)) {
    throw new PostgresMcpChangePlanStoreError(
      'receipt_not_found',
      'MCP Commit receipt contains an invalid first result.',
    );
  }
  return Object.freeze({
    status: 'already_consumed' as const,
    firstResult: Object.freeze({
      planId: result.planId,
      committedAt: result.committedAt,
      operations: Object.freeze([...result.operations]) as readonly OperationResult[],
    }),
  });
}

function mapPlanRow(row: PlanRow): PostgresMcpStoredPlan {
  const binding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(row.binding_json));
  return Object.freeze({
    planId: row.plan_id,
    expiresAt: row.expires_at.toISOString(),
    risk: row.risk,
    requiresApproval: row.requires_approval,
    ...(row.approval_method !== null
      ? { approvalMethod: row.approval_method, approvalUri: row.approval_uri ?? undefined }
      : {}),
    summary: row.summary,
    impact: row.impact_json as unknown as ChangePlanImpact,
    requiredScopes: Object.freeze([...row.required_scopes_json]) as readonly ScopeName[],
    baseRevisions: Object.freeze({ ...row.base_revisions_json }),
    operations: Object.freeze(
      row.operations_json.map((operation) => Object.freeze(operation)),
    ) as readonly ChangePlanOperation[],
    operationsDigest: row.operations_digest,
    binding,
    untrustedNote: row.untrusted_note,
    createdAt: row.created_at.toISOString(),
    status: row.status,
  });
}

function rejected(
  reason: 'missing' | 'binding_mismatch' | 'digest_mismatch' | 'concurrent_lost' | 'expired' | 'plan_cancelled',
): PostgresMcpApprovalBeginResult {
  return Object.freeze({ status: 'rejected' as const, reason });
}

function assertPlanId(planId: string): void {
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > 256) {
    throw new PostgresMcpChangePlanStoreError('invalid_plan', 'MCP Plan id must be a non-empty string.');
  }
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 512) {
    throw new PostgresMcpChangePlanStoreError(
      'invalid_plan',
      'MCP Commit idempotency key must be a non-empty string.',
    );
  }
}
