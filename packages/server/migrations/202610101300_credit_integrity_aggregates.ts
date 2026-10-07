import { sql, type Kysely } from 'kysely';
import { currentSchema, qualified, quoteIdentifier } from './lib/classification-credits-schema.js';

/** Aggregate each account history once instead of rescanning it per charge. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION ${qualified(schema, 'credit_integrity_issues')}(p_account_id text)
    RETURNS TABLE(issue_code text, issue_count bigint) LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,${quoteIdentifier(schema)} AS $function$
WITH g AS MATERIALIZED (SELECT * FROM credit_grants WHERE account_id=p_account_id),
c AS MATERIALIZED (SELECT * FROM credit_charges WHERE account_id=p_account_id),
a AS MATERIALIZED (SELECT * FROM credit_allocations WHERE account_id=p_account_id),
e AS MATERIALIZED (SELECT * FROM credit_ledger_entries WHERE account_id=p_account_id),
grant_allocations AS (
  SELECT a.grant_id,
    sum(a.amount) FILTER (WHERE c.state='reserved') AS reserved,
    sum(a.amount) FILTER (WHERE c.state='settled') AS spent,
    sum(a.amount) FILTER (WHERE c.state='released' AND g.expires_at<=c.completed_at) AS released_expired
  FROM a JOIN c ON c.id=a.charge_id JOIN g ON g.id=a.grant_id GROUP BY a.grant_id
),
grant_entries AS (
  SELECT grant_id,
    sum(expired_points) FILTER (WHERE kind='expire') AS expired,
    count(*) FILTER (WHERE kind IN ('grant','refund','topup')) AS funding_count,
    sum(points_delta) FILTER (WHERE kind IN ('grant','refund','topup')) AS funding_amount
  FROM e WHERE grant_id IS NOT NULL GROUP BY grant_id
),
charge_allocations AS (SELECT charge_id,sum(amount) AS amount FROM a GROUP BY charge_id),
charge_entries AS MATERIALIZED (
  SELECT c.id AS charge_id,
    count(*) FILTER (WHERE e.kind='reserve') AS reserve_count,
    count(*) FILTER (WHERE e.kind='reserve' AND e.points_delta=0
      AND e.available_delta=-c.quoted_amount AND e.reserved_delta=c.quoted_amount) AS valid_reserve_count,
    count(*) FILTER (WHERE e.kind IN ('spend','release')) AS terminal_count,
    bool_or(e.kind='spend' AND e.points_delta=-c.settled_amount
      AND e.available_delta=0 AND e.reserved_delta=-c.quoted_amount) AS valid_spend,
    bool_or(e.kind='release' AND e.reserved_delta=-c.quoted_amount
      AND e.points_delta=-e.expired_points) AS valid_release,
    bool_or(e.kind='release' AND e.reason_code='classification_unneeded') AS unneeded_release,
    sum(e.points_delta) FILTER (WHERE e.kind='refund') AS refunded
  FROM c JOIN e ON e.charge_id=c.id GROUP BY c.id
),
executions AS MATERIALIZED (SELECT * FROM classification_provider_executions WHERE principal_id=p_account_id),
successful_executions AS MATERIALIZED (
  SELECT DISTINCT ca.execution_id FROM classification_call_attempts ca
  JOIN executions x ON x.id=ca.execution_id WHERE ca.state='succeeded'
),
successful_action_commands AS (
  SELECT DISTINCT x.command_id FROM executions x JOIN successful_executions s ON s.execution_id=x.id
  WHERE x.command_scope='collections:classification-run-action:v1'
),
preview_owners AS MATERIALIZED (
  SELECT c.id AS charge_id,x.id AS execution_id,x.state
  FROM c JOIN executions x ON x.id=c.task_id AND x.credit_charge_id=c.id AND x.billing_owner_kind='execution'
  WHERE c.task_kind='classification_preview'
),
action_owners AS MATERIALIZED (
  SELECT c.id AS charge_id,x.action_id,x.status,x.execution_command_id
  FROM c JOIN collection_classification_run_actions x ON x.credit_charge_id=c.id
  JOIN collection_classification_runs r ON r.id=x.run_id AND r.principal_id=p_account_id
  WHERE c.task_kind='classification_action'
),
chain AS (
  SELECT *,lag(sequence,1,0::bigint) OVER w AS previous_sequence,
    lag(available_after,1,0::bigint) OVER w AS previous_available,
    lag(reserved_after,1,0::bigint) OVER w AS previous_reserved
  FROM e WINDOW w AS (ORDER BY sequence)
),
issues AS (
  SELECT 'grant_counters'::text AS code,count(*) AS n FROM g
    LEFT JOIN grant_allocations a ON a.grant_id=g.id LEFT JOIN grant_entries e ON e.grant_id=g.id
    WHERE g.reserved_amount<>coalesce(a.reserved,0) OR g.spent_amount<>coalesce(a.spent,0)
      OR g.expired_amount<>coalesce(e.expired,0)+coalesce(a.released_expired,0)
  UNION ALL SELECT 'grant_funding',count(*) FROM g LEFT JOIN grant_entries e ON e.grant_id=g.id
    WHERE coalesce(e.funding_count,0)<>1 OR g.amount<>coalesce(e.funding_amount,0)
  UNION ALL SELECT 'charge_allocations',count(*) FROM c LEFT JOIN charge_allocations a ON a.charge_id=c.id
    WHERE c.quoted_amount<>coalesce(a.amount,0)
  UNION ALL SELECT 'charge_ledger',count(*) FROM c LEFT JOIN charge_entries e ON e.charge_id=c.id
    WHERE coalesce(e.reserve_count,0)<>1 OR coalesce(e.valid_reserve_count,0)<>1
      OR coalesce(e.terminal_count,0)<>CASE WHEN c.state='reserved' THEN 0 ELSE 1 END
      OR (c.state='settled' AND NOT coalesce(e.valid_spend,false))
      OR (c.state='released' AND NOT coalesce(e.valid_release,false))
  UNION ALL SELECT 'charge_refunds',count(*) FROM c LEFT JOIN charge_entries e ON e.charge_id=c.id
    WHERE c.refunded_amount<>coalesce(e.refunded,0)
  UNION ALL SELECT 'ledger_chain',count(*) FROM chain WHERE sequence<>previous_sequence+1
    OR available_after<>previous_available+available_delta OR reserved_after<>previous_reserved+reserved_delta
    OR points_delta<>available_delta+reserved_delta
  UNION ALL SELECT 'ledger_head',count(*) FROM credit_accounts WHERE account_id=p_account_id AND
    (last_sequence<>coalesce((SELECT max(sequence) FROM e),0)
    OR coalesce((SELECT available_after FROM e ORDER BY sequence DESC LIMIT 1),0)<>coalesce((SELECT sum(amount-reserved_amount-spent_amount-expired_amount) FROM g),0)
    OR coalesce((SELECT reserved_after FROM e ORDER BY sequence DESC LIMIT 1),0)<>coalesce((SELECT sum(reserved_amount) FROM g),0))
  UNION ALL SELECT 'orphan_hold',count(*) FROM c
    LEFT JOIN preview_owners p ON p.charge_id=c.id
    LEFT JOIN action_owners a ON a.charge_id=c.id AND a.action_id=c.task_id
    WHERE c.state='reserved' AND ((c.task_kind='classification_preview' AND p.charge_id IS NULL)
      OR (c.task_kind='classification_action' AND a.charge_id IS NULL))
  UNION ALL SELECT 'preview_terminal',count(*) FROM c JOIN preview_owners p ON p.charge_id=c.id
    LEFT JOIN charge_entries e ON e.charge_id=c.id LEFT JOIN successful_executions s ON s.execution_id=p.execution_id
    WHERE (p.state IN ('pending','running') AND c.state<>'reserved')
      OR (p.state IN ('failed','outcome_unknown') AND c.state<>'released')
      OR (p.state='succeeded' AND c.state<>'settled'
        AND NOT (c.state='released' AND coalesce(e.unneeded_release,false) AND s.execution_id IS NULL))
  UNION ALL SELECT 'action_terminal',count(*) FROM c JOIN action_owners a ON a.charge_id=c.id
    LEFT JOIN charge_entries e ON e.charge_id=c.id LEFT JOIN successful_action_commands s ON s.command_id=a.execution_command_id
    WHERE (a.status IN ('pending','running') AND c.state<>'reserved')
      OR (a.status='failed' AND c.state<>'released')
      OR (a.status='succeeded' AND c.state<>'settled'
        AND NOT (c.state='released' AND coalesce(e.unneeded_release,false) AND s.command_id IS NULL))
)
SELECT code,n FROM issues WHERE n>0
    $function$`).execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${qualified(schema, 'credit_integrity_issues')}(text) FROM PUBLIC`).execute(db);
}

/** The equivalent, faster integrity checks remain installed on application rollback. */
export async function down(): Promise<void> {}
