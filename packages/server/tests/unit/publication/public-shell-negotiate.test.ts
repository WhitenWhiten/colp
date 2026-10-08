import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  wantsColpCanonicalTombstone,
  wantsPublicShellMarkdown,
} from '../../../src/infrastructure/http/index.js';

test('text/markdown with q>0 wins over HTML; */* and missing Accept stay HTML', () => {
  assert.equal(wantsPublicShellMarkdown('text/markdown'), true);
  assert.equal(wantsPublicShellMarkdown('text/markdown;q=0.1, text/html;q=0.9'), true);
  assert.equal(wantsPublicShellMarkdown('text/html, text/markdown'), true);
  assert.equal(wantsPublicShellMarkdown('text/markdown;q=0'), false);
  assert.equal(wantsPublicShellMarkdown('text/html'), false);
  assert.equal(wantsPublicShellMarkdown('*/*'), false);
  assert.equal(wantsPublicShellMarkdown(''), false);
  assert.equal(wantsPublicShellMarkdown(undefined), false);
});

test('COLP tombstone still wins over markdown when protocol or vendor type is present', () => {
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
  assert.equal(wantsPublicShellMarkdown(markdown), true);
});
