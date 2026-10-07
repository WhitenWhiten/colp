import { sql, type Kysely } from 'kysely';
import { qualified, quoteIdentifier } from './classification-credits-schema.js';

export async function installCreditOrphanRepair(db: Kysely<unknown>, schema: string): Promise<void> {
  const fn = qualified(schema, 'credit_repair_orphan_hold');
  await sql.raw(`CREATE FUNCTION ${fn}(p_account_id text,p_charge_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${quoteIdentifier(schema)} AS $function$
    DECLARE charge credit_charges%ROWTYPE; operation jsonb; scope text; command text; body bytea;
    BEGIN
      IF NOT credit_operator_authorized() THEN RAISE EXCEPTION 'credit operator required' USING ERRCODE='42501'; END IF;
      PERFORM credit_lock_account(p_account_id,true);
      SELECT * INTO charge FROM credit_charges WHERE account_id=p_account_id AND id=p_charge_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'credit charge unavailable' USING ERRCODE='P0001'; END IF;
      IF charge.state<>'reserved' THEN RETURN false; END IF;
      -- L1 prevents any managed owner creation, dispatch or deletion during repair.
      IF EXISTS(SELECT 1 FROM classification_provider_executions WHERE principal_id=p_account_id
          AND credit_charge_id=p_charge_id AND (state IN ('pending','running') OR lease_until>clock_timestamp()))
        OR (charge.task_kind='classification_preview' AND EXISTS(SELECT 1 FROM classification_provider_executions
          WHERE principal_id=p_account_id AND id=charge.task_id))
        OR (charge.task_kind='classification_action' AND EXISTS(SELECT 1 FROM collection_classification_run_actions a
          JOIN collection_classification_runs r ON r.id=a.run_id WHERE r.principal_id=p_account_id AND a.action_id=charge.task_id)) THEN
        RAISE EXCEPTION 'credit owner must finish through its recovery transaction' USING ERRCODE='P0001';
      END IF;
      -- The immutable charge and operation key remain as a permanent replay fence.
      IF charge.task_kind='classification_preview' THEN
        BEGIN operation:=charge.operation_key::jsonb; EXCEPTION WHEN invalid_text_representation THEN operation:=NULL; END;
        IF jsonb_typeof(operation)='array' AND jsonb_array_length(operation)=2 THEN
          scope:=operation->>0;command:=operation->>1;
          PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(p_account_id,scope,command)::text,0));
          PERFORM 1 FROM product_command_receipts WHERE principal_id=p_account_id AND command_scope=scope AND command_id=command FOR UPDATE;
          body:=convert_to(jsonb_build_object('error',jsonb_build_object(
            'code','feature_temporarily_unavailable','message','Classification could not be recovered.',
            'requestId','credit-recovery-'||gen_random_uuid()::text,'recovery','user_action','sameRequestRetrySafe',false,
            'precondition',NULL,'currentEtag',NULL,'retryAfterSeconds',NULL,'fieldErrors','[]'::jsonb))::text,'UTF8');
          UPDATE product_command_receipts SET result_status=503,result_headers='{"content-type":"application/json; charset=utf-8","cache-control":"private, no-store"}'::jsonb,
            result_media_type='application/json',result_bytes=body,result_digest=encode(sha256(body),'hex'),contract_version='1.0.0',
            completed_at=clock_timestamp(),result_expires_at=clock_timestamp()+interval '30 days'
            WHERE principal_id=p_account_id AND command_scope=scope AND command_id=command AND completed_at IS NULL;
        END IF;
      END IF;
      UPDATE credit_accounts SET integrity_blocked=true WHERE account_id=p_account_id;
      RETURN credit_finish(p_account_id,p_charge_id,false,'classification_failed');
    END $function$`).execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${fn}(text,uuid) FROM PUBLIC`).execute(db);
  await sql.raw(`DO $block$ BEGIN IF to_regrole('known_credits_operator') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ${fn}(text,uuid) TO known_credits_operator;
  END IF; END $block$`).execute(db);
}
