import { installCreditOrphanRepair } from './lib/classification-credit-orphan-repair.js';
import { sql, type Kysely } from 'kysely';
import { currentSchema, qualified, quoteIdentifier } from './lib/classification-credits-schema.js';
import { installCreditMutationGuard } from './lib/classification-credit-mutation-guard.js';

/** A detected discrepancy blocks only new charges; existing owners can still finish. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  await installCreditOrphanRepair(db, schema);
  const q = (name: string) => qualified(schema, name);
  const settings = `SET search_path=pg_catalog,${quoteIdentifier(schema)}`;
  await sql`ALTER TABLE credit_accounts ADD COLUMN integrity_blocked boolean NOT NULL DEFAULT false,
    ADD COLUMN integrity_issue_count bigint NOT NULL DEFAULT 0 CHECK(integrity_issue_count>=0)`.execute(db);
  await installCreditMutationGuard(db, schema);
  await sql.raw(`CREATE FUNCTION ${q('credit_integrity_issues')}(p_account_id text)
    RETURNS TABLE(issue_code text, issue_count bigint) LANGUAGE sql STABLE SECURITY DEFINER ${settings} AS $function$
    WITH g AS (SELECT * FROM credit_grants WHERE account_id=p_account_id),
    c AS (SELECT * FROM credit_charges WHERE account_id=p_account_id),
    a AS (SELECT * FROM credit_allocations WHERE account_id=p_account_id),
    e AS (SELECT * FROM credit_ledger_entries WHERE account_id=p_account_id),
    chain AS (SELECT *,lag(sequence,1,0::bigint) OVER w AS previous_sequence,
      lag(available_after,1,0::bigint) OVER w AS previous_available,
      lag(reserved_after,1,0::bigint) OVER w AS previous_reserved FROM e WINDOW w AS (ORDER BY sequence)),
    issues AS (
      SELECT 'grant_counters'::text AS code,count(*) AS n FROM g WHERE
        reserved_amount<>coalesce((SELECT sum(a.amount) FROM a JOIN c ON c.id=a.charge_id WHERE a.grant_id=g.id AND c.state='reserved'),0)
        OR spent_amount<>coalesce((SELECT sum(a.amount) FROM a JOIN c ON c.id=a.charge_id WHERE a.grant_id=g.id AND c.state='settled'),0)
        OR expired_amount<>coalesce((SELECT sum(expired_points) FROM e WHERE grant_id=g.id AND kind='expire'),0)
          +coalesce((SELECT sum(a.amount) FROM a JOIN c ON c.id=a.charge_id
            WHERE a.grant_id=g.id AND c.state='released' AND g.expires_at<=c.completed_at),0)
      UNION ALL SELECT 'grant_funding',count(*) FROM g WHERE
        (SELECT count(*) FROM e WHERE grant_id=g.id AND kind IN ('grant','refund','topup'))<>1
        OR amount<>coalesce((SELECT sum(points_delta) FROM e WHERE grant_id=g.id AND kind IN ('grant','refund','topup')),0)
      UNION ALL SELECT 'charge_allocations',count(*) FROM c WHERE quoted_amount<>coalesce((SELECT sum(amount) FROM a WHERE charge_id=c.id),0)
      UNION ALL SELECT 'charge_ledger',count(*) FROM c WHERE
        (SELECT count(*) FROM e WHERE charge_id=c.id AND kind='reserve')<>1
        OR (SELECT count(*) FROM e WHERE charge_id=c.id AND kind='reserve' AND points_delta=0
          AND available_delta=-c.quoted_amount AND reserved_delta=c.quoted_amount)<>1
        OR (SELECT count(*) FROM e WHERE charge_id=c.id AND kind IN ('spend','release'))<>CASE WHEN state='reserved' THEN 0 ELSE 1 END
        OR (state='settled' AND NOT EXISTS(SELECT 1 FROM e WHERE charge_id=c.id AND kind='spend'
          AND points_delta=-c.settled_amount AND available_delta=0 AND reserved_delta=-c.quoted_amount))
        OR (state='released' AND NOT EXISTS(SELECT 1 FROM e WHERE charge_id=c.id AND kind='release'
          AND reserved_delta=-c.quoted_amount AND points_delta=-expired_points))
      UNION ALL SELECT 'charge_refunds',count(*) FROM c WHERE refunded_amount<>coalesce((SELECT sum(points_delta) FROM e WHERE charge_id=c.id AND kind='refund'),0)
      UNION ALL SELECT 'ledger_chain',count(*) FROM chain WHERE sequence<>previous_sequence+1
        OR available_after<>previous_available+available_delta OR reserved_after<>previous_reserved+reserved_delta
        OR points_delta<>available_delta+reserved_delta
      UNION ALL SELECT 'ledger_head',count(*) FROM credit_accounts WHERE account_id=p_account_id AND
        (last_sequence<>coalesce((SELECT max(sequence) FROM e),0)
        OR coalesce((SELECT available_after FROM e ORDER BY sequence DESC LIMIT 1),0)<>coalesce((SELECT sum(amount-reserved_amount-spent_amount-expired_amount) FROM g),0)
        OR coalesce((SELECT reserved_after FROM e ORDER BY sequence DESC LIMIT 1),0)<>coalesce((SELECT sum(reserved_amount) FROM g),0))
      UNION ALL SELECT 'orphan_hold',count(*) FROM c WHERE state='reserved' AND
        ((task_kind='classification_preview' AND NOT EXISTS(SELECT 1 FROM classification_provider_executions x
          WHERE x.principal_id=p_account_id AND x.id=c.task_id AND x.credit_charge_id=c.id AND x.billing_owner_kind='execution'))
        OR (task_kind='classification_action' AND NOT EXISTS(SELECT 1 FROM collection_classification_run_actions x
          JOIN collection_classification_runs r ON r.id=x.run_id WHERE r.principal_id=p_account_id AND x.action_id=c.task_id AND x.credit_charge_id=c.id)))
      UNION ALL SELECT 'preview_terminal',count(*) FROM c JOIN classification_provider_executions x
        ON x.principal_id=p_account_id AND x.id=c.task_id AND x.credit_charge_id=c.id AND x.billing_owner_kind='execution'
        WHERE c.task_kind='classification_preview' AND
          ((x.state IN ('pending','running') AND c.state<>'reserved')
          OR (x.state IN ('failed','outcome_unknown') AND c.state<>'released')
          OR (x.state='succeeded' AND c.state<>'settled' AND NOT (c.state='released' AND EXISTS(
            SELECT 1 FROM e WHERE charge_id=c.id AND kind='release' AND reason_code='classification_unneeded')
            AND NOT EXISTS(SELECT 1 FROM classification_call_attempts ca WHERE ca.execution_id=x.id AND ca.state='succeeded'))))
      UNION ALL SELECT 'action_terminal',count(*) FROM c JOIN collection_classification_run_actions x ON x.credit_charge_id=c.id
        JOIN collection_classification_runs r ON r.id=x.run_id AND r.principal_id=p_account_id
        WHERE c.task_kind='classification_action' AND
          ((x.status IN ('pending','running') AND c.state<>'reserved')
          OR (x.status='failed' AND c.state<>'released')
          OR (x.status='succeeded' AND c.state<>'settled' AND NOT (c.state='released' AND EXISTS(
            SELECT 1 FROM e WHERE charge_id=c.id AND kind='release' AND reason_code='classification_unneeded')
            AND NOT EXISTS(SELECT 1 FROM classification_provider_executions ce
              JOIN classification_call_attempts ca ON ca.execution_id=ce.id AND ca.state='succeeded'
              WHERE ce.principal_id=p_account_id AND ce.command_scope='collections:classification-run-action:v1'
                AND ce.command_id=x.execution_command_id))))
    ) SELECT code,n FROM issues WHERE n>0
    $function$`).execute(db);
  await sql.raw(`CREATE FUNCTION ${q('credit_audit_account')}(p_account_id text,p_clear_block boolean DEFAULT false)
    RETURNS TABLE(issue_code text,issue_count bigint) LANGUAGE plpgsql SECURITY DEFINER ${settings} AS $function$
    DECLARE findings jsonb; item jsonb;
    BEGIN
      IF p_clear_block AND NOT credit_operator_authorized() THEN RAISE EXCEPTION 'credit operator required' USING ERRCODE='42501'; END IF;
      PERFORM credit_lock_account(p_account_id,true);
      SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) INTO findings FROM credit_integrity_issues(p_account_id) f;
      IF jsonb_array_length(findings)>0 THEN
        UPDATE credit_accounts SET integrity_blocked=true,integrity_issue_count=(SELECT sum((v->>'issue_count')::bigint) FROM jsonb_array_elements(findings) v) WHERE account_id=p_account_id;
      ELSE
        UPDATE credit_accounts SET integrity_blocked=CASE WHEN p_clear_block THEN false ELSE integrity_blocked END,integrity_issue_count=0 WHERE account_id=p_account_id;
      END IF;
      FOR item IN SELECT * FROM jsonb_array_elements(findings) LOOP
        issue_code:=item->>'issue_code';issue_count:=(item->>'issue_count')::bigint;RETURN NEXT;
      END LOOP;
    END $function$`).execute(db);
  await sql.raw(`CREATE FUNCTION ${q('credit_new_charge_integrity_guard')}() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${settings} AS $function$
    BEGIN
      IF EXISTS(SELECT 1 FROM credit_accounts WHERE account_id=NEW.account_id AND integrity_blocked) THEN
        RAISE EXCEPTION 'credit_integrity_blocked' USING ERRCODE='P0001';
      END IF;
      RETURN NEW;
    END $function$`).execute(db);
  await sql`CREATE TRIGGER credit_new_charge_integrity_guard BEFORE INSERT ON credit_charges
    FOR EACH ROW EXECUTE FUNCTION credit_new_charge_integrity_guard()`.execute(db);
  for (const signature of ['credit_integrity_issues(text)', 'credit_audit_account(text,boolean)', 'credit_new_charge_integrity_guard()']) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${quoteIdentifier(schema)}.${signature} FROM PUBLIC`).execute(db);
  }
  await sql.raw(`DO $block$ BEGIN
    IF to_regrole('known_credits_app') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION ${q('credit_audit_account')}(text,boolean) TO known_credits_app;
    END IF;
    IF to_regrole('known_credits_operator') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION ${q('credit_audit_account')}(text,boolean) TO known_credits_operator;
    END IF;
  END $block$`).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Retain credit integrity controls during application rollback; stop admission and drain owners first');
}
