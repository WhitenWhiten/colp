/**
 * E5 current-account agent list, MCP audit, and revoke.
 * OAuth clients come from the issuer tables. API keys are child account
 * credentials. A missing agent_policies row is manual.
 */
import { sql, type Kysely } from 'kysely';
import { digestMcpOauthRevocationField } from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/index.js';

const AGENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const MAX_LIMIT = 100;

const GRANT_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'collection.content.write': Object.freeze(['nodes:write']),
  'collection.publish': Object.freeze(['access:write']),
  'report.metadata.write': Object.freeze(['reports:write']),
  'report.issue.write': Object.freeze(['reports:write']),
  'report.issue.publish': Object.freeze(['reports:write', 'reports:publish']),
  'report.issue.withdraw': Object.freeze(['reports:write']),
});

export type AgentKind = 'oauth_client' | 'api_key';
export type AgentPolicyName = 'manual' | 'trusted';
export type AgentAuditKind = 'plan' | 'direct_write';

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly policy: AgentPolicyName;
}

export interface AgentAuditRecord {
  readonly id: string;
  readonly kind: AgentAuditKind;
  readonly createdAt: string;
  readonly summary?: string;
  readonly outcome: string;
  readonly versionId: string | null;
}

export interface AgentRevokeResult {
  readonly id: string;
  readonly revoked: true;
  readonly cancelledPlanCount: number;
}

type Executor = Kysely<DatabaseSchema>;

interface OwnedAgent {
  /** The caller owns the OAuth registration (and may revoke it globally). */
  readonly oauthOwner: boolean;
  /** The caller has a consent row (and may revoke only that consent). */
  readonly oauthConsent: boolean;
  readonly oauthUserId: string | null;
  readonly credentialId: string | null;
  readonly credentialActive: boolean;
}

export function createAgentDirectoryApi(db: Kysely<DatabaseSchema>) {
  return Object.freeze({
    list(accountId: string) {
      return listAgents(db, accountId);
    },
    audit(accountId: string, agentId: string, limit: number) {
      return listAgentAudit(db, accountId, agentId, limit);
    },
    revoke(accountId: string, agentId: string) {
      return revokeAgent(db, accountId, agentId);
    },
  });
}

async function listAgents(
  db: Executor,
  accountId: string,
): Promise<{ readonly agents: readonly AgentSummary[] }> {
  const oauth = await sql<{
    id: string;
    name: string;
    scopes_json: unknown;
    created_at: Date | string;
    last_seen_at: Date | string | null;
    policy: string;
  }>`
    SELECT DISTINCT ON (c."clientId")
      c."clientId" AS id,
      COALESCE(NULLIF(btrim(c.name), ''), c."clientId") AS name,
      COALESCE((
        SELECT consent.scopes
        FROM "auth_oauth_consent" consent
        WHERE consent."clientId" = c."clientId" AND consent."userId" = m.auth_user_id
        ORDER BY consent."updatedAt" DESC
        LIMIT 1
      ), c.scopes) AS scopes_json,
      COALESCE(c."createdAt", c."updatedAt", current_timestamp) AS created_at,
      GREATEST(
        (SELECT max(token."createdAt") FROM "auth_oauth_access_token" token
          WHERE token."clientId" = c."clientId"),
        (SELECT max(token."createdAt") FROM "auth_oauth_refresh_token" token
          WHERE token."clientId" = c."clientId")
      ) AS last_seen_at,
      COALESCE(p.policy, 'manual') AS policy
    FROM auth_user_account_map m
    JOIN "auth_oauth_client" c
      ON c."userId" = m.auth_user_id
      OR EXISTS (
        SELECT 1 FROM "auth_oauth_consent" consent
        WHERE consent."clientId" = c."clientId" AND consent."userId" = m.auth_user_id
      )
    LEFT JOIN agent_policies p ON p.client_id = c."clientId" AND p.principal_id = ${accountId}
    WHERE m.account_id = ${accountId}
      AND c.disabled IS DISTINCT FROM true
    ORDER BY c."clientId"
  `.execute(db);
  const keys = await sql<{
    id: string;
    credential_id: string;
    name: string;
    created_at: Date | string;
    last_seen_at: Date | string | null;
    policy: string;
  }>`
    SELECT cred.mcp_client_id AS id,
           cred.id AS credential_id,
           cred.label AS name,
           cred.created_at,
           cred.last_used_at AS last_seen_at,
           COALESCE(p.policy, 'manual') AS policy
    FROM account_credentials cred
    LEFT JOIN agent_policies p ON p.client_id = cred.mcp_client_id AND p.principal_id = ${accountId}
    WHERE cred.manager_account_id = ${accountId}
      AND cred.kind = 'child'
      AND cred.state = 'active'
      AND cred.expires_at > current_timestamp
  `.execute(db);
  const grantScopes = await scopesByCredential(db, keys.rows.map((row) => row.credential_id));
  const agents: AgentSummary[] = [];
  const seen = new Set<string>();
  for (const row of oauth.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    agents.push({
      id: row.id,
      name: clip(row.name, 256) || row.id,
      kind: 'oauth_client',
      scopes: stringList(row.scopes_json),
      createdAt: requiredIso(row.created_at),
      lastSeenAt: optionalIso(row.last_seen_at),
      policy: policyName(row.policy),
    });
  }
  for (const row of keys.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    agents.push({
      id: row.id,
      name: clip(row.name, 256) || row.id,
      kind: 'api_key',
      scopes: grantScopes.get(row.credential_id) ?? [],
      createdAt: requiredIso(row.created_at),
      lastSeenAt: optionalIso(row.last_seen_at),
      policy: policyName(row.policy),
    });
  }
  agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return { agents };
}

