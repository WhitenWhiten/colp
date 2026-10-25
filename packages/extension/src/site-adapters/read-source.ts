import type { SiteDefinition } from './registry-types.js';
import type { SourceContext } from './ledger-types.js';
import type { Lease } from './transport.js';
/** Prefer the originating document. Only audited account-wide readers may fall back to another document. */
export function selectReadLease(definition: Pick<SiteDefinition, 'readScope'>, leases: readonly Lease[], connected: (id: string) => boolean,
  now: number, origin?: SourceContext, tabId?: number): Lease | undefined {
  const eligible = leases.filter(l => l.expiresAt > now && connected(l.id) && (tabId === undefined || l.tabId === tabId)
    && (!origin || l.generation === origin.installationGeneration && l.sourceGeneration === origin.sourceSessionGeneration));
  if (!origin) return eligible[0];
  const same = eligible.find(l => l.documentId === origin.documentId && l.tabId === origin.tabId && l.routeEpoch === origin.routeEpoch);
  return same ?? (definition.readScope === 'account' ? eligible[0] : undefined);
}
