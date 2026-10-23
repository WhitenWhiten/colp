import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { CanonicalMutationInput, CanonicalMutationResult } from '../collections/index.js';

type CanonicalPort = {
  execute(input: CanonicalMutationInput): Promise<CanonicalMutationResult>;
  executeMoves?(inputs: readonly CanonicalMutationInput[]): Promise<readonly CanonicalMutationResult[] | undefined>;
};

/** Only the host-verified binding supplies agent identity; no tool payload is consulted. */
export function mcpAgentContext(binding: McpAuthenticatedAuthorizationBinding) {
  return { origin: 'mcp' as const, agent: { clientId: binding.clientId, credentialBindingId: binding.credentialBindingId } };
}

/** Preserve explicitly supplied contexts, including the automation worker's run lineage. */
export function withMcpAgentContext<Ports extends { readonly canonical: CanonicalPort }>(ports: Ports, binding: McpAuthenticatedAuthorizationBinding): Ports {
  const context = mcpAgentContext(binding);
  const attribute = (input: CanonicalMutationInput): CanonicalMutationInput => ({ ...input, automationContext: input.automationContext ?? context });
  const executeMoves = ports.canonical.executeMoves;
  return { ...ports, canonical: { ...ports.canonical,
    execute: (input: CanonicalMutationInput) => ports.canonical.execute(attribute(input)),
    ...(executeMoves ? { executeMoves: (inputs: readonly CanonicalMutationInput[]) => executeMoves.call(ports.canonical, inputs.map(attribute)) } : {}),
  } };
}
