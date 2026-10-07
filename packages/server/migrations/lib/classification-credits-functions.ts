import { sql, type Kysely } from 'kysely';
import { qualified, quoteIdentifier } from './classification-credits-schema.js';

const MAX_POINTS = 2147483647;

function functionSetting(schema: string): string {
  return `SET search_path = pg_catalog, ${quoteIdentifier(schema)}`;
}

function internalWrite(): string {
  return `PERFORM set_config('known.credits_internal_xact', txid_current()::text, true);`;
}

function q(schema: string, name: string): string {
  return qualified(schema, name);
}

export async function installCreditFunctions(db: Kysely<unknown>, schema: string): Promise<void> {
  const accounts = q(schema, 'accounts');
  const creditAccounts = q(schema, 'credit_accounts');
  const grants = q(schema, 'credit_grants');
  const charges = q(schema, 'credit_charges');
  const allocations = q(schema, 'credit_allocations');
  const entries = q(schema, 'credit_ledger_entries');

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_operator_authorized')}() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE operator_role oid;
    BEGIN
      operator_role := to_regrole('known_credits_operator');
      RETURN (operator_role IS NOT NULL AND pg_has_role(session_user, operator_role, 'member'))
        OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper);
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_lock_account')}(
      p_account_id text, p_allow_inactive boolean DEFAULT false
    ) RETURNS timestamptz
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE account_status text; account_deleted_at timestamptz; decision_time timestamptz;
    BEGIN
      IF p_account_id IS NULL OR octet_length(p_account_id) = 0 OR octet_length(p_account_id) > 256 THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      SELECT status, deleted_at INTO account_status, account_deleted_at
        FROM ${accounts} WHERE id = p_account_id FOR SHARE;
      IF NOT FOUND OR (NOT p_allow_inactive AND (account_status <> 'active' OR account_deleted_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      ${internalWrite()}
      INSERT INTO ${creditAccounts}(account_id) VALUES (p_account_id)
        ON CONFLICT (account_id) DO NOTHING;
      PERFORM 1 FROM ${creditAccounts} WHERE account_id = p_account_id FOR UPDATE;
      SELECT clock_timestamp() INTO decision_time;
      RETURN decision_time;
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_balance')}(
      p_account_id text, p_as_of timestamptz
    ) RETURNS TABLE(
      available bigint, reserved bigint, next_expiry_at timestamptz,
      expiring_points bigint, last_sequence bigint
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE expiry timestamptz;
    BEGIN
      IF p_as_of IS NULL THEN
        RAISE EXCEPTION 'credit_invalid_expiry' USING ERRCODE = 'P0001';
      END IF;
      SELECT min(g.expires_at) INTO expiry
      FROM ${grants} g
      WHERE g.account_id = p_account_id
        AND g.expires_at IS NOT NULL
        AND g.expires_at > p_as_of
        AND g.valid_from <= p_as_of
        AND g.amount - g.reserved_amount - g.spent_amount - g.expired_amount > 0;
      RETURN QUERY
      SELECT
        COALESCE((SELECT sum(g.amount - g.reserved_amount - g.spent_amount - g.expired_amount)
          FROM ${grants} g
          WHERE g.account_id = p_account_id AND g.valid_from <= p_as_of
            AND (g.expires_at IS NULL OR p_as_of < g.expires_at)), 0)::bigint,
        COALESCE((SELECT sum(g.reserved_amount) FROM ${grants} g WHERE g.account_id = p_account_id), 0)::bigint,
        expiry,
        COALESCE((SELECT sum(g.amount - g.reserved_amount - g.spent_amount - g.expired_amount)
          FROM ${grants} g WHERE g.account_id = p_account_id AND g.expires_at = expiry
            AND g.valid_from <= p_as_of), 0)::bigint,
        COALESCE((SELECT a.last_sequence FROM ${creditAccounts} a WHERE a.account_id = p_account_id), 0)::bigint;
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_append_entry')}(
      p_account_id text, p_event_key text, p_fingerprint text, p_kind text,
      p_posted_at timestamptz, p_effective_at timestamptz, p_points_delta bigint,
      p_available_delta bigint, p_reserved_delta bigint, p_expired_points bigint,
      p_operation_type text, p_source text, p_reason_code text, p_grant_id uuid,
      p_charge_id uuid, p_related_entry_id uuid, p_expires_at timestamptz,
      p_task_json jsonb, p_as_of timestamptz
    ) RETURNS uuid
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE existing_id uuid; existing_fingerprint text; next_sequence bigint;
      current_available bigint; current_reserved bigint; entry_id uuid;
    BEGIN
      IF p_event_key IS NULL OR octet_length(p_event_key) NOT BETWEEN 1 AND 256
        OR p_fingerprint IS NULL OR octet_length(p_fingerprint) NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION 'credit_key_reused' USING ERRCODE = 'P0001';
      END IF;
      IF p_points_delta IS DISTINCT FROM p_available_delta + p_reserved_delta
        OR p_expired_points < 0 OR p_expired_points > ${MAX_POINTS}
        OR p_available_delta < -${MAX_POINTS} OR p_available_delta > ${MAX_POINTS}
        OR p_reserved_delta < -${MAX_POINTS} OR p_reserved_delta > ${MAX_POINTS}
        OR p_points_delta < -${MAX_POINTS} OR p_points_delta > ${MAX_POINTS}
        OR p_as_of IS NULL OR p_posted_at IS NULL OR p_effective_at IS NULL THEN
        RAISE EXCEPTION 'credit_unavailable' USING ERRCODE = 'P0001';
      END IF;
      SELECT e.id, e.fingerprint INTO existing_id, existing_fingerprint
      FROM ${entries} e WHERE e.account_id = p_account_id AND e.event_key = p_event_key;
      IF FOUND THEN
        IF existing_fingerprint <> p_fingerprint THEN
          RAISE EXCEPTION 'credit_key_reused' USING ERRCODE = 'P0001';
        END IF;
        RETURN existing_id;
      END IF;
      ${internalWrite()}
      SELECT a.last_sequence INTO next_sequence FROM ${creditAccounts} a
        WHERE a.account_id = p_account_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      next_sequence := next_sequence + 1;
      SELECT e.available_after, e.reserved_after INTO current_available, current_reserved
      FROM ${entries} e WHERE e.account_id = p_account_id ORDER BY e.sequence DESC LIMIT 1;
      IF NOT FOUND THEN current_available := 0; current_reserved := 0; END IF;
      IF current_available < 0 OR current_reserved < 0
        OR current_available + current_reserved > ${MAX_POINTS}
        OR current_available + p_available_delta < 0
        OR current_reserved + p_reserved_delta < 0
        OR current_available + p_available_delta > ${MAX_POINTS}
        OR current_reserved + p_reserved_delta > ${MAX_POINTS} THEN
        RAISE EXCEPTION 'credit_balance_limit' USING ERRCODE = 'P0001';
      END IF;
      entry_id := gen_random_uuid();
      INSERT INTO ${entries}(
        id, account_id, sequence, event_key, fingerprint, kind, posted_at, effective_at,
        points_delta, available_delta, reserved_delta, expired_points, available_after,
        reserved_after, operation_type, source, reason_code, grant_id, charge_id,
        related_entry_id, expires_at, task_json
      ) VALUES (
        entry_id, p_account_id, next_sequence, p_event_key, p_fingerprint, p_kind,
        p_posted_at, p_effective_at, p_points_delta, p_available_delta, p_reserved_delta,
        p_expired_points, current_available + p_available_delta, current_reserved + p_reserved_delta,
        p_operation_type, p_source, p_reason_code, p_grant_id, p_charge_id,
        p_related_entry_id, p_expires_at, p_task_json
      );
      UPDATE ${creditAccounts} SET last_sequence = next_sequence WHERE account_id = p_account_id;
      IF NOT EXISTS(SELECT 1 FROM ${grants} pending WHERE pending.account_id=p_account_id
        AND pending.expires_at<=p_as_of AND pending.expiry_processed_at IS NULL)
        AND EXISTS(SELECT 1 FROM ${q(schema, 'credit_balance')}(p_account_id,p_as_of) facts
          WHERE facts.available<>current_available+p_available_delta OR facts.reserved<>current_reserved+p_reserved_delta) THEN
        RAISE EXCEPTION 'credit_unavailable' USING ERRCODE='P0001';
      END IF;
      RETURN entry_id;
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_expiry_pending_count')}(
      p_account_id text
    ) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER ${functionSetting(schema)} AS $function$
      SELECT count(*)::integer FROM (SELECT 1 FROM ${grants}
      WHERE account_id = p_account_id AND expires_at <= clock_timestamp()
        AND expiry_processed_at IS NULL LIMIT 101) pending
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_reconcile_expired')}(
      p_account_id text, p_as_of timestamptz DEFAULT clock_timestamp()
    ) RETURNS TABLE(processed integer, has_more boolean, last_sequence bigint)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE g record; unused bigint; processed_count integer := 0; more boolean;
      sequence_value bigint; expire_entry uuid; decision_time timestamptz;
    BEGIN
      IF p_as_of IS NULL THEN
        RAISE EXCEPTION 'credit_invalid_expiry' USING ERRCODE = 'P0001';
      END IF;
      ${internalWrite()}
      decision_time := p_as_of;
      FOR g IN
        SELECT * FROM ${grants}
        WHERE account_id = p_account_id AND expires_at <= p_as_of
          AND expiry_processed_at IS NULL
        ORDER BY expires_at ASC, created_at ASC, id ASC
        LIMIT 100 FOR UPDATE
      LOOP
        unused := g.amount - g.reserved_amount - g.spent_amount - g.expired_amount;
        UPDATE ${grants}
        SET expired_amount = expired_amount + GREATEST(unused, 0), expiry_processed_at = decision_time
        WHERE account_id = p_account_id AND id = g.id;
        IF unused > 0 THEN
          expire_entry := ${q(schema, 'credit_append_entry')}(
            p_account_id, 'expire:' || g.id::text, md5(jsonb_build_object('grantId', g.id::text, 'amount', unused)::text),
            'expire', decision_time, g.expires_at, -unused, -unused, 0, unused,
            'credit.expire', g.source, 'credits_expired', g.id, NULL, NULL, g.expires_at, NULL, decision_time
          );
        END IF;
        processed_count := processed_count + 1;
      END LOOP;
      SELECT EXISTS (SELECT 1 FROM ${grants}
        WHERE account_id = p_account_id AND expires_at <= p_as_of AND expiry_processed_at IS NULL) INTO more;
      SELECT COALESCE(a.last_sequence, 0) INTO sequence_value FROM ${creditAccounts} a WHERE a.account_id = p_account_id;
      RETURN QUERY SELECT processed_count, more, sequence_value;
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_reserve')}(
      p_account_id text, p_charge_id uuid, p_operation_key text, p_fingerprint text,
      p_amount bigint, p_source text, p_price_version text, p_task_kind text,
      p_task_id text, p_task_json jsonb, p_deadline_at timestamptz
    ) RETURNS uuid
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE c record; grant_row record; remaining bigint; take_amount bigint;
      available_total bigint; decision_time timestamptz; reserve_entry uuid; account_status text;
    BEGIN
      IF p_account_id IS NULL OR p_charge_id IS NULL OR p_operation_key IS NULL
        OR octet_length(p_operation_key) NOT BETWEEN 1 AND 256
        OR p_fingerprint IS NULL OR octet_length(p_fingerprint) NOT BETWEEN 1 AND 128
        OR p_amount IS NULL OR p_amount <= 0 OR p_amount > ${MAX_POINTS}
        OR p_source NOT IN ('web','extension','batch','system')
        OR p_price_version IS NULL OR octet_length(p_price_version) NOT BETWEEN 1 AND 64
        OR p_task_kind NOT IN ('classification_preview','classification_action')
        OR p_task_id IS NULL OR octet_length(p_task_id) NOT BETWEEN 1 AND 512
        OR p_task_json IS NULL OR jsonb_typeof(p_task_json) <> 'object'
        OR octet_length(p_task_json::text) > 4096 THEN
        RAISE EXCEPTION 'credit_invalid_amount' USING ERRCODE = 'P0001';
      END IF;
      SELECT status INTO account_status FROM ${accounts} WHERE id = p_account_id;
      IF NOT FOUND OR account_status <> 'active' THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM ${creditAccounts} WHERE account_id = p_account_id) THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      SELECT id, fingerprint INTO c FROM ${charges}
        WHERE account_id = p_account_id AND operation_key = p_operation_key;
      IF FOUND THEN
        IF c.fingerprint <> p_fingerprint THEN
          RAISE EXCEPTION 'credit_key_reused' USING ERRCODE = 'P0001';
        END IF;
        RETURN c.id;
      END IF;
      IF EXISTS (SELECT 1 FROM ${charges} WHERE id = p_charge_id) THEN
        RAISE EXCEPTION 'credit_key_reused' USING ERRCODE = 'P0001';
      END IF;
      decision_time := clock_timestamp();
      IF p_deadline_at IS NULL OR p_deadline_at <= decision_time THEN
        RAISE EXCEPTION 'credit_invalid_expiry' USING ERRCODE = 'P0001';
      END IF;
      IF ${q(schema, 'credit_expiry_pending_count')}(p_account_id) > 100 THEN
        RAISE EXCEPTION 'credit_reconciliation_required' USING ERRCODE = 'P0001';
      END IF;
      PERFORM * FROM ${q(schema, 'credit_reconcile_expired')}(p_account_id, decision_time);
      SELECT COALESCE(sum(g.amount - g.reserved_amount - g.spent_amount - g.expired_amount), 0)::bigint
        INTO available_total
      FROM ${grants} g
      WHERE g.account_id = p_account_id AND g.valid_from <= decision_time
        AND (g.expires_at IS NULL OR decision_time < g.expires_at)
        AND g.amount - g.reserved_amount - g.spent_amount - g.expired_amount > 0;
      IF available_total < p_amount THEN
        RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001';
      END IF;
      PERFORM 1 FROM ${grants} g
      WHERE g.account_id = p_account_id AND g.valid_from <= decision_time
        AND (g.expires_at IS NULL OR decision_time < g.expires_at)
        AND g.amount - g.reserved_amount - g.spent_amount - g.expired_amount > 0
      ORDER BY g.expires_at ASC NULLS LAST, g.created_at ASC, g.id ASC LIMIT p_amount FOR UPDATE;
      ${internalWrite()}
      INSERT INTO ${charges}(
        id, account_id, operation_key, fingerprint, operation_type, source, price_version,
        quoted_amount, state, settled_amount, refunded_amount, task_kind, task_id,
        deadline_at, created_at, completed_at
      ) VALUES (
        p_charge_id, p_account_id, p_operation_key, p_fingerprint, 'bookmark.classify', p_source,
        p_price_version, p_amount, 'reserved', 0, 0, p_task_kind, p_task_id,
        p_deadline_at, decision_time, NULL
      );
      remaining := p_amount;
      FOR grant_row IN
        SELECT * FROM ${grants}
        WHERE account_id = p_account_id AND valid_from <= decision_time
          AND (expires_at IS NULL OR decision_time < expires_at)
          AND amount - reserved_amount - spent_amount - expired_amount > 0
        ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC LIMIT p_amount
      LOOP
        EXIT WHEN remaining = 0;
        take_amount := LEAST(remaining, grant_row.amount - grant_row.reserved_amount - grant_row.spent_amount - grant_row.expired_amount);
        UPDATE ${grants} SET reserved_amount = reserved_amount + take_amount
          WHERE account_id = p_account_id AND id = grant_row.id;
        INSERT INTO ${allocations}(account_id, charge_id, grant_id, amount)
          VALUES (p_account_id, p_charge_id, grant_row.id, take_amount);
        remaining := remaining - take_amount;
      END LOOP;
      IF remaining <> 0 THEN
        RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001';
      END IF;
      reserve_entry := ${q(schema, 'credit_append_entry')}(
        p_account_id,
        'reserve:' || p_charge_id::text,
        md5(jsonb_build_object('charge', p_fingerprint, 'amount', p_amount)::text),
        'reserve', decision_time, decision_time, 0, -p_amount, p_amount, 0,
        'bookmark.classify', p_source, 'classification_requested', NULL, p_charge_id,
        NULL, NULL, p_task_json, decision_time
      );
      RETURN p_charge_id;
    END
    $function$`).execute(db);

  await sql.raw(`CREATE FUNCTION ${q(schema, 'credit_finish')}(
      p_account_id text, p_charge_id uuid, p_settle boolean, p_reason_code text
    ) RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${functionSetting(schema)} AS $function$
    DECLARE c record; a record; reserve_entry uuid; frozen_task jsonb; decision_time timestamptz;
      amount_total bigint := 0; expired_total bigint := 0; available_total bigint := 0;
      grant_expired bigint; grant_available bigint; terminal_kind text;
      terminal_reason text; terminal_entry uuid;
    BEGIN
      SELECT * INTO c FROM ${charges}
        WHERE account_id = p_account_id AND id = p_charge_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_account_unavailable' USING ERRCODE = 'P0001';
      END IF;
      IF c.state <> 'reserved' THEN RETURN false; END IF;
      IF NOT p_settle AND p_reason_code NOT IN ('classification_failed','classification_cancelled','classification_unneeded','hold_expired') THEN
        RAISE EXCEPTION 'credit_invalid_amount' USING ERRCODE = 'P0001';
      END IF;
      decision_time := clock_timestamp();
      IF ${q(schema, 'credit_expiry_pending_count')}(p_account_id) > 100 THEN
        RAISE EXCEPTION 'credit_reconciliation_required' USING ERRCODE = 'P0001';
      END IF;
      PERFORM 1 FROM ${grants} grant_lock WHERE grant_lock.account_id=p_account_id
        AND ((grant_lock.expires_at <= decision_time AND grant_lock.expiry_processed_at IS NULL)
          OR EXISTS(SELECT 1 FROM ${allocations} owned_allocation
            WHERE owned_allocation.account_id=p_account_id AND owned_allocation.charge_id=p_charge_id
              AND owned_allocation.grant_id=grant_lock.id))
        ORDER BY grant_lock.expires_at ASC NULLS LAST,grant_lock.created_at,grant_lock.id FOR UPDATE;
      PERFORM * FROM ${q(schema, 'credit_reconcile_expired')}(p_account_id, decision_time);
      -- Lock every grant in the deterministic L6 order before taking the charge row.
      FOR a IN
        SELECT alloc.amount, g.id AS grant_id, g.expires_at, g.reserved_amount
        FROM ${allocations} alloc
        JOIN ${grants} g ON g.account_id = alloc.account_id AND g.id = alloc.grant_id
        WHERE alloc.account_id = p_account_id AND alloc.charge_id = p_charge_id
        ORDER BY g.expires_at ASC NULLS LAST, g.created_at ASC, g.id ASC
        FOR UPDATE OF g
      LOOP
        amount_total := amount_total + a.amount;
      END LOOP;
      SELECT * INTO c FROM ${charges}
        WHERE account_id = p_account_id AND id = p_charge_id FOR UPDATE;
      IF NOT FOUND OR c.state <> 'reserved' THEN RETURN false; END IF;
      ${internalWrite()}
      IF amount_total <> c.quoted_amount THEN
        RAISE EXCEPTION 'credit_unavailable' USING ERRCODE = 'P0001';
      END IF;
      FOR a IN
        SELECT alloc.amount, g.id AS grant_id, g.expires_at, g.reserved_amount
        FROM ${allocations} alloc
        JOIN ${grants} g ON g.account_id = alloc.account_id AND g.id = alloc.grant_id
        WHERE alloc.account_id = p_account_id AND alloc.charge_id = p_charge_id
        ORDER BY g.expires_at ASC NULLS LAST, g.created_at ASC, g.id ASC
      LOOP
        IF a.reserved_amount < a.amount THEN
          RAISE EXCEPTION 'credit_unavailable' USING ERRCODE = 'P0001';
        END IF;
        IF p_settle THEN
          UPDATE ${grants}
          SET reserved_amount = reserved_amount - a.amount, spent_amount = spent_amount + a.amount
          WHERE account_id = p_account_id AND id = a.grant_id;
        ELSE
          grant_expired := CASE WHEN a.expires_at IS NOT NULL AND a.expires_at <= decision_time THEN a.amount ELSE 0 END;
          grant_available := a.amount - grant_expired;
          expired_total := expired_total + grant_expired;
          available_total := available_total + grant_available;
          UPDATE ${grants}
          SET reserved_amount = reserved_amount - a.amount, expired_amount = expired_amount + grant_expired
          WHERE account_id = p_account_id AND id = a.grant_id;
        END IF;
      END LOOP;
      SELECT e.id,e.task_json INTO reserve_entry,frozen_task FROM ${entries} e
        WHERE e.account_id = p_account_id AND e.event_key = 'reserve:' || p_charge_id::text;
      IF reserve_entry IS NULL THEN
        RAISE EXCEPTION 'credit_unavailable' USING ERRCODE = 'P0001';
      END IF;
      IF p_settle THEN
        terminal_kind := 'spend'; terminal_reason := 'classification_completed';
        UPDATE ${charges}
        SET state = 'settled', settled_amount = quoted_amount, completed_at = decision_time
        WHERE account_id = p_account_id AND id = p_charge_id AND state = 'reserved';
        terminal_entry := ${q(schema, 'credit_append_entry')}(
          p_account_id, 'spend:' || p_charge_id::text,
          md5(jsonb_build_object('charge', c.fingerprint, 'state', 'settled')::text),
          terminal_kind, decision_time, decision_time, -c.quoted_amount, 0, -c.quoted_amount, 0,
          'bookmark.classify', c.source, terminal_reason, NULL, p_charge_id, reserve_entry, NULL, frozen_task, decision_time
        );
      ELSE
        terminal_kind := 'release'; terminal_reason := p_reason_code;
        UPDATE ${charges}
        SET state = 'released', completed_at = decision_time
        WHERE account_id = p_account_id AND id = p_charge_id AND state = 'reserved';
        terminal_entry := ${q(schema, 'credit_append_entry')}(
          p_account_id, 'release:' || p_charge_id::text,
          md5(jsonb_build_object('charge', c.fingerprint, 'state', 'released', 'reason', p_reason_code)::text),
          terminal_kind, decision_time, decision_time, -expired_total, available_total, -c.quoted_amount,
          expired_total, 'bookmark.classify', c.source, terminal_reason, NULL, p_charge_id, reserve_entry,
          NULL, frozen_task, decision_time
        );
      END IF;
      RETURN true;
    END
    $function$`).execute(db);

}

export async function dropCreditFunctions(db: Kysely<unknown>, schema: string): Promise<void> {
  for (const signature of [
    'credit_finish(text,uuid,boolean,text)', 'credit_reserve(text,uuid,text,text,bigint,text,text,text,text,jsonb,timestamptz)',
    'credit_reconcile_expired(text,timestamptz)', 'credit_expiry_pending_count(text)',
    'credit_append_entry(text,text,text,text,timestamptz,timestamptz,bigint,bigint,bigint,bigint,text,text,text,uuid,uuid,uuid,timestamptz,jsonb,timestamptz)',
    'credit_balance(text,timestamptz)', 'credit_lock_account(text,boolean)',
    'credit_operator_authorized()',
  ]) {
    const split = signature.indexOf('(');
    await sql.raw(`DROP FUNCTION IF EXISTS ${q(schema, signature.slice(0, split))}${signature.slice(split)}`).execute(db);
  }
}
