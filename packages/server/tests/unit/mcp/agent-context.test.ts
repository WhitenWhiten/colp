import { describe, expect, it, vi } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { CanonicalMutationInput, CanonicalMutationResult } from '../../../src/modules/collections/index.js';
import { mcpAgentContext, withMcpAgentContext } from '../../../src/modules/mcp/agent-context.js';

const binding: McpAuthenticatedAuthorizationBinding = { kind: 'authenticated', principalId: 'owner', clientId: 'client-1',
  credentialBindingId: 'credential-1', resourceAudience: 'colp://known/collections', securityEpoch: '1' };
const input: CanonicalMutationInput = { operationId: 'operation-1', collectionId: 'collection-1', actor: { principalId: 'owner', principalType: 'account' },
  mutation: { action: 'create', target: { collectionId: 'collection-1', resourceId: 'node-1', resourceKind: 'node' }, fields: { kindFields: {}, extensions: {} } } };
const result = {} as CanonicalMutationResult;

describe('verified MCP agent attribution', () => {
  it('copies only verified agent identifiers without altering the caller’s input or other ports', async () => {
    const execute = vi.fn(async (_input: CanonicalMutationInput) => result);
    const ports = { marker: 'preserved', canonical: { execute, anotherMethod: () => 'preserved' } };
    const wrapped = withMcpAgentContext(ports, binding);
    expect(mcpAgentContext(binding)).toEqual({ origin: 'mcp', agent: { clientId: 'client-1', credentialBindingId: 'credential-1' } });
    expect(await wrapped.canonical.execute(input)).toBe(result);
    expect(execute).toHaveBeenCalledWith({ ...input, automationContext: mcpAgentContext(binding) });
    expect(input.automationContext).toBeUndefined();
    expect(wrapped.marker).toBe('preserved');
    expect(wrapped.canonical.anotherMethod()).toBe('preserved');
    expect('executeMoves' in wrapped.canonical).toBe(false);
  });

  it('preserves explicit automation context and lineage for both single and batched writes', async () => {
    const automationContext = { origin: 'automation' as const, rootRunId: 'run-1', stageId: 'job-1', hopCount: 1 };
    const automated = { ...input, automationContext };
    const execute = vi.fn(async (_input: CanonicalMutationInput) => result);
    const executeMoves = vi.fn(async (_inputs: readonly CanonicalMutationInput[]) => [result]);
    const wrapped = withMcpAgentContext({ canonical: { execute, executeMoves } }, binding);
    await wrapped.canonical.execute(automated);
    expect(execute.mock.calls[0]![0].automationContext).toBe(automationContext);
    await wrapped.canonical.executeMoves([input, automated]);
    expect(executeMoves).toHaveBeenCalledWith([{ ...input, automationContext: mcpAgentContext(binding) }, automated]);
    expect(executeMoves.mock.calls[0]![0][1]!.automationContext).toBe(automationContext);
  });

  it('leaves a supplied MCP context intact and propagates an unsupported batch result', async () => {
    const context = mcpAgentContext({ ...binding, clientId: 'already-attributed' });
    const execute = vi.fn(async (_input: CanonicalMutationInput) => result);
    const executeMoves = vi.fn(async (_inputs: readonly CanonicalMutationInput[]) => undefined);
    const wrapped = withMcpAgentContext({ canonical: { execute, executeMoves } }, binding);
    expect(await wrapped.canonical.executeMoves([{ ...input, automationContext: context }])).toBeUndefined();
    expect(executeMoves.mock.calls[0]![0][0]!.automationContext).toBe(context);
  });
});
