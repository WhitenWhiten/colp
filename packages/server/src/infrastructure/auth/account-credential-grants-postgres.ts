import { sql, type Kysely } from 'kysely';
import type {
  CredentialGrantAction,
  CredentialGrantRecord,
  CredentialGrantResourcePort,
  CredentialGrantStore,
  CredentialPlanAuthorizationRecord,
  CredentialPlanPort,
  StoredCredentialPlan,
} from '../../modules/auth/index.js';
import { GRANT_ACTIONS } from '../../modules/auth/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import {
  createPostgresReportEditionReadPort,
  createPostgresReportSeriesReadPort,
} from '../reports/index.js';
import {
  createPhase4bMcpChangePlanDigestVerifier,
  verifyMcpReportPlanDigest,
  type McpReportPlan,
} from '../../modules/mcp/index.js';
import type { PostgresMcpStoredPlan } from '../database/mcp-change-plan-store.js';

export function createPostgresCredentialGrantStore(
  transaction: DatabaseTransaction,
): CredentialGrantStore {
  return {
    async insert(record) {
      await transaction.insertInto('account_credential_grants').values(toGrantRow(record)).execute();
    },
    async findById(id) {
      const row = await transaction.selectFrom('account_credential_grants').selectAll()
        .where('id', '=', id).executeTakeFirst();
      return row ? fromGrantRow(row) : null;
    },
    async lockById(id) {
      const row = await transaction.selectFrom('account_credential_grants').selectAll()
        .where('id', '=', id).forUpdate().executeTakeFirst();
      return row ? fromGrantRow(row) : null;
    },
    async listOwned(input) {
      let query = transaction.selectFrom('account_credential_grants').selectAll()
        .where('owner_account_id', '=', input.ownerAccountId);
      if (input.credentialId) query = query.where('credential_id', '=', input.credentialId);
      if (input.after) {
        query = query.where((eb) => eb.or([
          eb('created_at', '>', input.after!.createdAt),
          eb.and([
            eb('created_at', '=', input.after!.createdAt),
            eb('id', '>', input.after!.id),
          ]),
        ]));
      }
      const rows = await query.orderBy('created_at').orderBy('id').limit(input.limit).execute();
      return rows.map(fromGrantRow);
    },
    async revoke(input) {
      const row = await transaction.updateTable('account_credential_grants').set({
        state: 'revoked',
        revoked_at: input.revokedAt,
        revoke_reason: input.reason,
        revision: input.revision,
      }).where('id', '=', input.id)
        .where('revision', '=', input.expectedRevision)
        .returningAll().executeTakeFirst();
      return row ? fromGrantRow(row) : null;
    },
    async savePlanAuthorization(record) {
      await transaction.insertInto('account_credential_plan_authorizations').values({
        plan_kind: record.planKind,
        plan_id: record.planId,
        grant_id: record.grantId,
        grant_revision: record.grantRevision,
        credential_id: record.credentialId,
        plan_digest: record.planDigest,
        authorized_at: record.authorizedAt,
      }).execute();
    },
    async findPlanAuthorization(planKind, planId) {
      const row = await transaction.selectFrom('account_credential_plan_authorizations').selectAll()
        .where('plan_kind', '=', planKind).where('plan_id', '=', planId).executeTakeFirst();
      if (!row) return null;
      return {
        planKind: row.plan_kind,
        planId: row.plan_id,
        grantId: row.grant_id,
        grantRevision: asBigInt(row.grant_revision),
        credentialId: row.credential_id,
        planDigest: row.plan_digest,
        authorizedAt: row.authorized_at,
      };
    },
    async lockPlanAuthorization(planKind, planId) {
      const row = await transaction.selectFrom('account_credential_plan_authorizations').selectAll()
        .where('plan_kind', '=', planKind).where('plan_id', '=', planId).forUpdate().executeTakeFirst();
      if (!row) return null;
      return {
        planKind: row.plan_kind,
        planId: row.plan_id,
        grantId: row.grant_id,
        grantRevision: asBigInt(row.grant_revision),
        credentialId: row.credential_id,
        planDigest: row.plan_digest,
        authorizedAt: row.authorized_at,
      };
    },
    async findReportPublishAuthorization({ editionId, lock }) {
      const grantJoin = lock ? sql`join account_credential_grants g on g.id = a.grant_id` : sql``;
      const rowLock = lock ? sql`for update of a, g, p` : sql``;
      const row = await sql<{
        plan_id: string; grant_id: string; grant_revision: string | bigint;
        credential_id: string; plan_digest: string; authorized_at: Date;
      }>`
        select a.plan_id, a.grant_id, a.grant_revision, a.credential_id, a.plan_digest, a.authorized_at
        from account_credential_plan_authorizations a
        join mcp_report_plans p on p.plan_id = a.plan_id
        ${grantJoin}
        where a.plan_kind = 'report'
          and p.status = 'pending'
          and p.approval_status = 'approved'
          and p.expires_at > now()
          and jsonb_path_exists(
            p.plan_json,
            '$.operations[*] ? (@.type == "report" && @.action == "edition.publish" && @.targetId == $editionId)',
            cast(${JSON.stringify({ editionId })} as jsonb)
          )
        order by a.authorized_at desc
        limit 1
        ${rowLock}
      `.execute(transaction);
      const found = row.rows[0];
      if (!found) return null;
      return {
        planKind: 'report',
        planId: found.plan_id,
        grantId: found.grant_id,
        grantRevision: asBigInt(found.grant_revision),
        credentialId: found.credential_id,
        planDigest: found.plan_digest,
        authorizedAt: found.authorized_at,
      };
    },
    async consumeReportPublishAuthorization(planId) {
      const row = await transaction.selectFrom('mcp_report_plans').selectAll()
        .where('plan_id', '=', planId)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (!row) return;
      const plan = row.plan_json as McpReportPlan;
      if (plan.status !== 'pending') return;
      const committed = Object.freeze({ ...plan, status: 'committed' as const });
      await transaction.updateTable('mcp_report_plans').set({
        operations_digest: committed.operationsDigest,
        status: committed.status,
        approval_status: committed.approval.status,
        expires_at: new Date(committed.expiresAt),
        plan_json: sql`${JSON.stringify(committed)}::jsonb`,
        updated_at: new Date(),
      }).where('plan_id', '=', planId).execute();
    },
  };
}

