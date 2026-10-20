import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const node = duplicateNodeDocument({ ...payload.current, description: 'Server note', extensions: {},
    canonicalUrl: 'https://canonical.test/before',
    urlHash: `sha-256=:${createHash('sha256').update(payload.current.url as string).digest('base64')}:`,
  }, payload, ['/title']);
  assert.equal(node.kind, 'bookmark');
  assert.equal(node.title, 'Incoming');
  assert.equal(node.url, 'https://example.test/after');
  assert.equal(node.description, 'Server note');
  assert.equal('urlHash' in node, false);
  assert.equal('canonicalUrl' in node, false);
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

test.each(['server', 'incoming', 'custom', 'both'] as const)(
  '%s settles competing namespaces without losing independent additions, removals or explicit null', resolution => {
    const ns = (name: string) => `https://extensions.example/${name}`;
    const base = { [ns('competing')]: 1, [ns('local-removal')]: 'old-local',
      [ns('remote-removal')]: 'old-remote', [ns('null')]: 'old-null' };
    const current = { [ns('competing')]: 2, [ns('local-removal')]: 'old-local',
      [ns('null')]: 'old-null', [ns('remote-addition')]: { source: 'server' } };
    const incoming = { [ns('competing')]: 3, [ns('remote-removal')]: 'old-remote',
      [ns('null')]: null, [ns('local-addition')]: { source: 'browser' } };
    const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
      base: { extensions: base }, current: { extensions: current }, incoming: { extensions: incoming } };
    const canonical = { title: 'Bookmark', url: 'https://example.test/', extensions: current };
    const chosen = resolution === 'both' ? duplicateNodeDocument(canonical, retained, ['/extensions']).extensions
      : selectedResolutionFields({ ...command(resolution),
        ...(resolution === 'custom' ? { value: { [ns('competing')]: 4 } } : {}) },
      canonical, retained, ['/extensions']).value.extensions;
    assert.deepEqual(chosen, { [ns('competing')]: resolution === 'server' ? 2 : resolution === 'custom' ? 4 : 3,
      [ns('remote-addition')]: { source: 'server' }, [ns('local-addition')]: { source: 'browser' }, [ns('null')]: null });
  });

test.each([null, {}])('a custom namespace deletion (%j) preserves independent namespaces', choice => {
  const conflict = 'https://extensions.example/competing', added = 'https://extensions.example/added';
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark', base: { extensions: { [conflict]: 1 } },
    current: { extensions: { [conflict]: 2, [added]: null } }, incoming: { extensions: { [conflict]: 3 } } };
  const selected = selectedResolutionFields({ ...command('custom'), value: choice },
    retained.current, retained, ['/extensions']);
  assert.deepEqual(selected.value.extensions, { [added]: null });
});

test('a later conflict on a retained URL cannot be overwritten; both still preserves the edit', () => {
  const current = { ...payload.current, url: 'https://example.test/newer' };
  assert.throws(() => selectedResolutionFields(command('incoming'), current, payload, ['/title']),
    (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'precondition_failed');
  const duplicate = duplicateNodeDocument(current, payload, ['/title']);
  assert.equal(duplicate.kind, 'bookmark');
  assert.equal(duplicate.url, 'https://example.test/after');
});

test.each(['folder', 'separator'] as const)('recovers the edited %s content without copying system roles or deletion state', kind => {
  const deleted = { title: 'Before', description: 'Before note', deletedAt: '2026-10-17T00:00:00Z',
    folderRole: 'recovered' };
  const privatePayload: PrivateConflictPayload = { nodeKind: kind, base: { description: 'Before note' },
    current: deleted, incoming: { description: 'Unique offline note' } };
  const recovered = duplicateNodeDocument(deleted, privatePayload, ['/deletedAt', '/description']);
  assert.equal(recovered.kind, kind);
  assert.equal(recovered.description, 'Unique offline note');
  assert.equal('folderRole' in recovered, false);
  assert.equal('deletedAt' in recovered, false);
});

test('a legacy meta-only conflict can close against current content without inventing missing incoming intent', () => {
  const legacy: PrivateConflictPayload = { nodeKind: 'bookmark', base: {}, current: {}, incoming: {} };
  const current = { title: 'Current title', url: 'https://example.test/current' };
  const selected = selectedResolutionFields(command('server'), current, legacy, ['/baseRevision']);
  assert.deepEqual(selected, { base: { title: 'Current title' }, value: { title: 'Current title' } });
  assert.throws(() => selectedResolutionFields(command('incoming'), current, legacy, ['/baseRevision']),
    (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'unsupported_operation');
});
