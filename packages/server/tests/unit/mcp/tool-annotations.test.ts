import assert from 'node:assert/strict';
import { test } from 'vitest';
import { annotateMcpTool } from '../../../src/modules/mcp/tool-annotations.js';

test('query tools are read-only while trusted moves still advertise their write effects', () => {
  for (const name of ['collections.list', 'collections.get', 'collections.get_snapshot', 'nodes.get', 'nodes.search', 'changes.get']) {
    const tool = annotateMcpTool({ name } as { name: string; annotations?: Record<string, unknown> });
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
  }
  const move = annotateMcpTool({ name: 'nodes.move' } as { name: string; annotations?: Record<string, unknown> });
  assert.equal(move.annotations?.readOnlyHint, false);
  assert.equal(move.annotations?.destructiveHint, true);
});
