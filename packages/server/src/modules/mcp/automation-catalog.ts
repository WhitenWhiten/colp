import { findMcpApplicationTool } from './application-ports.js';
import { createAjv } from '@know-n/colp/schema';
import { boundedJson,automationDigest } from '@know-n/colp/automation';
import { AUTOMATION_TOOL_CONTRACTS } from './automation-tool-contracts.generated.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationFacade } from './application-facade.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';

export interface AutomationProfileAccess {
  id: string; revision: string; automationEnabled: boolean; catalogs: readonly string[];
  pairedTargets: readonly { id: string; generation: string }[];
}
export interface AutomationCatalogPort {
  access(context: McpApplicationContext): Promise<AutomationProfileAccess | null>;
  call(context: McpApplicationContext,name: string,args: Readonly<Record<string,unknown>>): Promise<McpApplicationToolResult>;
}
const ajv = createAjv({ allErrors: true,ownProperties: true });
const validators = new Map(AUTOMATION_TOOL_CONTRACTS.map(tool => [tool.name,ajv.compile(tool.inputSchema)]));
const contracts = AUTOMATION_TOOL_CONTRACTS as readonly { name: string; profile: string; requiredScopes: readonly string[]; availability: string;
  description: string; inputSchema: Readonly<Record<string,unknown>>; outputSchema: Readonly<Record<string,unknown>>; annotations: Readonly<Record<string,unknown>> }[];
export function canUseAutomationTool(context: McpApplicationContext,access: AutomationProfileAccess | null,name: string): boolean {
  const tool = contracts.find(tool => tool.name === name);
  return context.principal.kind === 'authenticated' && !!access?.automationEnabled && !!tool
    && access.catalogs.includes(tool.profile) && tool.requiredScopes.every(scope => context.scopes.includes(scope))
    && (tool.profile !== 'automationWorker' || tool.availability === 'bootstrapAndPaired' || access.pairedTargets.length > 0);
}
export function automationCatalogKey(context: McpApplicationContext,access: AutomationProfileAccess): string {
  return automationDigest({ version: 'automation-catalog/v1',principal: context.principal,scopes: [...context.scopes].sort(),access });
}
const descriptor = (tool: typeof contracts[number]): McpApplicationToolDescriptor => ({ name: tool.name,description: tool.description,
  requiredScopes: tool.requiredScopes,inputSchema: tool.inputSchema,outputSchema: tool.outputSchema,annotations: tool.annotations });
const rejected = (): McpApplicationToolResult => ({ kind: 'rejected',stableCode: 'unknown_tool',safeMessage: 'Unknown tool.',retryable: false });

/** No global catalog cache. All three entry points evaluate the same current decision. */
export function withAutomationCatalog(base: McpApplicationFacade,port: AutomationCatalogPort): McpApplicationFacade {
  const mayUseStandard = (access: AutomationProfileAccess | null) => access === null || access.catalogs.includes('standard');
  return {
    async getTool(context,name) {
      const access = await port.access(context);
      if (name.startsWith('automation.')) return canUseAutomationTool(context,access,name) ? descriptor(contracts.find(tool => tool.name === name)!) : undefined;
      return mayUseStandard(access) ? findMcpApplicationTool(base,context,name) : undefined;
    },
    async listTools(context,cursor) {
      const access = await port.access(context);
      if (!access) return base.listTools(context,cursor);
      const standard = mayUseStandard(access) ? await base.listTools(context,cursor) : { tools: [] };
      return { ...standard,tools: [...standard.tools,...contracts.filter(tool => canUseAutomationTool(context,access,tool.name)).map(descriptor)],
        cacheKey: automationCatalogKey(context,access) };
    },
    async callTool(context,name,args) {
      const access = await port.access(context);
      if (!name.startsWith('automation.')) return mayUseStandard(access) ? base.callTool(context,name,args) : rejected();
      if (!canUseAutomationTool(context,access,name)) return rejected();
      const validate = validators.get(name as typeof AUTOMATION_TOOL_CONTRACTS[number]['name']);
      if (!boundedJson(args) || !validate?.(args)) return { kind: 'rejected',stableCode: 'invalid_arguments',safeMessage: 'Arguments violate the listed Automation schema.',retryable: false };
      return port.call(context,name,args);
    },
    async listResources(context,cursor) { return mayUseStandard(await port.access(context)) ? base.listResources(context,cursor) : { resources: [] }; },
    async listResourceTemplates(context,cursor) { return mayUseStandard(await port.access(context)) ? base.listResourceTemplates(context,cursor) : { resourceTemplates: [] }; },
    async readResource(context,uri) {
      if (mayUseStandard(await port.access(context))) return base.readResource(context,uri);
      throw new TypeError('Invalid Resource URI.');
    },
  };
}
