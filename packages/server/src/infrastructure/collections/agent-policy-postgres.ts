import { issueAgentKey } from './agent-key-postgres.js';
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
  readonly getAgentPolicy: (clientId: string) => Promise<AgentPolicyView>;
  readonly putAgentPolicy: (clientId: string, policy: AgentPolicyName) => Promise<AgentPolicyView>;
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
    readPolicy: (clientId) => readAgentPolicy(db, clientId),
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

export function createPhase4bMcpAgentApprovalApi(
  db: Kysely<DatabaseSchema>,
  options: { secretHmacKey?: string } = {},
): AgentApprovalApi {
  const ports = createPostgresMcpWriteApprovalPorts(db);
  const base = createPhase4bMcpWriteApprovalApi(ports);
  const directory = createAgentDirectoryApi(db);
  return Object.freeze<AgentApprovalApi>({
    ...base,
    ...(options.secretHmacKey ? { issueAgentKey: (accountId: string, name: string, commandId: string) =>
      issueAgentKey(db, options.secretHmacKey!, accountId, name, commandId) } : {}),
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
    getAgentPolicy: (clientId) => readAgentPolicyView(db, clientId),
    putAgentPolicy: (clientId, policy) => writeAgentPolicy(db, clientId, policy),
    undo: (input) => undoApprovedPlan(db, base, input),
  });
}

export async function readAgentPolicy(
  db: Kysely<DatabaseSchema>,
  clientId: string,
): Promise<AgentPolicyName> {
  assertClientId(clientId);
  const result = await sql<{ policy: string }>`
    SELECT policy FROM agent_policies WHERE client_id = ${clientId}
  `.execute(db);
  return result.rows[0]?.policy === 'trusted' ? 'trusted' : 'manual';
}

async function readAgentPolicyView(
  db: Kysely<DatabaseSchema>,
  clientId: string,
): Promise<AgentPolicyView> {
  return { clientId, policy: await readAgentPolicy(db, clientId) };
}

export async function writeAgentPolicy(
  db: Kysely<DatabaseSchema>,
  clientId: string,
  policy: AgentPolicyName,
): Promise<AgentPolicyView> {
  assertClientId(clientId);
  if (policy !== 'manual' && policy !== 'trusted') {
    throw new TypeError('Agent policy must be manual or trusted.');
  }
  await sql`
    INSERT INTO agent_policies (client_id, policy, updated_at)
    VALUES (${clientId}, ${policy}, current_timestamp)
    ON CONFLICT (client_id) DO UPDATE
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
  const restored = await createPostgresCollectionVersionUnitOfWork(db).execute((ports) =>
    undoAgentPlanVersion(ports as RestoreCollectionVersionPorts, {
      principalId: input.accountId,
      subjectId: input.subjectId,
      collectionId: receipt.collectionId,
      versionId: receipt.versionId,
      commandId: input.commandId,
      force: input.force,
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