async function listAgentAudit(
  db: Executor,
  accountId: string,
  agentId: string,
  limit: number,
): Promise<{ readonly records: readonly AgentAuditRecord[] } | undefined> {
  assertAgentId(agentId);
  const bounded = boundLimit(limit);
  const owned = await findOwned(db, accountId, agentId, true);
  if (!owned.oauthOwner && !owned.oauthConsent && owned.credentialId === null) return undefined;
  const plans = await sql<{
    plan_id: string;
    status: string;
    summary: string;
    created_at: Date | string;
    receipt_version_id: string | null;
    audit_version_id: string | null;
    tree_version_id: string | null;
  }>`
    SELECT plan.plan_id, plan.status, plan.summary, plan.created_at,
           receipt.version_id AS receipt_version_id,
           (
             SELECT payload.details_json->>'versionId'
             FROM audit_events event
             JOIN audit_event_payloads payload ON payload.event_id = event.id
             WHERE event.event_type = 'mcp.approval_decision'
               AND event.principal_id = plan.principal_id
               AND payload.details_json->>'planId' = plan.plan_id
             ORDER BY event.created_at DESC, event.id DESC
             LIMIT 1
           ) AS audit_version_id,
           (
             SELECT version.version_id
             FROM collection_tree_versions version
             WHERE version.account_id = plan.principal_id
               AND version.cause = 'agent-plan:' || plan.plan_id
             ORDER BY version.created_at DESC
             LIMIT 1
           ) AS tree_version_id
    FROM mcp_change_plans plan
    LEFT JOIN mcp_plan_policy_receipts receipt ON receipt.plan_id = plan.plan_id
    WHERE plan.client_id = ${agentId}
      AND plan.principal_id = ${accountId}
    ORDER BY plan.created_at DESC, plan.plan_id DESC
    LIMIT ${bounded}
  `.execute(db);
  const writes = await sql<{
    id: string;
    created_at: Date | string;
    event_type: string;
    details_json: unknown;
  }>`
    SELECT event.id::text AS id, event.created_at, event.event_type, payload.details_json
    FROM audit_events event
    JOIN audit_event_payloads payload ON payload.event_id = event.id
    WHERE event.principal_id = ${accountId}
      AND event.event_type LIKE 'mcp.%'
      AND event.event_type <> 'mcp.approval_decision'
      AND (
        payload.details_json->>'clientId' = ${agentId}
        OR payload.details_json->>'client_id' = ${agentId}
      )
    ORDER BY event.created_at DESC, event.id DESC
    LIMIT ${bounded}
  `.execute(db);
  const records: AgentAuditRecord[] = [
    ...plans.rows.map((row) => ({
      id: row.plan_id,
      kind: 'plan' as const,
      createdAt: requiredIso(row.created_at),
      summary: clip(row.summary, 512),
      outcome: clip(row.status, 64) || 'pending',
      versionId: firstVersion(row.receipt_version_id, row.audit_version_id, row.tree_version_id),
    })),
    ...writes.rows.map((row) => directWriteRecord(row)),
  ];
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return { records: records.slice(0, bounded) };
}

