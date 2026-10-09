import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607242200_public_profile_projection.ts', import.meta.url);

test('public profile migration hardens canonical handles and adds aligned identity/publication indexes', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /profile_handles_canonical_handle/u);
  assert.match(source, /lower\(handle\)/u);
  assert.match(source, /COLLATE "C"/u);
  assert.match(source, /UNIQUE INDEX/u);
  assert.match(source, /UPDATE profile_handles[\s\S]*SET handle = lower\(handle\)/u);
  assert.match(source, /profile_handles_handle_canonical_format/u);
  assert.match(source, /\^\[a-z0-9\._~-/u);
  assert.match(source, /collections_public_profile_owner_order_idx/u);
  assert.match(source, /owner_subject_id/u);
  assert.match(source, /updated_at DESC/u);
  assert.match(source, /id COLLATE "C"/u);
  assert.match(source, /visibility = 'public'/u);
  assert.match(source, /published_at IS NOT NULL/u);
  assert.match(source, /deleted_at IS NULL/u);
});

// Know-N's phase execution status document (docs/09-phase-execution-status.md)
// is project history, not part of this package (tests/EXTRACTION.md).
