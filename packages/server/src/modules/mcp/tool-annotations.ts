const READ_TOOLS = new Set(['collections.list', 'collections.get', 'collections.get_snapshot',
  'nodes.get', 'nodes.search', 'changes.get']);
const ADDITIVE_TOOLS = new Set(['collections.create', 'nodes.create', 'annotations.create']);

/** Host UI hints describe actual effects; trusted nodes.move can commit immediately. */
export function annotateMcpTool<T extends { readonly name: string; readonly annotations?: Readonly<Record<string, unknown>> }>(tool: T): T {
  if (tool.annotations) return tool;
  const readOnlyHint = READ_TOOLS.has(tool.name);
  return Object.freeze({ ...tool, annotations: Object.freeze({
    readOnlyHint, destructiveHint: !readOnlyHint && !ADDITIVE_TOOLS.has(tool.name),
    openWorldHint: false, idempotentHint: readOnlyHint,
  }) });
}
