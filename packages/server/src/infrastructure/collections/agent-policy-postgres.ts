/**
 * Postgres adapter for E4 agent policy, trusted auto-approval, and Undo.
 */
import { sql, type Kysely } from 'kysely';
import {
  appendAuditEvent,
  createPostgresMcpWriteApprovalPorts,
  createUnitOfWork,
  type DatabaseSchema,
} from '../database/index.js';
import type { RestoreCollectionVersionPorts } from '../../modules/collections/index.js';
import {
  AgentPlanUndoError,
  captureAgentPlanCollectionVersion,
  createAutoApproveTrustedPlan,
  createPhase4bMcpWriteApprovalApi,
  undoAgentPlanVersion,
  type AgentPlanPolicyReceipt,
  type AgentPolicyName,
  type AutoApproveTrustedPlan,
  type Phase4bMcpWriteApprovalApi,
  type WriteApprovalAccount,
  type WriteApprovalPage,
  type WriteApprovalView,
} from '../../modules/mcp/index.js';
import { createAgentDirectoryApi } from './agent-directory-postgres.js';
import type { AgentAuditRecord, AgentRevokeResult, AgentSummary } from './agent-directory-postgres.js';
import { createPostgresCollectionVersionUnitOfWork } from './collection-tree-version-postgres.js';
import { readMcpPlanCommitRevision } from './mcp-plan-commit-revisions-postgres.js';

const CLIENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u;

export interface AgentPolicyView {
  readonly clientId: string;
  readonly policy: AgentPolicyName;
}

export interface AgentUndoInput {
  readonly accountId: string;
  readonly subjectId: string;
  readonly planId: string;
  readonly force: boolean;
  readonly commandId: string;
}

export interface AgentUndoResult {
  readonly planId: string;
  readonly versionId: string;
  readonly restored: true;
  readonly noop: boolean;
}

export interface AgentApprovalApi extends Phase4bMcpWriteApprovalApi {
  readonly issueAgentKey?: (accountId: string, name: string, commandId: string) => Promise<{ id: string; name: string; secret: string }>;
  readonly getAgentPolicy: (principalId: string, clientId: string) => Promise<AgentPolicyView>;
  readonly putAgentPolicy: (
    principalId: string,
    clientId: string,
    policy: AgentPolicyName,
  ) => Promise<AgentPolicyView>;
  readonly undo: (input: AgentUndoInput) => Promise<AgentUndoResult>;
  readonly listAgents: (accountId: string) => Promise<{ readonly agents: readonly AgentSummary[] }>;
  readonly listAgentAudit: (
    accountId: string,
    agentId: string,
    limit: number,
  ) => Promise<{ readonly records: readonly AgentAuditRecord[] } | undefined>;
  readonly revokeAgent: (accountId: string, agentId: string) => Promise<AgentRevokeResult | undefined>;
}

export function createPostgresAutoApproveTrustedPlan(
  db: Kysely<DatabaseSchema>,
): AutoApproveTrustedPlan {
  return createAutoApproveTrustedPlan({
    readPolicy: (principalId, clientId) => readAgentPolicy(db, principalId, clientId),
    assertTrustedPolicy: async (principalId, clientId) =>
      (await readAgentPolicy(db, principalId, clientId)) === 'trusted',
    captureVersion: (input) => captureAgentPlanCollectionVersion(
      (work) => createPostgresCollectionVersionUnitOfWork(db).execute(
        (ports) => work(ports as RestoreCollectionVersionPorts),
      ),
      input,
    ),
    saveReceipt: (receipt) => savePolicyReceipt(db, receipt),
    audit: (input) => createUnitOfWork(db).execute(async ({ transaction }) => {
      await appendAuditEvent(transaction, {
        operationId: null,
        collectionId: null,
        principalId: input.principalId,
        eventType: 'mcp.approval_decision',
        details: {
          planId: input.planId,
          collectionId: input.collectionId,
          decision: 'auto-approved',
          approvedBy: 'policy',
          status: 'consumed',
          versionId: input.versionId,
          cause: input.cause,
          risk: input.risk,
          operationsDigest: input.operationsDigest,
        },
      });
    }),
  });
}

export type IssueAgentKey = (
  accountId: string,
  name: string,
  commandId: string,
) => Promise<{ id: string; name: string; secret: string }>;

/**
 * Key issuance is an account-credential write owned by infrastructure:auth;
 * bootstrap injects it so this collections adapter does not import auth.
 */
export function createPhase4bMcpAgentApprovalApi(
  db: Kysely<DatabaseSchema>,
  options: { issueAgentKey?: IssueAgentKey } = {},
): AgentApprovalApi {
  const ports = createPostgresMcpWriteApprovalPorts(db);
  const base = createPhase4bMcpWriteApprovalApi(ports);
  const directory = createAgentDirectoryApi(db);
  return Object.freeze<AgentApprovalApi>({
    ...base,
    ...(options.issueAgentKey ? { issueAgentKey: options.issueAgentKey } : {}),
    listAgents: (accountId) => directory.list(accountId),
    listAgentAudit: (accountId, agentId, limit) => directory.audit(accountId, agentId, limit),
    revokeAgent: (accountId, agentId) => directory.revoke(accountId, agentId),
    async list(account, options) {
      const page = await base.list(account, options);
      return attachReceipts(db, page);
    },
    async get(account, planId) {
      const view = await base.get(account, planId);
      if (view === undefined) return undefined;
      const receipt = await readPolicyReceipt(db, view.planId);
      return withReceipt(view, receipt);
    },
    getAgentPolicy: (principalId, clientId) => readAgentPolicyView(db, principalId, clientId),
    putAgentPolicy: (principalId, clientId, policy) => writeAgentPolicy(db, principalId, clientId, policy),
    undo: (input) => undoApprovedPlan(db, base, input),
  });
}

