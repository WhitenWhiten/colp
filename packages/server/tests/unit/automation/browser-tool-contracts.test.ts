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

test('classification previews accept exactly one incoming, capture or semantic source', () => {
  const tool = AUTOMATION_TOOL_CONTRACTS.find(t => t.name === 'automation.classification.preview')!;
  const validate = createAjv({ allErrors: true }).compile(tool.inputSchema), base = { replicaId: 'replica', commandId: randomUUID() };
  expect(validate({ ...base, jobId: 'semantic' })).toBe(true);
  expect(validate({ ...base, captureId: 'saved' })).toBe(true);
  expect(validate({ ...base, bookmark: { title: 'Article', url: 'https://example.org' } })).toBe(true);
  expect(validate(base)).toBe(false);
  expect(validate({ ...base, captureId: 'saved', jobId: 'semantic' })).toBe(false);
});

test('adapter controls require an explicit task kind, observed revision and supported action', () => {
  const tool = AUTOMATION_TOOL_CONTRACTS.find(t => t.name === 'automation.adapters.tasks.control')!;
  const validate = createAjv({ allErrors: true }).compile(tool.inputSchema);
  const request = { replicaId: 'replica', commandId: randomUUID(), connectionId: 'connection', taskKind: 'save',
    taskId: 'observation:original', revision: 'sha256:observed', action: 'retry' };
  expect(validate(request)).toBe(true);
  expect(validate({ ...request, action: 'approve' })).toBe(false);
  expect(validate({ ...request, taskKind: 'arbitraryStore' })).toBe(false);
});
