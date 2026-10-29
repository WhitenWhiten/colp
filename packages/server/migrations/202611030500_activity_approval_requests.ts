import { sql, type Kysely } from 'kysely';

const EXISTING_KINDS = sql.raw(`'agent_bookmarks_added','run_completed','run_partial','run_failed','run_attention'`);

/**
 * An agent's Change Plan that waits for the owner's decision is one inbox item until it stops
 * waiting. Who asked is the plan's verified client binding; what it does is the plan's
 * server-built summary, read live. Approval, denial, expiry or any other move out of `pending`
 * removes the item, as resolved automation approvals are removed. Automation proposals share the
 * plan table but already ask through their run's `run_attention` item, so they get none here.
 * Plans that need no approval never ask. The account join keeps a plan save from ever failing on
 * a principal that is not an account.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE activity_items DROP CONSTRAINT activity_items_kind_check,
      ADD CONSTRAINT activity_items_kind_check CHECK (kind IN (${EXISTING_KINDS},'approval_requested')),
      ADD COLUMN plan_id text REFERENCES mcp_change_plans(plan_id) ON DELETE CASCADE;
    CREATE INDEX activity_items_plan ON activity_items(plan_id) WHERE plan_id IS NOT NULL;
    CREATE FUNCTION activity_record_plan_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO activity_items(id,account_id,kind,source_key,agent_client_id,plan_id)
        SELECT gen_random_uuid()::text,a.id,'approval_requested','plan:'||NEW.plan_id,NEW.client_id,NEW.plan_id
        FROM accounts a WHERE a.id=NEW.principal_id
          AND NOT EXISTS (SELECT 1 FROM automation_proposals p WHERE p.plan_id=NEW.plan_id)
      ON CONFLICT(account_id,source_key) DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER activity_plan_approval AFTER INSERT ON mcp_change_plans FOR EACH ROW
      WHEN (NEW.status='pending' AND NEW.requires_approval) EXECUTE FUNCTION activity_record_plan_approval();
    CREATE FUNCTION activity_clear_plan_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      DELETE FROM activity_items WHERE plan_id=NEW.plan_id AND kind='approval_requested';
      RETURN NEW;
    END $$;
    CREATE TRIGGER activity_plan_approval_resolved AFTER UPDATE OF status ON mcp_change_plans FOR EACH ROW
      WHEN (OLD.status='pending' AND NEW.status IS DISTINCT FROM OLD.status)
      EXECUTE FUNCTION activity_clear_plan_approval();
    -- Requests already waiting when this ships.
    INSERT INTO activity_items(id,account_id,kind,source_key,agent_client_id,plan_id,occurred_at)
      SELECT gen_random_uuid()::text,a.id,'approval_requested','plan:'||m.plan_id,m.client_id,m.plan_id,m.created_at
      FROM mcp_change_plans m JOIN accounts a ON a.id=m.principal_id
      WHERE m.status='pending' AND m.requires_approval AND m.expires_at>clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM automation_proposals p WHERE p.plan_id=m.plan_id)
    ON CONFLICT(account_id,source_key) DO NOTHING;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER activity_plan_approval_resolved ON mcp_change_plans;
    DROP FUNCTION activity_clear_plan_approval();
    DROP TRIGGER activity_plan_approval ON mcp_change_plans;
    DROP FUNCTION activity_record_plan_approval();
    DELETE FROM activity_items WHERE kind='approval_requested';
    ALTER TABLE activity_items DROP COLUMN plan_id, DROP CONSTRAINT activity_items_kind_check,
      ADD CONSTRAINT activity_items_kind_check CHECK (kind IN (${EXISTING_KINDS}));`.execute(db);
}
