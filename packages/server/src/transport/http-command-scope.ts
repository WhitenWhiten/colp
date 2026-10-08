/**
 * HTTP command-scope format v1. Its serialized value is intentionally frozen
 * to the original receipt key so mixed deployments share one claim.
 */
export function httpCommandScopeV1(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