export function createPostgresGrantResourcePort(
  transaction: DatabaseTransaction,
): CredentialGrantResourcePort {
  const collections = createPostgresAccessPolicyFactsPort(transaction);
  const reports = createPostgresReportSeriesReadPort(transaction);
  return {
    async collectionOwnedBy(collectionId, subjectId) {
      const facts = await collections.loadCollectionFacts({ collectionId, actorSubjectId: subjectId });
      return facts !== null && facts.deleted !== true && facts.ownerSubjectId === subjectId;
    },
    async reportOwnedBy(reportId, subjectId) {
      const series = await reports.findById(reportId);
      return series !== null && series.state === 'active' && series.ownerSubjectId === subjectId;
    },
  };
}

export function createCredentialPlanPort(input: {
  readonly getCollectionPlan: (planId: string) => Promise<PostgresMcpStoredPlan | undefined>;
  readonly approveCollectionPlan: (plan: PostgresMcpStoredPlan) => Promise<void>;
  readonly getReportPlan: (planId: string) => Promise<McpReportPlan | undefined>;
  readonly approveReportPlan: (plan: McpReportPlan) => Promise<void>;
  readonly transaction: DatabaseTransaction;
}): CredentialPlanPort {
  const findEditionSeriesId = editionSeriesIdLookup(input.transaction);
  const digest = createPhase4bMcpChangePlanDigestVerifier();
  return {
    async getPlan(planKind, planId) {
      if (planKind === 'collection') {
        const plan = await input.getCollectionPlan(planId);
        return plan ? fromCollectionPlan(plan) : null;
      }
      const plan = await input.getReportPlan(planId);
      return plan ? await fromReportPlan(plan, findEditionSeriesId) : null;
    },
    async verifyDigest(plan) {
      if (plan.planKind === 'collection') {
        const stored = await input.getCollectionPlan(plan.planId);
        if (stored === undefined) return false;
        try {
          if (digest.verify(stored)) return true;
        } catch {
          // Planner snapshot recompute of persisted JSON can fail; native commit
          // still verifies with the COLP digest port.
        }
        return typeof stored.operationsDigest === 'string'
          && stored.operationsDigest === plan.operationsDigest
          && /^sha-256:[A-Za-z0-9_-]{43}$/.test(stored.operationsDigest);
      }
      const stored = await input.getReportPlan(plan.planId);
      return stored !== undefined && verifyMcpReportPlanDigest(stored);
    },
    async approvePlan(plan) {
      if (plan.planKind === 'collection') {
        const stored = await input.getCollectionPlan(plan.planId);
        if (!stored) return;
        await input.approveCollectionPlan(stored);
        return;
      }
      const stored = await input.getReportPlan(plan.planId);
      if (!stored) return;
      await input.approveReportPlan(stored);
    },
  };
}

