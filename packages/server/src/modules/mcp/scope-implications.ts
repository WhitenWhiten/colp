/**
 * Granted-scope implication table reserved for the future fine-grained scope
 * split (e.g. `community:read`). Today the Product bearer surface requires the
 * coarse `product:read` / `product:write` scopes; when finer scopes arrive, an
 * entry here lets a token carrying a superset scope satisfy the finer
 * requirement without re-issuing grants.
 *
 * Every "does this granted scope set satisfy the required scope" check —
 * the Product HTTP bearer authority, the MCP OAuth verifier's required-scope
 * gate, and MCP tool gating on `context.scopes` — routes through
 * {@link grantsScope} / {@link expandGrantedScopes} instead of a bare
 * `scopes.includes(required)`, so enabling an entry later is a data-only
 * change. The table is intentionally empty: the routed checks are behavior
 * identical to the literal membership tests they replaced.
 *
 * The table maps a granted scope to the scopes it implies; it never widens a
 * *supported* scope set (issuer metadata, `MCP_OAUTH_SCOPES` validation),
 * which correctly stays a literal membership check.
 */
export const SCOPE_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Example for the future split (keep disabled until the scope exists):
  // 'product:read': ['community:read'],
  // 'product:write': ['community:write'],
});

/**
 * Returns the granted scope set closed under {@link SCOPE_IMPLICATIONS},
 * transitively, so chained entries resolve regardless of table order.
 */
export function expandGrantedScopes(granted: readonly string[]): ReadonlySet<string> {
  const expanded = new Set<string>(granted);
  let changed = true;
  while (changed) {
    changed = false;
    for (const scope of expanded) {
      for (const implied of SCOPE_IMPLICATIONS[scope] ?? []) {
        if (!expanded.has(implied)) {
          expanded.add(implied);
          changed = true;
        }
      }
    }
  }
  return expanded;
}

/** True when a token carrying `granted` satisfies the `required` scope. */
export function grantsScope(granted: readonly string[], required: string): boolean {
  return expandGrantedScopes(granted).has(required);
}
