import { matchesSiteUrl } from './registry-validation.js';
import type { SiteDefinition } from './registry-types.js';
import type { SourceContext } from './ledger-types.js';

export async function resolvePageItem(definition: SiteDefinition, url: string, tabId: number | undefined, ports: {
  source(tabId: number): Promise<{ context: SourceContext } | null>;
  state(): Promise<{ leases: readonly { id: string; url: string }[] }>;
  inspect(tabId: number): Promise<{ status: string; retryAfterMs?: number }>;
  inspection(): Promise<{ command: { deadlineAt: number }; result?: unknown } | undefined>;
}, limits: { commandMs: number; spacingMs: number }) {
  if (tabId === undefined || !matchesSiteUrl(definition, url)) return null;
  const source = await ports.source(tabId);
  if (!source) return null;
  const lease = (await ports.state()).leases.find(item => item.id === source.context.leaseId);
  if (!lease || !definition.sameResolutionTarget(url, lease.url)) return null;
  const deadline = Date.now() + limits.commandMs;
  let requested = await ports.inspect(tabId);
  while (requested.status === 'paused' && Date.now() + (requested.retryAfterMs ?? limits.spacingMs) < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.max(limits.spacingMs, requested.retryAfterMs ?? limits.spacingMs)));
    const current = await ports.source(tabId);
    if (!current || current.context.documentId !== source.context.documentId || current.context.routeEpoch !== source.context.routeEpoch
      || current.context.sourceSessionGeneration !== source.context.sourceSessionGeneration) return null;
    requested = await ports.inspect(tabId);
  }
  if (requested.status !== 'reading') return null;
  const outstanding = await ports.inspection();
  if (!outstanding) return null;
  while (Date.now() < outstanding.command.deadlineAt) {
    const current = await ports.inspection();
    if (!current || JSON.stringify(current.command) !== JSON.stringify(outstanding.command)) return null;
    if (current.result) {
      const result = current.result as { status: string; item?: { id: string } };
      return result.status === 'resolved' ? result.item?.id ?? null : null;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}
