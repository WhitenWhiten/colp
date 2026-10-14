import { sql, type Kysely } from 'kysely';
/** Preserve revision history while allowing explicit parent/account erasure cascades. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION automation_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF TG_TABLE_NAME = 'automation_rule_revisions' THEN
            IF NOT EXISTS (SELECT 1 FROM automation_rules WHERE id = OLD.rule_id)
              OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.owner_id) THEN RETURN OLD; END IF;
          ELSIF TG_TABLE_NAME = 'automation_binding_revisions' THEN
            IF NOT EXISTS (SELECT 1 FROM automation_binding_sets b JOIN accounts a ON a.id = b.owner_id
              WHERE b.id = OLD.binding_set_id) THEN RETURN OLD; END IF;
          END IF;
        END IF;
        RAISE EXCEPTION 'automation revisions are immutable';
      END $$;
    DROP TRIGGER automation_rule_revision_immutable ON automation_rule_revisions;
    DROP TRIGGER automation_binding_revision_immutable ON automation_binding_revisions;
    CREATE TRIGGER automation_rule_revision_immutable BEFORE UPDATE OR DELETE ON automation_rule_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
    CREATE TRIGGER automation_binding_revision_immutable BEFORE UPDATE OR DELETE ON automation_binding_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER automation_rule_revision_immutable ON automation_rule_revisions;
    DROP TRIGGER automation_binding_revision_immutable ON automation_binding_revisions;
    CREATE OR REPLACE FUNCTION automation_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'automation revisions are immutable'; END $$;
    CREATE TRIGGER automation_rule_revision_immutable BEFORE UPDATE ON automation_rule_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
    CREATE TRIGGER automation_binding_revision_immutable BEFORE UPDATE ON automation_binding_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
  `.execute(db);
}
