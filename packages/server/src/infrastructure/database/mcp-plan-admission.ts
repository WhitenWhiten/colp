import { McpChangePlanError } from '@know-n/colp/mcp';
import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';

export interface McpPendingPlanLimits {
  readonly maxPendingPerPrincipal: number;
  readonly maxPendingPerClient: number;
}

export function pendingMcpPlanLimits(options: Partial<McpPendingPlanLimits> = {}): McpPendingPlanLimits {
  const limits = { maxPendingPerPrincipal: options.maxPendingPerPrincipal ?? 100,
    maxPendingPerClient: options.maxPendingPerClient ?? 20 };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError('MCP pending-plan limits must be integers from 1 to 10000.');
  }
  return Object.freeze(limits);
}

/** Count and insertion share this transaction and principal lock across server instances. */
export async function admitPendingMcpPlan(tx: DatabaseTransaction, plan: {
  readonly principal_id: string; readonly client_id: string; readonly status: string; readonly expires_at: string;
}, limits: McpPendingPlanLimits): Promise<void> {
  if (!['pending', 'approved', 'committing'].includes(plan.status)) return;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-pending-plan:${plan.principal_id}`}, 0))`.execute(tx);
  const counts = await sql<{ principal_count: number; client_count: number }>`
    SELECT count(*)::integer AS principal_count,
      count(*) FILTER (WHERE client_id = ${plan.client_id})::integer AS client_count
    FROM mcp_change_plans
    WHERE principal_id = ${plan.principal_id}
      AND status IN ('pending', 'approved', 'committing')
      AND expires_at > current_timestamp
      AND ${plan.expires_at}::timestamptz > current_timestamp
  `.execute(tx);
  const count = counts.rows[0]!;
  if (count.principal_count >= limits.maxPendingPerPrincipal || count.client_count >= limits.maxPendingPerClient) {
    throw new McpChangePlanError('rate_limited', 'Pending plan capacity is full. Review or cancel earlier plans before creating more.');
  }
}