async function revokeAgent(
  db: Executor,
  accountId: string,
  agentId: string,
): Promise<AgentRevokeResult | undefined> {
  assertAgentId(agentId);
  return db.transaction().execute(async (transaction) => {
    const owned = await findOwned(transaction, accountId, agentId, true);
    if (!owned.oauthOwner && !owned.oauthConsent && owned.credentialId === null) return undefined;
    if (owned.oauthOwner) {
      await sql`
        UPDATE "auth_oauth_client"
        SET disabled = true, "updatedAt" = current_timestamp
        WHERE "clientId" = ${agentId}
      `.execute(transaction);
      await sql`
        UPDATE "auth_oauth_access_token"
        SET revoked = current_timestamp
        WHERE "clientId" = ${agentId} AND revoked IS NULL
      `.execute(transaction);
      await sql`
        UPDATE "auth_oauth_refresh_token"
        SET revoked = current_timestamp
        WHERE "clientId" = ${agentId} AND revoked IS NULL
      `.execute(transaction);
    } else if (owned.oauthConsent && owned.oauthUserId !== null) {
      // A consent row grants this account access to the client, but does not
      // make the caller an owner. Unlink only this user's consent and tokens;
      // disabling the client or revoking another user's tokens requires the
      // registration owner (or an explicit admin path).
      await sql`
        DELETE FROM "auth_oauth_consent"
        WHERE "clientId" = ${agentId} AND "userId" = ${owned.oauthUserId}
      `.execute(transaction);
      await sql`
        UPDATE "auth_oauth_access_token"
        SET revoked = current_timestamp
        WHERE "clientId" = ${agentId}
          AND "userId" = ${owned.oauthUserId}
          AND revoked IS NULL
      `.execute(transaction);
      await sql`
        UPDATE "auth_oauth_refresh_token"
        SET revoked = current_timestamp
        WHERE "clientId" = ${agentId}
          AND "userId" = ${owned.oauthUserId}
          AND revoked IS NULL
      `.execute(transaction);
      // MCP bearer verification is independent from Better Auth's token
      // endpoint and therefore cannot observe the BA `revoked` timestamp.
      // A client-wide revocation would incorrectly retire the registration
      // owner's credentials too, so persist a subject-scoped digest for this
      // consenting user. The verifier rejects bearers issued at or before
      // revoked_at on every request; a repeated revocation after a re-consent
      // must therefore move the boundary forward, never keep the old one.
      await sql`
        INSERT INTO mcp_oauth_subject_revocations (client_id_digest, subject_digest, revoked_at)
        VALUES (${digestMcpOauthRevocationField(agentId)},
                ${digestMcpOauthRevocationField(owned.oauthUserId)}, current_timestamp)
        ON CONFLICT (client_id_digest, subject_digest)
        DO UPDATE SET revoked_at = greatest(mcp_oauth_subject_revocations.revoked_at, excluded.revoked_at)
      `.execute(transaction);
    }
    if (owned.credentialId !== null && owned.credentialActive) {
      await sql`
        UPDATE account_credentials
        SET state = 'revoked',
            revoked_at = current_timestamp,
            revoke_reason = 'agent revoked',
            revision = revision + 1
        WHERE id = ${owned.credentialId}
          AND state = 'active'
      `.execute(transaction);
    }
    if (owned.oauthOwner || owned.credentialId !== null) {
      const digest = digestMcpOauthRevocationField(agentId);
      await sql`
        INSERT INTO mcp_oauth_client_revocations (client_id_digest, revoked_at)
        VALUES (${digest}, current_timestamp)
        ON CONFLICT (client_id_digest) DO NOTHING
      `.execute(transaction);
    }
    const cancelled = await sql<{ plan_id: string }>`
      UPDATE mcp_change_plans
      SET status = 'cancelled', updated_at = current_timestamp
      WHERE client_id = ${agentId}
        AND principal_id = ${accountId}
        AND status IN ('pending', 'approved')
      RETURNING plan_id
    `.execute(transaction);
    return {
      id: agentId,
      revoked: true,
      cancelledPlanCount: cancelled.rows.length,
    };
  });
}

