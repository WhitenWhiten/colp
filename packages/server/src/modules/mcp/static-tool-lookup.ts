import {
  requireMcp20260728RequestContext,
  resolveMcpResourceReadBudget,
  type Mcp20260728RequestContext,
  type Mcp20260728Result,
} from '@know-n/colp/mcp';

type Tool = Readonly<Record<string, unknown>>;

export interface StaticMcpToolLookup {
  readonly getTool: (context: Mcp20260728RequestContext, name: string) => Promise<Tool | undefined>;
}

/**
 * Only for host adapters whose definitions are immutable for their lifetime.
 * Retains definitions, never request contexts or scope-filtered catalogs.
 * Custom/dynamic adapters keep using their listTools implementation.
 */
export function createStaticMcpToolLookup(
  list: (context: Mcp20260728RequestContext, input?: unknown) => Promise<Mcp20260728Result>,
  canAccess: (context: Mcp20260728RequestContext, name: string) => boolean,
  project: (tool: Tool) => Tool = (tool) => tool,
): StaticMcpToolLookup & { readonly listTools: typeof list } {
  const definitions = new Map<string, Tool>();
  const listTools: typeof list = async (context, input) => {
    const listed = await list(context, input);
    if (!Array.isArray(listed.tools)) return listed;
    const tools = listed.tools.map((tool: Tool) => {
      const name = String(tool.name);
      let definition = definitions.get(name);
      if (definition === undefined) {
        definition = project(tool);
        definitions.set(name, definition);
      }
      return definition;
    });
    return Object.freeze({ ...listed, tools: Object.freeze(tools) });
  };
  return Object.freeze({
    listTools,
    async getTool(context: Mcp20260728RequestContext, name: string) {
      const trusted = requireMcp20260728RequestContext(context);
      trusted.abortSignal.throwIfAborted();
      resolveMcpResourceReadBudget(trusted.budget);
      if (!canAccess(trusted, name)) return undefined;
      if (!definitions.has(name)) await listTools(trusted);
      return definitions.get(name);
    },
  });
}
