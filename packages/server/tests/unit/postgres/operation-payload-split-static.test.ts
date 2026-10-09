import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const PRIMITIVE = 'src/infrastructure/database/operation-payload-store.ts';

async function sourceFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

test('all production Operation inserts use the atomic fact plus payload primitive', async () => {
  // The attachment canonical mutation port left with the attachments module
  // (tests/EXTRACTION.md). Instead of naming the remaining inserters, every
  // production source is scanned so a new inserter cannot bypass the primitive.
  const files = [
    'src/infrastructure/collections/repositories.ts',
    'src/infrastructure/collections/canonical-mutation-postgres-ports.ts',
    'src/infrastructure/sync/sync-conflict-postgres.ts',
    'src/infrastructure/sync/sync-conflict-resolution-postgres.ts',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.match(source, /appendOperationWithPayload/u, file);
  }
  const primitivePath = fileURLToPath(new URL(PRIMITIVE, ROOT));
  for (const file of await sourceFiles(new URL('src/', ROOT))) {
    if (file === primitivePath) continue;
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /insertInto\(['"]operations['"]\)|insert\s+into\s+operations\b/iu, file);
  }
  const primitive = await readFile(new URL(PRIMITIVE, ROOT), 'utf8');
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
  ]) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /operation\.payload_json|operation\.sync_wire_json/iu, file);
  }
});
