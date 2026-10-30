import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAjv } from '@know-n/colp/schema';
import { AUTOMATION_TOOL_CONTRACTS } from '../../../src/modules/mcp/automation-tool-contracts.generated.js';
import { deviceResultPage } from '../../../../extension/src/automation/device-bridge-result.js';

test('classification diagnostics accepts the returned continuation and history selector', () => {
  const tool = AUTOMATION_TOOL_CONTRACTS.find(t => t.name === 'automation.classification.diagnostics')!;
  const validate = createAjv({ allErrors: true }).compile(tool.inputSchema);
  const items = Array.from({ length: 21 }, () => ({ id: randomUUID(), state: 'attention' }));
  const first = deviceResultPage('request', items, {});
  expect(first.nextCursor).not.toBeNull();
  expect(validate({ replicaId: 'replica', commandId: randomUUID(), cursor: first.nextCursor, group: 'history' })).toBe(true);
  expect(validate({ replicaId: 'replica', commandId: randomUUID(), group: 'anything' })).toBe(false);
  expect(validate({ replicaId: 'replica', commandId: randomUUID(), cursor: '', foreign: true })).toBe(false);
});
