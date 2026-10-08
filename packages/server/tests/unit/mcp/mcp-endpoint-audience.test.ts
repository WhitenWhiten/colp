import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isMcpAudienceForEndpoint } from '../../../src/transport/mcp/mcp-endpoint-audience.js';

const strict = '/collections/-/mcp', compat = '/collections/-/mcp-compat';
for (const path of [strict, compat]) {
  test(`verified OAuth resource is confined to ${path}`, () => {
    const other = path === strict ? compat : strict;
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${path}`, path, 'https://known.test'), true);
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${other}`, path, 'https://known.test'), false);
    for (const suffix of ['/', '?resource=other', '#other']) {
      assert.equal(isMcpAudienceForEndpoint(`https://known.test${path}${suffix}`, path, 'https://known.test'), false);
    }
  });
}
test('missing/unknown router targets and malformed resource bindings fail closed', () => {
  for (const path of [undefined, null, '', '/anything', `${strict}?x=1`]) {
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${strict}`, path, 'https://known.test'), false);
  }
  for (const resource of ['not a URL', `file://${strict}`, `https://user:pass@known.test${strict}`]) {
    assert.equal(isMcpAudienceForEndpoint(resource, strict, 'https://known.test'), false);
  }
});


test('request admission compares the full configured endpoint origin', () => {
  assert.equal(isMcpAudienceForEndpoint('https://known.test/collections/-/mcp', strict, 'https://known.test'), true);
  assert.equal(isMcpAudienceForEndpoint('https://known.test:443/collections/-/mcp', strict, 'https://known.test'), true);
  assert.equal(isMcpAudienceForEndpoint('http://known.test/collections/-/mcp', strict, 'https://known.test'), false);
  assert.equal(isMcpAudienceForEndpoint('https://foreign.test/collections/-/mcp', strict, 'https://known.test'), false);
  assert.equal(isMcpAudienceForEndpoint('https://known.test:8443/collections/-/mcp', strict, 'https://known.test'), false);
});
