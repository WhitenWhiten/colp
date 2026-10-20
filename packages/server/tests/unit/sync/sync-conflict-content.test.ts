import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectedResolutionFields, duplicateNodeDocument } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { SyncConflictResolutionError, validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';
import type { PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';

const payload: PrivateConflictPayload = {
  nodeKind: 'bookmark', base: { title: 'Base', url: 'https://example.test/before' },
  current: { title: 'Server', url: 'https://example.test/before' },
  incoming: { title: 'Incoming', url: 'https://example.test/after' },
};
function command(resolution: 'server' | 'incoming' | 'custom') {
  return validateSyncConflictResolutionCommand({ conflictId: 'conflict-1', idempotencyKey: 'resolution-1',
    ifMatch: ['"conflict-r1"'], request: { resolution, baseConflictRevision: 'conflict-r1',
      ...(resolution === 'custom' ? { value: 'Custom' } : {}) } });
}

test.each([['server', 'Server'], ['incoming', 'Incoming'], ['custom', 'Custom']] as const)(
  '%s settles the title while preserving the same operation URL edit', (resolution, title) => {
    const selected = selectedResolutionFields(command(resolution), payload.current, payload, ['/title']);
    assert.deepEqual(selected.value, { title, url: 'https://example.test/after' });
    assert.deepEqual(selected.base, payload.current);
  });

test('both preserves the complete incoming bookmark and unrelated current metadata', () => {
  const node = duplicateNodeDocument({ ...payload.current, description: 'Server note', extensions: {} }, payload, ['/title']);
  assert.equal(node.kind, 'bookmark');
  assert.equal(node.title, 'Incoming');
  assert.equal(node.url, 'https://example.test/after');
  assert.equal(node.description, 'Server note');
});

test('resolution preserves concurrent additions in a retained nonconflicting extension map', () => {
  const independent = { ...payload, base: { ...payload.base, extensions: {} },
    incoming: { ...payload.incoming, extensions: { 'https://example.test/local': { value: 1 } } } };
  const selected = selectedResolutionFields(command('incoming'),
    { ...payload.current, extensions: { 'https://example.test/remote': { value: 2 } } }, independent, ['/title']);
  assert.deepEqual(selected.value.extensions, {
    'https://example.test/local': { value: 1 }, 'https://example.test/remote': { value: 2 },
  });
});

test('a later conflict on a retained URL cannot be overwritten; both still preserves the edit', () => {
  const current = { ...payload.current, url: 'https://example.test/newer' };
  assert.throws(() => selectedResolutionFields(command('incoming'), current, payload, ['/title']),
    (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'precondition_failed');
  const duplicate = duplicateNodeDocument(current, payload, ['/title']);
  assert.equal(duplicate.kind, 'bookmark');
  assert.equal(duplicate.url, 'https://example.test/after');
});
