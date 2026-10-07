import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachNodeLinkHealth } from '../../../src/modules/mcp/node-resources.js';

test('an MCP node read includes the stored link health state', () => {
  const core = { id: 'node-1', kind: 'bookmark', url: 'https://example.test' };
  assert.deepEqual(attachNodeLinkHealth(core, 'broken'), { ...core, linkHealth: 'broken' });
  assert.equal(attachNodeLinkHealth(core, null), core);
});
