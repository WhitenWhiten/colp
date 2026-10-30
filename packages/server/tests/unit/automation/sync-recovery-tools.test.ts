import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { callAutomationAccountTool } from '../../../src/modules/mcp/automation-account-tools.js';
import type { ProductSyncCenterPorts } from '../../../src/modules/sync/index.js';
import { AUTOMATION_TOOL_CONTRACTS } from '../../../src/modules/mcp/automation-tool-contracts.generated.js';
import { createAjv } from '@know-n/colp/schema';

const actor = { accountId: 'owner', subjectId: 'subject', clientId: 'manager', credentialBindingId: 'binding',
  scopes: ['automation:read', 'automation:manage', 'nodes:write', 'mcp:read:own'] };
test('conflict resolution binds current owner, subject, revision and an exact replay fingerprint', async () => {
  const resolveConflict = vi.fn(async () => ({ kind: 'committed', result: { conflictId: 'conflict', status: 'resolved' } }));
  const reads = { resolveConflict } as unknown as ProductSyncCenterPorts;
  const ports = { sync: { execute: async <T>(work: (p: ProductSyncCenterPorts) => Promise<T>) => work(reads) } };
  const args = { conflictId: 'conflict', baseRevision: 'revision', commandId: randomUUID(), resolution: 'server' };
  expect(await callAutomationAccountTool(ports, actor, 'automation.sync.resolve_conflict', args)).toMatchObject({ status: 'resolved' });
  await callAutomationAccountTool(ports, actor, 'automation.sync.resolve_conflict', args);
  expect(resolveConflict.mock.calls[0]).toEqual(resolveConflict.mock.calls[1]);
  expect(resolveConflict).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'owner', subjectId: 'subject', expectedRevision: 'revision' }));
  await expect(callAutomationAccountTool(ports, { ...actor, scopes: ['automation:manage'] }, 'automation.sync.resolve_conflict', args))
    .rejects.toMatchObject({ code: 'insufficient_permission' });
});

test('rebuild requires explicit confirmation and the reviewed lifecycle revision', async () => {
  const sendReplicaCommand = vi.fn(async () => ({ kind: 'committed', result: { state: 'pending' } }));
  const reads = { sendReplicaCommand } as unknown as ProductSyncCenterPorts;
  const ports = { sync: { execute: async <T>(work: (p: ProductSyncCenterPorts) => Promise<T>) => work(reads) } };
  const args = { replicaId: 'replica', baseRevision: '17', commandId: randomUUID(), action: 'rebuild' };
  await expect(callAutomationAccountTool(ports, actor, 'automation.sync.replica_command', args)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(sendReplicaCommand).not.toHaveBeenCalled();
  await callAutomationAccountTool(ports, actor, 'automation.sync.replica_command', { ...args, confirmation: 'rebuild_replica' });
  expect(sendReplicaCommand).toHaveBeenCalledWith(expect.objectContaining({ expectedLifecycleRevision: '17', action: 'rebuild' }));
  const tool = AUTOMATION_TOOL_CONTRACTS.find(t => t.name === 'automation.sync.replica_command')!;
  const validate = createAjv().compile(tool.inputSchema);
  expect(validate(args)).toBe(false); expect(validate({ ...args, confirmation: 'rebuild_replica' })).toBe(true);
});