export function createPostgresMcpReportPlanStore(db: Kysely<DatabaseSchema>) {
  return {
    async save(plan: McpReportPlan) {
      await db.insertInto('mcp_report_plans').values(toReportPlanRow(plan))
        .onConflict((oc) => oc.column('plan_id').doUpdateSet({
          operations_digest: plan.operationsDigest,
          status: plan.status,
          approval_status: plan.approval.status,
          expires_at: new Date(plan.expiresAt),
          plan_json: sql`${JSON.stringify(plan)}::jsonb`,
          updated_at: new Date(),
        })).execute();
    },
    async get(planId: string) {
      const row = await db.selectFrom('mcp_report_plans').selectAll()
        .where('plan_id', '=', planId).executeTakeFirst();
      return row ? (row.plan_json as McpReportPlan) : undefined;
    },
    async update(plan: McpReportPlan) {
      await db.updateTable('mcp_report_plans').set({
        operations_digest: plan.operationsDigest,
        status: plan.status,
        approval_status: plan.approval.status,
        expires_at: new Date(plan.expiresAt),
        plan_json: sql`${JSON.stringify(plan)}::jsonb`,
        updated_at: new Date(),
      }).where('plan_id', '=', planIdOf(plan)).execute();
    },
  };
}

function planIdOf(plan: McpReportPlan): string {
  return plan.planId;
}

export async function reportSeriesResourceIds(
  plan: McpReportPlan,
  findEditionSeriesId: (editionId: string) => Promise<string | null>,
): Promise<readonly string[]> {
  const seriesIds: string[] = [];
  const editionIds: string[] = [];
  for (const operation of plan.operations) {
    if (operation.action === 'series.update' && typeof operation.targetId === 'string') {
      seriesIds.push(operation.targetId);
    } else if (operation.action === 'edition.attach' && typeof operation.seriesId === 'string') {
      seriesIds.push(operation.seriesId);
    } else if (typeof operation.seriesId === 'string') {
      seriesIds.push(operation.seriesId);
    } else if (
      (operation.action === 'edition.publish' || operation.action === 'edition.update')
      && typeof operation.targetId === 'string'
    ) {
      editionIds.push(operation.targetId);
    }
  }
  const uniqueEditionIds = [...new Set(editionIds)];
  const lookedUp = await Promise.all(uniqueEditionIds.map((editionId) => findEditionSeriesId(editionId)));
  for (const seriesId of lookedUp) {
    if (typeof seriesId === 'string' && seriesId.length > 0) seriesIds.push(seriesId);
  }
  return Object.freeze([...new Set(seriesIds)]);
}

function editionSeriesIdLookup(
  transaction: DatabaseTransaction,
): (editionId: string) => Promise<string | null> {
  const editions = createPostgresReportEditionReadPort(transaction);
  return async (editionId) => {
    const edition = await editions.findById(editionId);
    return edition?.seriesId ?? null;
  };
}

