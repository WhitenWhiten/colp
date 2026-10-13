import { sql,type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_event_deliveries (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    run_id text NOT NULL REFERENCES automation_runs(id),job_id text NOT NULL REFERENCES automation_jobs(id),
    target_id text NOT NULL REFERENCES automation_targets(id),subscription_id text NOT NULL REFERENCES automation_event_subscriptions(id),
    subscription_generation bigint NOT NULL,body text NOT NULL CHECK(octet_length(body)<=262144),
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','retrying','deadLetter','cancelled')),
    generation bigint NOT NULL DEFAULT 0,attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz DEFAULT clock_timestamp(),lease_until timestamptz,last_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(job_id,subscription_id)
  );
  CREATE INDEX automation_delivery_ready ON automation_event_deliveries(state,next_attempt_at);
  CREATE FUNCTION automation_enqueue_wake() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE event_id text; recipient record; run_record record;
  BEGIN
    IF NEW.state <> 'ready' OR (TG_OP='UPDATE' AND OLD.state='ready') THEN RETURN NEW; END IF;
    SELECT r.*,v.rule_id,v.revision AS rule_revision INTO run_record FROM automation_runs r
      JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE r.id=NEW.run_id;
    FOR recipient IN SELECT s.* FROM automation_event_subscriptions s JOIN automation_targets t ON t.id=s.target_id
      JOIN automation_connection_profiles p ON p.id=s.profile_id
      WHERE s.target_id=NEW.target_id AND s.state='active' AND s.refresh_before>clock_timestamp()
      AND t.paired AND NOT t.revoked AND coalesce(t.configuration_json->>'wakeMode','events')='events'
      AND s.pairing_generation=t.pairing_generation AND s.profile_revision=p.revision
    LOOP
      event_id := gen_random_uuid()::text;
      INSERT INTO automation_event_deliveries(id,owner_id,run_id,job_id,target_id,subscription_id,subscription_generation,body)
      VALUES(event_id,run_record.owner_id,NEW.run_id,NEW.id,NEW.target_id,recipient.id,recipient.generation,
        jsonb_build_object('eventId',event_id,'name','colp.automation.triggered','timestamp',clock_timestamp(),'cursor',NULL,
          'data',jsonb_build_object('runId',NEW.run_id,'jobId',NEW.id,'ruleId',run_record.rule_id,
          'ruleRevision',run_record.rule_revision::text,'targetId',NEW.target_id,'matchedCount',jsonb_array_length(run_record.member_ids),
          'deliveryHandle',NEW.delivery_handle))::text) ON CONFLICT(job_id,subscription_id) DO NOTHING;
    END LOOP;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_job_wake AFTER INSERT OR UPDATE OF state ON automation_jobs FOR EACH ROW EXECUTE FUNCTION automation_enqueue_wake();
  CREATE FUNCTION automation_cancel_target_wakes() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.revoked OR NOT NEW.paired OR coalesce(NEW.configuration_json->>'wakeMode','events')='poll' OR NEW.pairing_generation<>OLD.pairing_generation THEN
      UPDATE automation_event_subscriptions SET state='revoked',generation=generation+1,secret_ciphertext=NULL,previous_secret_ciphertext=NULL WHERE target_id=NEW.id AND state IN ('active','verifying');
      UPDATE automation_event_deliveries SET state='cancelled',generation=generation+1,lease_until=NULL,next_attempt_at=NULL WHERE target_id=NEW.id AND state IN ('pending','sending','retrying');
    END IF; RETURN NEW;
  END $$;
  CREATE TRIGGER automation_target_cancel_wakes AFTER UPDATE ON automation_targets FOR EACH ROW EXECUTE FUNCTION automation_cancel_target_wakes();`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER automation_target_cancel_wakes ON automation_targets; DROP FUNCTION automation_cancel_target_wakes();
    DROP TRIGGER automation_job_wake ON automation_jobs; DROP FUNCTION automation_enqueue_wake();DROP TABLE automation_event_deliveries;`.execute(db);
}
