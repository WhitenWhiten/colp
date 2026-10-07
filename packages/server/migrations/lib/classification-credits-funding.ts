import { sql, type Kysely } from 'kysely';
import { qualified as q, quoteIdentifier } from './classification-credits-schema.js';

/** Funding is operator-only; these functions never install an activity or scheduler. */
export async function installCreditFunding(db: Kysely<unknown>, schema: string): Promise<void> {
  const accounts = q(schema, 'accounts'), grants = q(schema, 'credit_grants');
  const charges = q(schema, 'credit_charges'), entries = q(schema, 'credit_ledger_entries');
  const settings = `SECURITY DEFINER SET search_path = pg_catalog, ${quoteIdentifier(schema)} SET lock_timeout = '250ms'`;
  const fingerprint = (parameters: string) => `encode(sha256(convert_to(jsonb_build_array(${parameters})::text, 'UTF8')), 'hex')`;
  const authority = `IF NOT ${q(schema, 'credit_operator_authorized')}() THEN
    RAISE EXCEPTION 'credit operator privilege required' USING ERRCODE = '42501'; END IF;`;
  const active = `IF NOT EXISTS(SELECT 1 FROM ${accounts} WHERE id=p_account_id AND status='active' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE='P0001'; END IF;`;
  const reconciliation = `IF (SELECT count(*) FROM (SELECT 1 FROM ${grants} WHERE account_id=p_account_id
    AND expires_at <= decision_time AND expiry_processed_at IS NULL LIMIT 101) pending) > 100 THEN
      RAISE EXCEPTION 'credit_reconciliation_required' USING ERRCODE='P0001'; END IF;
    PERFORM * FROM ${q(schema, 'credit_reconcile_expired')}(p_account_id,decision_time);`;
  const amount = `IF p_amount IS NULL OR p_amount < 1 OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'credit_invalid_amount' USING ERRCODE='P0001'; END IF;`;
  const capacity = `SELECT available,reserved INTO available_points,reserved_points
    FROM ${q(schema, 'credit_balance')}(p_account_id,decision_time);
    IF available_points + reserved_points + p_amount > 2147483647 THEN
      RAISE EXCEPTION 'credit_balance_limit' USING ERRCODE='P0001'; END IF;`;

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_grant_credits')}(
    p_account_id text, p_grant_key text, p_amount bigint, p_valid_from timestamptz,
    p_expires_at timestamptz, p_source text, p_reason_code text, p_operator_note text
  ) RETURNS TABLE(grant_id uuid,entry_id uuid,sequence bigint,replayed boolean)
  LANGUAGE plpgsql ${settings} AS $function$
  DECLARE decision_time timestamptz; intent text; grant_uuid uuid; entry_uuid uuid;
    previous record; available_points bigint; reserved_points bigint;
  BEGIN
    ${authority}
    ${amount}
    IF p_grant_key IS NULL OR octet_length(p_grant_key) NOT BETWEEN 1 AND 160
      OR p_source IS NULL OR p_source NOT IN ('operator','scheduler')
      OR p_reason_code IS NULL OR p_reason_code NOT IN ('manual_grant','trial_grant')
      OR octet_length(p_operator_note)>4096 THEN
      RAISE EXCEPTION 'credit_key_reused' USING ERRCODE='P0001'; END IF;
    intent := ${fingerprint("p_account_id,p_grant_key,p_amount,extract(epoch FROM p_valid_from),extract(epoch FROM p_expires_at),p_source,p_reason_code,p_operator_note")};
    decision_time := ${q(schema, 'credit_lock_account')}(p_account_id,true);
    SELECT g.id,g.fingerprint INTO previous FROM ${grants} g
      WHERE g.account_id=p_account_id AND g.grant_key='grant:'||p_grant_key;
    IF FOUND THEN
      IF previous.fingerprint IS DISTINCT FROM intent THEN
        RAISE EXCEPTION 'credit_key_reused' USING ERRCODE='P0001'; END IF;
      RETURN QUERY SELECT previous.id,e.id,e.sequence,true FROM ${entries} e
        WHERE e.account_id=p_account_id AND e.event_key='grant:'||previous.id::text;
      RETURN;
    END IF;
    ${active}
    IF p_valid_from IS NULL OR NOT isfinite(p_valid_from) OR p_valid_from>decision_time
      OR (p_expires_at IS NOT NULL AND (NOT isfinite(p_expires_at) OR p_expires_at<=decision_time OR p_expires_at<=p_valid_from)) THEN
      RAISE EXCEPTION 'credit_invalid_expiry' USING ERRCODE='P0001'; END IF;
    ${reconciliation}
    ${capacity}
    grant_uuid := gen_random_uuid();
    INSERT INTO ${grants}(id,account_id,grant_key,fingerprint,amount,valid_from,expires_at,source,reason_code,operator_note,created_at)
      VALUES(grant_uuid,p_account_id,'grant:'||p_grant_key,intent,p_amount,p_valid_from,p_expires_at,p_source,p_reason_code,p_operator_note,decision_time);
    entry_uuid := ${q(schema, 'credit_append_entry')}(p_account_id,'grant:'||grant_uuid::text,intent,'grant',
      decision_time,decision_time,p_amount,p_amount,0,0,'credit.grant',p_source,p_reason_code,grant_uuid,NULL,NULL,p_expires_at,NULL,decision_time);
    RETURN QUERY SELECT grant_uuid,entry_uuid,e.sequence,false FROM ${entries} e WHERE e.id=entry_uuid;
  END $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_refund_charge')}(
    p_account_id text,p_refund_key text,p_charge_id uuid,p_amount bigint,p_expires_at timestamptz,p_operator_note text
  ) RETURNS TABLE(refund_entry_id uuid,grant_id uuid,sequence bigint,replayed boolean)
  LANGUAGE plpgsql ${settings} AS $function$
  DECLARE decision_time timestamptz; intent text; previous record; charge_row record; spend_row record;
    available_points bigint; reserved_points bigint; grant_uuid uuid; entry_uuid uuid;
  BEGIN
    ${authority}
    ${amount}
    IF p_refund_key IS NULL OR octet_length(p_refund_key) NOT BETWEEN 1 AND 160 OR octet_length(p_operator_note)>4096 THEN
      RAISE EXCEPTION 'credit_key_reused' USING ERRCODE='P0001'; END IF;
    intent := ${fingerprint("p_account_id,p_refund_key,p_charge_id,p_amount,extract(epoch FROM p_expires_at),p_operator_note")};
    decision_time := ${q(schema, 'credit_lock_account')}(p_account_id,true);
    SELECT e.id,e.grant_id,e.sequence,e.fingerprint INTO previous FROM ${entries} e
      WHERE e.account_id=p_account_id AND e.event_key='refund:'||p_refund_key;
    IF FOUND THEN
      IF previous.fingerprint IS DISTINCT FROM intent THEN
        RAISE EXCEPTION 'credit_key_reused' USING ERRCODE='P0001'; END IF;
      RETURN QUERY SELECT previous.id,previous.grant_id,previous.sequence,true;
      RETURN;
    END IF;
    ${active}
    IF p_expires_at IS NOT NULL AND (NOT isfinite(p_expires_at) OR p_expires_at<=decision_time) THEN
      RAISE EXCEPTION 'credit_invalid_expiry' USING ERRCODE='P0001'; END IF;
    -- L1 makes this discovery stable. Take the charge lock after grant locks.
    SELECT c.* INTO charge_row FROM ${charges} c WHERE c.account_id=p_account_id AND c.id=p_charge_id;
    IF NOT FOUND OR charge_row.state<>'settled' THEN
      RAISE EXCEPTION 'credit_charge_not_refundable' USING ERRCODE='P0001'; END IF;
    SELECT e.* INTO spend_row FROM ${entries} e WHERE e.account_id=p_account_id AND e.charge_id=p_charge_id AND e.kind='spend';
    IF NOT FOUND THEN RAISE EXCEPTION 'credit_charge_not_refundable' USING ERRCODE='P0001'; END IF;
    IF charge_row.refunded_amount+p_amount>charge_row.settled_amount THEN
      RAISE EXCEPTION 'credit_refund_exceeds_charge' USING ERRCODE='P0001'; END IF;
    ${reconciliation}
    ${capacity}
    grant_uuid := gen_random_uuid();
    INSERT INTO ${grants}(id,account_id,grant_key,fingerprint,amount,valid_from,expires_at,source,reason_code,operator_note,created_at)
      VALUES(grant_uuid,p_account_id,'refund:'||p_refund_key,intent,p_amount,decision_time,p_expires_at,'operator','manual_refund',p_operator_note,decision_time);
    PERFORM 1 FROM ${charges} c WHERE c.account_id=p_account_id AND c.id=p_charge_id FOR UPDATE;
    UPDATE ${charges} SET refunded_amount=refunded_amount+p_amount WHERE account_id=p_account_id AND id=p_charge_id
      AND state='settled' AND refunded_amount+p_amount<=settled_amount;
    IF NOT FOUND THEN RAISE EXCEPTION 'credit_refund_exceeds_charge' USING ERRCODE='P0001'; END IF;
    entry_uuid := ${q(schema, 'credit_append_entry')}(p_account_id,'refund:'||p_refund_key,intent,'refund',
      decision_time,decision_time,p_amount,p_amount,0,0,'credit.refund','operator','manual_refund',grant_uuid,p_charge_id,
      spend_row.id,p_expires_at,spend_row.task_json,decision_time);
    RETURN QUERY SELECT entry_uuid,grant_uuid,e.sequence,false FROM ${entries} e WHERE e.id=entry_uuid;
  END $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_reconcile_public')}(p_account_id text)
    RETURNS TABLE(processed integer,has_more boolean,last_sequence bigint)
    LANGUAGE plpgsql ${settings} AS $function$
    DECLARE decision_time timestamptz;
    BEGIN
      decision_time := ${q(schema, 'credit_lock_account')}(p_account_id,true);
      RETURN QUERY SELECT * FROM ${q(schema, 'credit_reconcile_expired')}(p_account_id,decision_time);
    END $function$`).execute(db);

  for (const signature of fundingSignatures) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${q(schema, signature.name)}(${signature.types}) FROM PUBLIC`).execute(db);
  }
  // Production uses public. Schema-isolated suites call these same fixed-schema
  // implementations directly and cannot overwrite another suite's public API.
  if (schema === 'public') await installKnownCreditApi(db, schema);
}

