import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs ADD COLUMN ready_generation bigint NOT NULL DEFAULT 0;
    ALTER TABLE automation_event_deliveries ADD COLUMN ready_generation bigint NOT NULL DEFAULT 0,
      DROP CONSTRAINT automation_event_deliveries_job_id_subscription_id_key,
      ADD CONSTRAINT automation_delivery_readiness UNIQUE(job_id,subscription_id,ready_generation);
    CREATE FUNCTION automation_advance_ready_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='ready' AND (TG_OP='INSERT' OR OLD.state<>'ready') THEN
        NEW.ready_generation := CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.ready_generation+1 END;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER automation_job_ready_generation BEFORE INSERT OR UPDATE OF state ON automation_jobs
      FOR EACH ROW EXECUTE FUNCTION automation_advance_ready_generation();
  CREATE OR REPLACE FUNCTION automation_enqueue_wake() RETURNS trigger LANGUAGE plpgsql AS $$
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
      INSERT INTO automation_event_deliveries(id,owner_id,run_id,job_id,target_id,subscription_id,subscription_generation,ready_generation,body)
      VALUES(event_id,run_record.owner_id,NEW.run_id,NEW.id,NEW.target_id,recipient.id,recipient.generation,NEW.ready_generation,
        jsonb_build_object('eventId',event_id,'name','colp.automation.triggered','timestamp',clock_timestamp(),'cursor',NULL,
          'data',jsonb_build_object('runId',NEW.run_id,'jobId',NEW.id,'ruleId',run_record.rule_id,
          'ruleRevision',run_record.rule_revision::text,'targetId',NEW.target_id,'matchedCount',jsonb_array_length(run_record.member_ids),
          'deliveryHandle',NEW.delivery_handle))::text) ON CONFLICT(job_id,subscription_id,ready_generation) DO NOTHING;
    END LOOP;
    RETURN NEW;
  END $$;
`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`  CREATE OR REPLACE FUNCTION automation_enqueue_wake() RETURNS trigger LANGUAGE plpgsql AS $$
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

    DROP TRIGGER automation_job_ready_generation ON automation_jobs;
    DROP FUNCTION automation_advance_ready_generation();
    ALTER TABLE automation_event_deliveries DROP CONSTRAINT automation_delivery_readiness;
    ALTER TABLE automation_event_deliveries DROP COLUMN ready_generation, ADD UNIQUE(job_id,subscription_id);
    ALTER TABLE automation_jobs DROP COLUMN ready_generation`.execute(db);
}
