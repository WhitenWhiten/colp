import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

const migrationPath = 'migrations/202610011000_operation_lookup_facts.ts';
const migration = readFileSync(migrationPath, 'utf8');

test('operation lookup migration retains minimal exact immutable facts', () => {
  assert.match(migration, /CREATE TABLE operation_lookup_facts/iu);
  assert.match(migration, /command_id text/iu);
  assert.match(migration, /attachment_id text NOT NULL/iu);
  assert.match(migration, /blob_id text NOT NULL/iu);
  assert.match(migration, /ON DELETE RESTRICT/iu);
  assert.match(migration, /operation_lookup_facts_attachment_unique/iu);
  assert.match(migration, /CREATE UNIQUE INDEX operation_lookup_facts_command_unique/iu);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON operation_lookup_facts/iu);
  assert.match(migration, /BEFORE TRUNCATE ON operation_lookup_facts/iu);
  assert.match(migration, /backfill failed exactness validation/iu);
  assert.match(migration, /hot payload reconstruction is incomplete/iu);
  const tableDefinition = migration.match(
    /CREATE TABLE operation_lookup_facts[\s\S]*?\n  \)`\.execute/u,
  )?.[0] ?? '';
  assert.doesNotMatch(tableDefinition, /jsonb/iu);
});

test('the sole Operation append primitive materializes recognized lookup facts', () => {
  const source = readFileSync('src/infrastructure/database/operation-payload-store.ts', 'utf8');
  assert.match(source, /INSERT INTO operation_lookup_facts/iu);
  assert.match(source, /operation_lookup_fact_text\(payload_json, 'commandId', false\)/u);
  assert.match(source, /operation_type IN \('attachment\.finalized', 'attachment\.retired'\)/u);
});

test('production attachment identity lookups never inspect archiveable payload JSON', () => {
  const lookup = readFileSync('src/infrastructure/database/operation-payload-lookups.ts', 'utf8');
  assert.match(lookup, /JOIN operation_lookup_facts fact/iu);
  assert.doesNotMatch(lookup, /operation_payloads|payload_json|operation_payload_unavailable/iu);

  const offenders = sourceFiles('src').filter((file) => {
    const source = readFileSync(file, 'utf8');
    return /operation_payloads[\s\S]{0,800}->>\s*'(commandId|attachmentId|blobId)'/u.test(source)
      || /->>\s*'(commandId|attachmentId|blobId)'[\s\S]{0,800}operation_payloads/u.test(source);
  });
  assert.deepEqual(offenders, []);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