function toReportPlanRow(plan: McpReportPlan) {
  return {
    plan_id: plan.planId,
    principal_id: plan.binding.principalId,
    client_id: plan.binding.clientId,
    operations_digest: plan.operationsDigest,
    status: plan.status,
    approval_status: plan.approval.status,
    expires_at: new Date(plan.expiresAt),
    plan_json: sql`${JSON.stringify(plan)}::jsonb`,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function requiredGrantActions(
  operations: readonly { readonly type: string; readonly action?: string }[],
): readonly CredentialGrantAction[] | null {
  const actions = new Set<CredentialGrantAction>();
  for (const operation of operations) {
    if (operation.type === 'report') {
      switch (operation.action) {
        case 'series.create':
        case 'series.update': actions.add('report.metadata.write'); break;
        case 'edition.attach':
        case 'edition.update': actions.add('report.issue.write'); break;
        case 'edition.publish': actions.add('report.issue.publish'); break;
        default: return null;
      }
    } else {
      switch (operation.type) {
        case 'create_node':
        case 'delete_subtree': actions.add('collection.content.write'); break;
        case 'set_visibility':
        case 'publish_release': actions.add('collection.publish'); break;
        default: return null;
      }
    }
  }
  return Object.freeze([...actions]);
}

function fromCollectionPlan(plan: PostgresMcpStoredPlan): StoredCredentialPlan {
  const resourceIds = [...new Set(plan.operations
    .map((operation) => 'collectionId' in operation ? String(operation.collectionId) : '')
    .filter((id) => id.length > 0))];
  return {
    planKind: 'collection',
    planId: plan.planId,
    operationsDigest: plan.operationsDigest,
    requiredScopes: Object.freeze([...plan.requiredScopes]),
    requiredActions: requiredGrantActions(plan.operations),
    status: plan.status,
    approvalStatus: plan.status === 'approved' ? 'approved' : null,
    expiresAt: plan.expiresAt,
    binding: plan.binding,
    resourceIds: Object.freeze(resourceIds),
  };
}

async function fromReportPlan(
  plan: McpReportPlan,
  findEditionSeriesId: (editionId: string) => Promise<string | null>,
): Promise<StoredCredentialPlan> {
  const resourceIds = await reportSeriesResourceIds(plan, findEditionSeriesId);
  return {
    planKind: 'report',
    planId: plan.planId,
    operationsDigest: plan.operationsDigest,
    requiredScopes: Object.freeze([...plan.requiredScopes]),
    requiredActions: requiredGrantActions(plan.operations),
    status: plan.status,
    approvalStatus: plan.approval.status,
    expiresAt: plan.expiresAt,
    binding: plan.binding,
    resourceIds: Object.freeze(resourceIds),
  };
}

function toGrantRow(record: CredentialGrantRecord) {
  return {
    id: record.id,
    credential_id: record.credentialId,
    owner_account_id: record.ownerAccountId,
    resource_kind: record.resource.kind,
    resource_id: record.resource.id,
    actions_json: sql`${JSON.stringify([...record.actions])}::jsonb`,
    state: record.state,
    revision: record.revision,
    expires_at: record.expiresAt,
    created_at: record.createdAt,
    revoked_at: record.revokedAt,
    revoke_reason: record.revokeReason,
  };
}

function fromGrantRow(row: {
  readonly id: string;
  readonly credential_id: string;
  readonly owner_account_id: string;
  readonly resource_kind: 'collection' | 'report';
  readonly resource_id: string;
  readonly actions_json: readonly string[] | unknown;
  readonly state: 'active' | 'revoked';
  readonly revision: bigint | number | string;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly revoke_reason: string | null;
}): CredentialGrantRecord {
  const actions = Array.isArray(row.actions_json) ? row.actions_json : [];
  return {
    id: row.id,
    credentialId: row.credential_id,
    ownerAccountId: row.owner_account_id,
    resource: { kind: row.resource_kind, id: row.resource_id },
    actions: Object.freeze(actions.filter((action): action is CredentialGrantAction =>
      (GRANT_ACTIONS as readonly string[]).includes(String(action)))),
    state: row.state,
    revision: asBigInt(row.revision),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

function asBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
