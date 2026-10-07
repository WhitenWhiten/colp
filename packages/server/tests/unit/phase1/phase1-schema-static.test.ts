import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

describe('Phase 1 schema migration static contract', () => {
  test('has one sortable migration and explicit down migration', async () => {
    const source = await readFile(new URL('../../../migrations/202607220900_phase1_schema.ts', import.meta.url), 'utf8');
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.match(source, /export const migration/);
    assert.doesNotMatch(source, /publications|sync_sessions|subscriptions|attachments|search_documents/);
  });
});
