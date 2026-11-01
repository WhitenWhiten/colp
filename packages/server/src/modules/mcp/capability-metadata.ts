import { createHash } from 'node:crypto';
import { AUTOMATION_TOOL_CONTRACTS, CAPABILITY_RELATIONS, TASK_TOOLSETS } from './automation-tool-contracts.generated.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';

/** Metadata is descriptive; authorization is always evaluated separately on each call. */
export function capabilityMetadata(tool: McpApplicationToolDescriptor) {
  const taskToolsets = Object.entries(TASK_TOOLSETS)
    .filter(([,set]) => (set.members as readonly string[]).includes(tool.name));
  const automation = AUTOMATION_TOOL_CONTRACTS.find(item => item.name === tool.name);
  // Standard helpers are reviewed individually. collections.list can lazily create
  // an account library; its read-like name is not a promise of no business writes.
  // Unrecognized standard tools do not acquire an inferred effect classification.
  if (!automation && taskToolsets.length === 0) return undefined;
  const effects = automation?.effects ?? { businessMutation: tool.name === 'collections.list',deviceRequest: false,externalRequest: false,providerConsumption: false };
  const relations = (CAPABILITY_RELATIONS as Readonly<Record<string,{ prerequisites?: readonly { id: string; input: string }[];
    nextSteps?: readonly { id: string; input: string }[] }>>)[tool.name];
  const standardContract = { name: tool.name,description: tool.description,inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,annotations: tool.annotations ?? null,requiredScopes: tool.requiredScopes,effects };
  return {
    id: tool.name,description: tool.description,taskToolsets: taskToolsets.map(([name]) => name),
    aliases: [...new Set(taskToolsets.flatMap(([,set]) => [...set.aliases]))],
    prerequisites: relations?.prerequisites ?? [],nextSteps: relations?.nextSteps ?? [],effects,
    contractDigest: automation?.contractDigest ?? createHash('sha256').update(stable(standardContract)).digest('hex'),
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value,(_key,item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
