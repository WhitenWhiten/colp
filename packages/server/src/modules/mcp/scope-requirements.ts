/** Operation-level MCP OAuth scopes, including host extensions. */
export const MCP_OAUTH_SCOPE_READ_PUBLIC = 'mcp:read:public' as const;
export const MCP_OAUTH_SCOPE_READ_OWN = 'mcp:read:own' as const;
export const MCP_OAUTH_SCOPE_REPORTS_READ = 'reports:read' as const;
export const MCP_OAUTH_SCOPE_REPORTS_WRITE = 'reports:write' as const;

export function requiredScopesForMcpReadOperation(input: {
  readonly method: string;
  readonly toolName?: string;
}): readonly string[] {
  if (input.method === 'tools/call') {
    if (input.toolName === 'reports.get' || input.toolName === 'reports.list'
      || input.toolName === 'reports.issues.list' || input.toolName === 'reports.issues.content') return Object.freeze([MCP_OAUTH_SCOPE_REPORTS_READ]);
    if (input.toolName === 'reports.plan' || input.toolName === 'reports.commit') {
      return Object.freeze([MCP_OAUTH_SCOPE_REPORTS_WRITE]);
    }
  }
  switch (input.method) {
    case 'resources/templates/list': return Object.freeze([MCP_OAUTH_SCOPE_READ_PUBLIC]);
    case 'resources/list':
    case 'resources/read':
    case 'subscriptions/listen': return Object.freeze([MCP_OAUTH_SCOPE_READ_OWN]);
    default: return Object.freeze([]);
  }
}
