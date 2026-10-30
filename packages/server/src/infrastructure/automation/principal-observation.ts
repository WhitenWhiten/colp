import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { WorkPrincipal } from '../../modules/automation/index.js';
/** Persist only verified token-free binding evidence, never a raw request or bearer. */
export function principalObservation(actor:WorkPrincipal){
  return {accountId:actor.accountId,subjectId:actor.subjectId,clientId:actor.clientId,credentialBindingId:actor.credentialBindingId,
    resourceAudience:actor.resourceAudience ?? null,securityEpoch:actor.securityEpoch ?? null,scopes:[...actor.scopes],
    credentialDigest:actor.credentialDigest ?? null,expiresAt:actor.expiresAt ?? null,issuedAtSeconds:actor.issuedAtSeconds ?? null,
    accountSecurityEpoch:actor.accountSecurityEpoch ?? null};
}

// A database sequence orders live observations across processes and clock skew. Freeze it
// on the first authority check, before webhook verification leaves the transaction.
const arrivals = new WeakMap<WorkPrincipal, Promise<string>>();
export function observationArrival(tx: DatabaseTransaction, actor: WorkPrincipal): Promise<string> {
  let order = arrivals.get(actor);
  if (!order) {
    order = sql<{ n: string }>`SELECT nextval('automation_credential_observation_order')::text AS n`.execute(tx).then(r => r.rows[0]!.n);
    arrivals.set(actor, order);
  }
  return order;
}

/** Shared monotone update: issuance first, expiry second, request arrival for same-second renewals. */
export async function refreshPrincipalObservation(tx: DatabaseTransaction,
  profileId: string, actor: WorkPrincipal): Promise<void> {
  if (!actor.credentialDigest || !actor.expiresAt) return;
  const arrival = await observationArrival(tx, actor);
  await sql`UPDATE automation_connection_profiles
    SET observation_json=${JSON.stringify({ ...principalObservation(actor), observedOrder: arrival })}::jsonb
    WHERE id=${profileId}
      AND (observation_json IS NULL OR observation_json->>'credentialDigest' IS DISTINCT FROM ${actor.credentialDigest})
      AND (observation_json IS NULL OR
        (coalesce((observation_json->>'issuedAtSeconds')::bigint,0),
         coalesce((observation_json->>'expiresAt')::timestamptz,'-infinity'::timestamptz),
         coalesce((observation_json->>'observedOrder')::bigint,0))
        < (${actor.issuedAtSeconds ?? 0}::bigint,${actor.expiresAt}::timestamptz,${arrival}::bigint))`.execute(tx);
}
