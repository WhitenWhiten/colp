import { createSourceLedger } from './ledger.js';
import type { Lease, TransportState } from './transport.js';
import type { SourceAuthority, SourceContext } from './ledger-types.js';
import { adapterBrowserSupport } from './browser-support.js';
export const siteLedger = createSourceLedger();
export const SITE_RECOVERY_ALARM = 'known-site-adapters-recovery';
export async function synchronizeSourceAuthority(state: TransportState, ledger = siteLedger) {
  return ledger.setAuthority({ enabled: adapterBrowserSupport(navigator.userAgent).supported && state.enabled && !state.sourceUnresolved && !!state.accountId,
    installationGeneration: state.generation, sourceSessionGeneration: state.sourceGeneration,
    accountId: state.accountId, negativeReadback: ledger.definition.negativeReadback });
}
export async function sourceContext(lease: Lease, ledger = siteLedger): Promise<SourceContext> {
  const authority = await ledger.db.read<SourceAuthority>('authorities', ledger.definition.adapterId);
  if (!authority?.enabled || !authority.connectionId || authority.accountId !== lease.accountId || authority.installationGeneration !== lease.generation
    || authority.sourceSessionGeneration !== lease.sourceGeneration) throw new Error('staleContext');
  return { installationId: ledger.definition.adapterId, connectionId: authority.connectionId, installationGeneration: lease.generation, sourceSessionGeneration: lease.sourceGeneration,
    documentId: lease.documentId, tabId: lease.tabId, routeEpoch: lease.routeEpoch, leaseId: lease.id };
}
