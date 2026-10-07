import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

test('all production audit writers use the atomic header/payload helper', () => {
  const files = typescriptFiles('src').filter((file) => readFileSync(file, 'utf8').includes('audit_events'));
  const offenders = files.filter((file) => file !== 'src/infrastructure/database/audit-event-payload.ts')
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /insertInto\(['"]audit_events|insert\s+into\s+audit_events/iu.test(source);
    });
  assert.deepEqual(offenders, []);
});

test('archive mutation has no test bypass and is gated by role plus transaction identity', () => {
  const migration = readFileSync('migrations/202610010600_audit_payload_split.ts', 'utf8');
  assert.equal(migration.includes('test_cleanup'), false);
  assert.match(migration, /known_audit_payload_archiver/u);
  assert.match(migration, /pg_has_role\(session_user/u);
  assert.match(migration, /pg_current_xact_id\(\)::text/u);
  assert.match(migration, /audit_payload_archive_authorized\(\)/u);
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
