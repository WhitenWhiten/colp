import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isMcpAudienceForEndpoint } from '../../../src/transport/mcp/mcp-endpoint-audience.js';

const strict = '/collections/-/mcp', compat = '/collections/-/mcp-compat';
for (const path of [strict, compat]) {
  test(`verified OAuth resource is confined to ${path}`, () => {
    const other = path === strict ? compat : strict;
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${path}`, path), true);
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${other}`, path), false);
    for (const suffix of ['/', '?resource=other', '#other']) {
      assert.equal(isMcpAudienceForEndpoint(`https://known.test${path}${suffix}`, path), false);
    }
  });
}
test('missing/unknown router targets and malformed resource bindings fail closed', () => {
  for (const path of [undefined, null, '', '/anything', `${strict}?x=1`]) {
    assert.equal(isMcpAudienceForEndpoint(`https://known.test${strict}`, path), false);
  }
  for (const resource of ['not a URL', `file://${strict}`, `https://user:pass@known.test${strict}`]) {
    assert.equal(isMcpAudienceForEndpoint(resource, strict), false);
  }
});
