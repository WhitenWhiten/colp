import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  wantsColpCanonicalTombstone,
} from '../../../src/transport/product/colp-canonical-negotiation.js';

test('COLP tombstone answers the vendor type or a protocol version; any other Accept is not a COLP request', () => {
  const markdown = 'text/markdown';
  const colp = 'application/vnd.collection-protocol.collection+json;version=0.1';
  assert.equal(wantsColpCanonicalTombstone({
    accept: `${markdown}, ${colp}`,
    protocolVersion: undefined,
  }), true);
  assert.equal(wantsColpCanonicalTombstone({
    accept: markdown,
    protocolVersion: '0.1',
  }), true);
  assert.equal(wantsColpCanonicalTombstone({
    accept: markdown,
    protocolVersion: undefined,
  }), false);
  assert.equal(wantsColpCanonicalTombstone({ accept: 'text/html', protocolVersion: undefined }), false);
  assert.equal(wantsColpCanonicalTombstone({ accept: '*/*', protocolVersion: undefined }), false);
  assert.equal(wantsColpCanonicalTombstone({ accept: undefined, protocolVersion: undefined }), false);
  assert.equal(wantsColpCanonicalTombstone({ accept: undefined, protocolVersion: ['', '0.2'] }), true);
});
