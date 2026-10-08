import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

test('all production Operation inserts use the atomic fact plus payload primitive', async () => {
  const files = [
    'src/infrastructure/collections/repositories.ts',
    'src/infrastructure/collections/canonical-mutation-postgres-ports.ts',
    'src/infrastructure/database/attachment-canonical-mutation-postgres.ts',
    'src/infrastructure/sync/sync-conflict-postgres.ts',
    'src/infrastructure/sync/sync-conflict-resolution-postgres.ts',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /insertInto\(['"]operations['"]\)|insert\s+into\s+operations/iu, file);
    assert.match(source, /appendOperationWithPayload/u, file);
  }
  const primitive = await readFile(new URL(
    'src/infrastructure/database/operation-payload-store.ts', ROOT,
  ), 'utf8');
  assert.match(primitive, /INSERT INTO operations/iu);
  assert.match(primitive, /INSERT INTO operation_payloads/iu);
});

test('production payload readers do not read JSON from the Operation fact spine', async () => {
  for (const file of [
    'src/infrastructure/sync/postgres/sync-pull-postgres.ts',
    'src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts',
    'src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts',
    'src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts',
    'src/infrastructure/sync/postgres/sync-recovery-postgres.ts',
    'src/infrastructure/sync/sync-bootstrap-snapshot-postgres.ts',
    'src/infrastructure/sync/sync-operation-effects-postgres.ts',
    'src/infrastructure/database/attachment-canonical-mutation-postgres.ts',
    'src/infrastructure/database/attachments-postgres-ports.ts',
  ]) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /operation\.payload_json|operation\.sync_wire_json/iu, file);
  }
});
