import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { mapSnapshotNode, SnapshotDocumentError, type SnapshotNodeRow } from '../../../src/infrastructure/collections/snapshot-document.js';

test('snapshots retain valid peer bookmark URL metadata and refuse corrupt hashes', () => {
  const url = 'https://example.test/peer';
  const urlHash = `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;
  const row: SnapshotNodeRow = {
    id: 'bookmark', collection_id: 'collection', parent_id: 'root', kind: 'bookmark',
    is_root: false, title: '', url, position_token: 'a0', visibility: 'inherit',
    resource_revision: 'r1', children_revision: null, created_at: new Date(), updated_at: new Date(),
    payload_json: { urlHash, canonicalUrl: 'https://canonical.test/peer' },
  };
  const node = mapSnapshotNode(row);
  assert.equal(node.kind, 'bookmark');
  if (node.kind !== 'bookmark') throw new Error('expected bookmark');
  assert.equal(node.title, '');
  assert.equal(node.urlHash, urlHash);
  assert.equal(node.canonicalUrl, 'https://canonical.test/peer');
  assert.throws(() => mapSnapshotNode({ ...row, url: 'https://example.test/changed' }), SnapshotDocumentError);
});
