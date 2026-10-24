import { createSourceLedger } from './ledger.js';
import type { Lease, TransportState } from './transport.js';
import type { SourceAuthority, SourceContext } from './ledger-types.js';
import { adapterBrowserSupport } from './browser-support.js';
export const siteLedger = createSourceLedger();
export const SITE_RECOVERY_ALARM = 'known-site-adapters-recovery';
export async function synchronizeSourceAuthority(state: TransportState) {
  return siteLedger.setAuthority({ enabled: adapterBrowserSupport(navigator.userAgent).supported && state.enabled && !state.sourceUnresolved && !!state.accountId,
    installationGeneration: state.generation, sourceSessionGeneration: state.sourceGeneration,
    accountId: state.accountId, negativeReadback: false });
}
export async function sourceContext(lease: Lease): Promise<SourceContext> {
  const authority = await siteLedger.db.read<SourceAuthority>('authorities', 'bundled.bilibili');
  if (!authority?.enabled || !authority.connectionId || authority.accountId !== lease.accountId || authority.installationGeneration !== lease.generation
    || authority.sourceSessionGeneration !== lease.sourceGeneration) throw new Error('staleContext');
  return { connectionId: authority.connectionId, installationGeneration: lease.generation, sourceSessionGeneration: lease.sourceGeneration,
    documentId: lease.documentId, tabId: lease.tabId, routeEpoch: lease.routeEpoch, leaseId: lease.id };
}
