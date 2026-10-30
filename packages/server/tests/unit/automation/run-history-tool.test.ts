import { expect, test, vi } from 'vitest';
import { createAjv } from '@know-n/colp/schema';
import { AUTOMATION_TOOL_CONTRACTS } from '../../../src/modules/mcp/automation-tool-contracts.generated.js';
import { automationManagerReadOrRecover } from '../../../src/modules/mcp/automation-manager.js';
import type { AutomationPorts } from '../../../src/modules/automation/index.js';

test('bookmark history requires a complete identity and forwards it to owner-scoped reads', async () => {
  const tool = AUTOMATION_TOOL_CONTRACTS.find(t => t.name === 'automation.runs.list')!;
  const validate = createAjv().compile(tool.inputSchema);
  expect(validate({ nodeId: 'node' })).toBe(false);
  expect(validate({ collectionId: 'collection', nodeId: 'node' })).toBe(true);
  const list = vi.fn(async () => []);
  const ports = { now: async () => new Date(), runs: { list } } as unknown as AutomationPorts;
  await automationManagerReadOrRecover(ports, { accountId: 'owner', subjectId: 'subject' }, tool.name,
    { collectionId: 'collection', nodeId: 'node', limit: 10 }, 'test-key-with-at-least-thirty-two-bytes');
  expect(list).toHaveBeenCalledWith(null, 11, { collectionId: 'collection', nodeId: 'node' });
});