const fundingSignatures = [
  { name: 'credit_grant_credits', types: 'text,text,bigint,timestamptz,timestamptz,text,text,text' },
  { name: 'credit_refund_charge', types: 'text,text,uuid,bigint,timestamptz,text' },
  { name: 'credit_reconcile_public', types: 'text' },
] as const;

/** Explicit fixed-schema aliases; called by the production migration, never selected by a caller's search_path. */
export async function installKnownCreditApi(db: Kysely<unknown>, schema: string): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS known_credits`.execute(db);
  await sql`REVOKE ALL ON SCHEMA known_credits FROM PUBLIC`.execute(db);
  const settings = `SECURITY DEFINER SET search_path=pg_catalog,${quoteIdentifier(schema)}`;
  await sql.raw(`CREATE FUNCTION known_credits.grant_credits(p_account_id text,p_grant_key text,p_amount bigint,
    p_valid_from timestamptz,p_expires_at timestamptz,p_source text,p_reason_code text,p_operator_note text)
    RETURNS TABLE(grant_id uuid,entry_id uuid,sequence bigint,replayed boolean)
    LANGUAGE sql ${settings} AS $function$
      SELECT * FROM ${q(schema, 'credit_grant_credits')}($1,$2,$3,$4,$5,$6,$7,$8)
    $function$`).execute(db);
  await sql.raw(`CREATE FUNCTION known_credits.refund_credit_charge(p_account_id text,p_refund_key text,p_charge_id uuid,
    p_amount bigint,p_expires_at timestamptz,p_operator_note text)
    RETURNS TABLE(refund_entry_id uuid,grant_id uuid,sequence bigint,replayed boolean)
    LANGUAGE sql ${settings} AS $function$
      SELECT * FROM ${q(schema, 'credit_refund_charge')}($1,$2,$3,$4,$5,$6)
    $function$`).execute(db);
  await sql.raw(`CREATE FUNCTION known_credits.reconcile_expired_credits(p_account_id text)
    RETURNS TABLE(processed integer,has_more boolean,last_sequence bigint)
    LANGUAGE sql ${settings} AS $function$
      SELECT * FROM ${q(schema, 'credit_reconcile_public')}($1)
    $function$`).execute(db);
  await sql`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA known_credits FROM PUBLIC`.execute(db);
  await sql`DO $block$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='known_credits_operator') THEN
      GRANT USAGE ON SCHEMA known_credits TO known_credits_operator;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA known_credits TO known_credits_operator;
    END IF;
  END $block$`.execute(db);
}

export async function dropCreditFunding(db: Kysely<unknown>, schema: string): Promise<void> {
  if (schema === 'public') {
    await sql`DROP FUNCTION IF EXISTS known_credits.grant_credits(text,text,bigint,timestamptz,timestamptz,text,text,text)`.execute(db);
    await sql`DROP FUNCTION IF EXISTS known_credits.refund_credit_charge(text,text,uuid,bigint,timestamptz,text)`.execute(db);
    await sql`DROP FUNCTION IF EXISTS known_credits.reconcile_expired_credits(text)`.execute(db);
  }
  for (const signature of fundingSignatures) {
    await sql.raw(`DROP FUNCTION IF EXISTS ${q(schema, signature.name)}(${signature.types})`).execute(db);
  }
}