async function findOwned(
  db: Executor,
  accountId: string,
  agentId: string,
  includeInactive: boolean,
): Promise<OwnedAgent> {
  const oauth = await sql<{ user_id: string }>`
    SELECT m.auth_user_id AS user_id
    FROM auth_user_account_map m
    JOIN "auth_oauth_client" c
      ON c."clientId" = ${agentId}
      AND c."userId" = m.auth_user_id
    WHERE m.account_id = ${accountId}
      AND (${includeInactive} OR c.disabled IS DISTINCT FROM true)
    LIMIT 1
  `.execute(db);
  const consent = await sql<{ user_id: string }>`
    SELECT consent."userId" AS user_id
    FROM auth_user_account_map m
    JOIN "auth_oauth_consent" consent
      ON consent."clientId" = ${agentId}
      AND consent."userId" = m.auth_user_id
    JOIN "auth_oauth_client" c ON c."clientId" = consent."clientId"
    WHERE m.account_id = ${accountId}
      AND (${includeInactive} OR c.disabled IS DISTINCT FROM true)
    LIMIT 1
  `.execute(db);
  const oauthOwner = oauth.rows.length > 0;
  const oauthUserId = oauth.rows[0]?.user_id ?? consent.rows[0]?.user_id ?? null;
  const key = await sql<{ id: string; state: string; expired: boolean }>`
    SELECT id, state, expires_at <= current_timestamp AS expired
    FROM account_credentials
    WHERE mcp_client_id = ${agentId}
      AND manager_account_id = ${accountId}
      AND kind = 'child'
    LIMIT 1
  `.execute(db);
  const credential = key.rows[0];
  const active = credential !== undefined && credential.state === 'active' && credential.expired !== true;
  if (!includeInactive && credential !== undefined && !active) {
    return {
      oauthOwner,
      oauthConsent: consent.rows.length > 0,
      oauthUserId,
      credentialId: null,
      credentialActive: false,
    };
  }
  return {
    oauthOwner,
    oauthConsent: consent.rows.length > 0,
    oauthUserId,
    credentialId: credential?.id ?? null,
    credentialActive: active,
  };
}

async function scopesByCredential(
  db: Executor,
  credentialIds: readonly string[],
): Promise<Map<string, readonly string[]>> {
  const scopes = new Map<string, Set<string>>();
  if (credentialIds.length === 0) return new Map();
  const rows = await sql<{ credential_id: string; actions_json: unknown }>`
    SELECT credential_id, actions_json
    FROM account_credential_grants
    WHERE credential_id IN (${sql.join(credentialIds.map((id) => sql`${id}`))})
      AND state = 'active'
      AND expires_at > current_timestamp
  `.execute(db);
  for (const row of rows.rows) {
    const bucket = scopes.get(row.credential_id) ?? new Set<string>();
    for (const action of stringList(row.actions_json)) {
      for (const scope of GRANT_SCOPES[action] ?? []) bucket.add(scope);
    }
    scopes.set(row.credential_id, bucket);
  }
  return new Map([...scopes].map(([id, values]) => [id, [...values].sort()]));
}

function directWriteRecord(row: {
  readonly id: string;
  readonly created_at: Date | string;
  readonly event_type: string;
  readonly details_json: unknown;
}): AgentAuditRecord {
  const details = isRecord(row.details_json) ? row.details_json : {};
  const summary = typeof details.summary === 'string' ? clip(details.summary, 512) : row.event_type;
  const outcome = typeof details.outcome === 'string' && details.outcome.length > 0
    ? clip(details.outcome, 64)
    : typeof details.status === 'string' && details.status.length > 0
      ? clip(details.status, 64)
      : 'recorded';
  const version = typeof details.versionId === 'string' ? details.versionId : null;
  return {
    id: row.id,
    kind: 'direct_write',
    createdAt: requiredIso(row.created_at),
    ...(summary.length > 0 ? { summary } : {}),
    outcome: outcome || 'recorded',
    versionId: version && version.length <= 128 ? version : null,
  };
}

function firstVersion(...values: readonly (string | null)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  }
  return null;
}

function policyName(value: string): AgentPolicyName {
  return value === 'trusted' ? 'trusted' : 'manual';
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) throw new TypeError('Agent id is invalid.');
}

function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError('Agent audit limit is invalid.');
  }
  return limit;
}

function stringList(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/u)
      : [];
  const unique = new Set<string>();
  for (const item of source) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 128) unique.add(item);
  }
  return [...unique].sort().slice(0, 64);
}

function requiredIso(value: Date | string): string {
  return optionalIso(value) ?? new Date(0).toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
