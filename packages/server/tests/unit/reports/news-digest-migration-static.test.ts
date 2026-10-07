import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/202610011500_news_digest_schema.ts',
  import.meta.url,
);
const triggerFixUrl = new URL(
  '../../../migrations/202610011600_news_digest_owner_trigger_fix.ts',
  import.meta.url,
);
const fanoutCursorUrl = new URL(
  '../../../migrations/202610011700_news_digest_source_fanout_continuation.ts',
  import.meta.url,
);
const subjectRemapUrl = new URL(
  '../../../migrations/202610012000_digest_subject_id_remap.ts',
  import.meta.url,
);
const ownerGuardUrl = new URL(
  '../../../migrations/202610101200_digest_owner_membership_guard.ts',
  import.meta.url,
);
const cascadeUrl = new URL(
  '../../../src/infrastructure/seed/subject-id-reference-cascade.ts',
  import.meta.url,
);

describe('News Digest ND-03 migration static contract', () => {
  test('creates the public digest schema with global identities and fail-closed FKs', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    for (const table of [
      'digest_series', 'digest_editions', 'digest_members', 'digest_follows',
      'digest_schedules', 'digest_runs', 'digest_audit_events',
    ]) assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
    assert.match(source, /digest_series[\s\S]*id text PRIMARY KEY REFERENCES resource_id_ledger[\s\S]*ON DELETE RESTRICT/i);
    assert.match(source, /digest_editions[\s\S]*source_collection_id text NOT NULL REFERENCES collections\(id\) ON DELETE RESTRICT/i);
    assert.match(source, /owner_subject_id text NOT NULL REFERENCES accounts\(subject_id\) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE/i);
    assert.match(source, /subject_id text NOT NULL REFERENCES accounts\(subject_id\) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE/i);
    assert.match(source, /digest_series_slug_unique[\s\S]*WHERE slug IS NOT NULL/i);
    assert.match(source, /digest_editions_issue_key_unique/i);
    assert.match(source, /digest_editions_published_state_check/i);
    assert.match(source, /digest_runs_lease_state_check/i);
    assert.match(source, /digest_runs_command_id_unique/i);
    assert.match(source, /digest_editions_rebind_guard/i);
    assert.match(source, /digest_series_owner_membership_guard/i);
    assert.match(source, /digest_audit_events_series_time_idx/i);
    assert.match(source, /known\.append_heavy=true/i);
  });

  test('is expand-only and does not provide a destructive down path', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    assert.doesNotMatch(source, /DROP\s+(TABLE|INDEX|TRIGGER)/i);
    assert.match(source, /down\(_db: Kysely<unknown>\)/);
  });

  test('expand-only up is re-entrant after an empty down', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    const fanout = await readFile(fanoutCursorUrl, 'utf8');
    assert.match(source, /Empty `down` leaves objects in place[\s\S]*up` must be re-entrant/u);
    assert.match(source, /CREATE TABLE IF NOT EXISTS digest_series/u);
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS digest_series_slug_unique/u);
    assert.match(source, /CREATE OR REPLACE FUNCTION forbid_digest_edition_rebind/u);
    assert.match(source, /CREATE OR REPLACE TRIGGER digest_editions_rebind_guard/u);
    assert.match(source, /CREATE CONSTRAINT TRIGGER digest_series_owner_membership_guard/u);
    assert.match(source, /CREATE CONSTRAINT TRIGGER digest_members_owner_membership_guard/u);
    assert.match(source, /WHEN duplicate_object/u);
    assert.doesNotMatch(source, /CREATE OR REPLACE CONSTRAINT TRIGGER/u);
    assert.match(fanout, /CREATE TABLE IF NOT EXISTS digest_source_invalidation_progress/u);
    assert.match(fanout, /CREATE INDEX IF NOT EXISTS digest_source_invalidation_progress_collection_idx/u);
  });

  test('owner trigger dereferences polymorphic OLD/NEW fields only in table-specific branches', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    const fix = await readFile(triggerFixUrl, 'utf8');
    for (const body of [source, fix]) {
      assert.match(body, /IF TG_TABLE_NAME = 'digest_members' THEN[\s\S]*OLD\.role/u);
      assert.match(body, /IF TG_TABLE_NAME = 'digest_series' THEN[\s\S]*target_series := NEW\.id/u);
    }
    assert.match(fix, /CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership/u);
  });

  test('digest subject copies can remap with accounts.subject_id in one transaction', async () => {
    const remap = await readFile(subjectRemapUrl, 'utf8');
    const cascade = await readFile(cascadeUrl, 'utf8');
    assert.match(remap, /ALTER CONSTRAINT digest_series_owner_subject_id_fkey/u);
    assert.match(remap, /ALTER CONSTRAINT digest_members_subject_id_fkey/u);
    assert.match(remap, /ADD CONSTRAINT digest_series_owner_subject_id_fkey/u);
    assert.match(remap, /ADD CONSTRAINT digest_members_subject_id_fkey/u);
    assert.match(remap, /connamespace = current_schema\(\)::regnamespace/u);
    assert.match(remap, /DEFERRABLE INITIALLY IMMEDIATE/u);
    assert.match(remap, /NEW\.role <> 'owner' OR NEW\.revoked_at IS NOT NULL/u);
    assert.doesNotMatch(remap, /NEW\.subject_id IS DISTINCT FROM OLD\.subject_id/u);
    assert.match(remap, /NOT EXISTS \(SELECT 1 FROM digest_editions e WHERE e\.series_id = OLD\.series_id\)/u);
    assert.match(remap, /NOT EXISTS \(SELECT 1 FROM digest_follows f WHERE f\.series_id = OLD\.series_id\)/u);
    assert.match(remap, /NOT EXISTS \(SELECT 1 FROM digest_schedules s WHERE s\.series_id = OLD\.series_id\)/u);
    assert.match(remap, /down\(_db: Kysely<unknown>\)/);
    assert.match(cascade, /digest_series_owner_subject_id_fkey/u);
    assert.match(cascade, /digest_members_subject_id_fkey/u);
    assert.match(cascade, /condeferrable/u);
    assert.match(cascade, /connamespace = current_schema\(\)::regnamespace/u);
    assert.match(cascade, /SET CONSTRAINTS ' \|\| digest_subject_fks \|\| ' DEFERRED/u);
    assert.match(cascade, /UPDATE digest_members m/u);
    assert.match(cascade, /SET CONSTRAINTS ALL IMMEDIATE/u);
  });

  test('owner teardown exception requires the series row itself to be gone', async () => {
    const guard = await readFile(ownerGuardUrl, 'utf8');
    assert.match(guard, /CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership/u);
    assert.match(guard,
      /NOT EXISTS \(SELECT 1 FROM digest_series s WHERE s\.id = OLD\.series_id\)/u);
    assert.doesNotMatch(guard,
      /NOT EXISTS \(SELECT 1 FROM digest_(editions|follows|schedules)/u);
    assert.match(guard, /OLD\.role = 'owner'[\s\S]*digest owner membership cannot be revoked/u);
    assert.match(guard, /down\(_db: Kysely<unknown>\)/u);
    assert.doesNotMatch(guard, /DROP\s+(FUNCTION|TRIGGER|TABLE)/iu);
  });

  test('source invalidation fan-out has an expand-only durable keyset cursor', async () => {
    const source = await readFile(fanoutCursorUrl, 'utf8');
    assert.match(source, /CREATE TABLE IF NOT EXISTS digest_source_invalidation_progress/u);
    assert.match(source, /domain_event_id text PRIMARY KEY REFERENCES resource_id_ledger/u);
    assert.match(source, /after_slug text/u);
    assert.match(source, /CREATE INDEX IF NOT EXISTS digest_source_invalidation_progress_collection_idx/u);
    assert.doesNotMatch(source, /DROP TABLE/u);
  });
});