/** Policy is per account: one OAuth client id can belong to several accounts. */
export async function readAgentPolicy(
  db: Kysely<DatabaseSchema>,
  principalId: string,
  clientId: string,
): Promise<AgentPolicyName> {
  assertPrincipalId(principalId);
  assertClientId(clientId);
  const result = await sql<{ policy: string }>`
    SELECT policy FROM agent_policies
    WHERE principal_id = ${principalId} AND client_id = ${clientId}
  `.execute(db);
  return result.rows[0]?.policy === 'trusted' ? 'trusted' : 'manual';
}

async function readAgentPolicyView(
  db: Kysely<DatabaseSchema>,
  principalId: string,
  clientId: string,
): Promise<AgentPolicyView> {
  return { clientId, policy: await readAgentPolicy(db, principalId, clientId) };
}

export async function writeAgentPolicy(
  db: Kysely<DatabaseSchema>,
  principalId: string,
  clientId: string,
  policy: AgentPolicyName,
): Promise<AgentPolicyView> {
  assertPrincipalId(principalId);
  assertClientId(clientId);
  if (policy !== 'manual' && policy !== 'trusted') {
    throw new TypeError('Agent policy must be manual or trusted.');
  }
  await sql`
    INSERT INTO agent_policies (principal_id, client_id, policy, updated_at)
    VALUES (${principalId}, ${clientId}, ${policy}, current_timestamp)
    ON CONFLICT (principal_id, client_id) DO UPDATE
      SET policy = EXCLUDED.policy, updated_at = current_timestamp
  `.execute(db);
  return { clientId, policy };
}

async function undoApprovedPlan(
  db: Kysely<DatabaseSchema>,
  api: Phase4bMcpWriteApprovalApi,
  input: AgentUndoInput,
): Promise<AgentUndoResult> {
  const account: WriteApprovalAccount = { id: input.accountId };
  const plan = await api.get(account, input.planId);
  if (plan === undefined) {
    throw new AgentPlanUndoError('not_found', 'The requested approval was not found.');
  }
  const receipt = await readPolicyReceipt(db, input.planId);
  if (receipt === undefined) {
    throw new AgentPlanUndoError('not_found', 'This plan has no saved version to undo.');
  }
  const committedContentRevision = await readMcpPlanCommitRevision(db, input.planId, receipt.collectionId);
  const restored = await createPostgresCollectionVersionUnitOfWork(db).execute((ports) =>
    undoAgentPlanVersion(ports as RestoreCollectionVersionPorts, {
      principalId: input.accountId,
      subjectId: input.subjectId,
      collectionId: receipt.collectionId,
      versionId: receipt.versionId,
      commandId: input.commandId,
      force: input.force,
      committedContentRevision,
    }));
  return {
    planId: input.planId,
    versionId: restored.versionId,
    restored: true,
    noop: restored.noop,
  };
}

async function attachReceipts(
  db: Kysely<DatabaseSchema>,
  page: WriteApprovalPage,
): Promise<WriteApprovalPage> {
  const receipts = await listPolicyReceipts(db, page.items.map((item) => item.planId));
  return {
    items: page.items.map((item) => withReceipt(item, receipts.get(item.planId))),
    nextCursor: null,
  };
}

function withReceipt(
  view: WriteApprovalView,
  receipt: AgentPlanPolicyReceipt | undefined,
): WriteApprovalView {
  return Object.freeze({
    ...view,
    approvedBy: receipt?.approvedBy ?? null,
    versionId: receipt?.versionId ?? null,
  }) as WriteApprovalView;
}

async function readPolicyReceipt(
  db: Kysely<DatabaseSchema>,
  planId: string,
): Promise<AgentPlanPolicyReceipt | undefined> {
  const found = await listPolicyReceipts(db, [planId]);
  return found.get(planId);
}

async function listPolicyReceipts(
  db: Kysely<DatabaseSchema>,
  planIds: readonly string[],
): Promise<Map<string, AgentPlanPolicyReceipt>> {
  const receipts = new Map<string, AgentPlanPolicyReceipt>();
  if (planIds.length === 0) return receipts;
  const result = await sql<{
    plan_id: string;
    client_id: string;
    approved_by: 'policy';
    version_id: string;
    collection_id: string;
    cause: string;
  }>`
    SELECT plan_id, client_id, approved_by, version_id, collection_id, cause
    FROM mcp_plan_policy_receipts
    WHERE plan_id IN (${sql.join(planIds.map((planId) => sql`${planId}`), sql`, `)})
  `.execute(db);
  for (const row of result.rows) {
    receipts.set(row.plan_id, {
      planId: row.plan_id,
      clientId: row.client_id,
      approvedBy: 'policy',
      versionId: row.version_id,
      collectionId: row.collection_id,
      cause: row.cause,
    });
  }
  return receipts;
}

async function savePolicyReceipt(
  db: Kysely<DatabaseSchema>,
  receipt: AgentPlanPolicyReceipt,
): Promise<void> {
  await sql`
    INSERT INTO mcp_plan_policy_receipts (
      plan_id, client_id, approved_by, version_id, collection_id, cause
    ) VALUES (
      ${receipt.planId}, ${receipt.clientId}, ${receipt.approvedBy},
      ${receipt.versionId}, ${receipt.collectionId}, ${receipt.cause}
    )
    ON CONFLICT (plan_id) DO NOTHING
  `.execute(db);
}

function assertClientId(clientId: string): void {
  if (!CLIENT_ID.test(clientId)) throw new TypeError('Agent client id is invalid.');
}

function assertPrincipalId(principalId: string): void {
  if (!CLIENT_ID.test(principalId)) throw new TypeError('Agent owner id is invalid.');
}
