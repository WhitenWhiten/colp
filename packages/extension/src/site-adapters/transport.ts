import { allowsSiteMessage, matchesSiteUrl } from './registry-validation.js';
import type { AdapterMessage, BootstrapReply, BootstrapRequest } from './contracts.js';
import { legacySite, type SiteDefinition } from './registry.js';
import { LIMITS } from './limits.js';
import { validAdapterMessage, validBootstrap } from './schemas.js';
export const SITE_STATE_KEY = 'known.siteAdapters.runtime.v1';
export const SITE_PORT = 'known.siteAdapters.v1';
export interface SiteSender { id?: string; url?: string; origin?: string; documentId?: string; frameId?: number; documentLifecycle?: string; tab?: { id?: number; incognito?: boolean } }
export interface Lease { id: string; capability: string; tabId: number; documentId: string; url: string; routeEpoch: number;
  generation: number; sourceGeneration: number; accountId: string; expiresAt: number }
export interface TransportState { version: 1; enabled: boolean; generation: number; sourceGeneration: number;
  accountId: string | null; candidateAccount: string | null; accountLabel?: string; candidateLabel?: string; sourceUnresolved: boolean; leases: Lease[]; routes: Record<string, number> }
export const initialTransportState = (): TransportState => ({ version: 1, enabled: false, generation: 1, sourceGeneration: 1,
  accountId: null, candidateAccount: null, sourceUnresolved: true, leases: [], routes: {} });
export function validSiteSender(sender: SiteSender, extensionId: string, definition: SiteDefinition = legacySite): sender is SiteSender & { documentId: string; tab: { id: number }; url: string } {
  if (sender.id !== extensionId || sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id)
      || sender.tab?.incognito || sender.documentLifecycle !== 'active') return false;
  try { const u = new URL(sender.url!); return sender.origin === u.origin && matchesSiteUrl(definition, sender.url!); } catch { return false; }
}
export interface TransportDeps {
  extensionId: string; now(): number; random(): string;
  read(): Promise<TransportState>; write(state: TransportState): Promise<void>;
  permitted(): Promise<boolean>; current(sender: SiteSender): Promise<string | null>;
}
/** One worker owns this serialized authority. All state changes persist before replies. */
export function createSiteTransport(deps: TransportDeps, definition: SiteDefinition = legacySite) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const result = tail.then(work); tail = result.catch(() => undefined); return result; };
  const fence = (s: TransportState) => { s.generation++; s.leases = []; s.routes = {}; };
  return {
    status: () => serial(async () => { const s = await deps.read(); return { enabled: s.enabled, generation: s.generation,
      connected: s.accountId !== null && !s.sourceUnresolved, accountId: s.accountId, candidateAccount: s.candidateAccount, accountLabel: s.accountLabel, candidateLabel: s.candidateLabel, documents: s.leases.filter(l => l.expiresAt > deps.now()).length,
      mode: 'inspector', writes: false, models: false, observation: 'degraded', negativeReadback: definition.negativeReadback ? 'available' : 'unavailable' }; }),
    configure: (enabled: boolean) => serial(async () => { const s = await deps.read(); fence(s); s.enabled = enabled; await deps.write(s); }),
    confirm: (accountId: string) => serial(async () => {
      const s = await deps.read();
      if (!s.enabled || !definition.validateAccount(accountId) || s.candidateAccount !== accountId) throw new Error('sourceUnresolved');
      fence(s); s.sourceGeneration++; s.accountId = accountId; s.accountLabel = s.candidateLabel; s.candidateAccount = null; s.candidateLabel = undefined; s.sourceUnresolved = false; await deps.write(s);
    }),
    invalidate: (tabId?: number) => serial(async () => {
      const s = await deps.read();
      if (tabId === undefined) fence(s);
      else {
        if (!Object.hasOwn(s.routes, String(tabId)) && !s.leases.some(l => l.tabId === tabId)) return;
        s.leases = s.leases.filter(l => l.tabId !== tabId); s.routes[String(tabId)] = (s.routes[String(tabId)] ?? 0) + 1;
      }
      await deps.write(s);
    }),
    /** Only matching enabled pages or tabs already owned by this installation need navigation work. */
    navigate: (tabId: number, url: string, documentId?: string) => serial(async () => {
      const s = await deps.read(), matching = s.enabled && matchesSiteUrl(definition, url);
      const tracked = Object.hasOwn(s.routes, String(tabId)) || s.leases.some(l => l.tabId === tabId);
      if (!tracked) return matching;
      // Sites may replace history state without changing the document or URL.
      if (documentId && s.leases.some(l => l.tabId === tabId && l.documentId === documentId && l.url === url)) return false;
      s.leases = s.leases.filter(l => l.tabId !== tabId);
      if (matching) s.routes[String(tabId)] = (s.routes[String(tabId)] ?? 0) + 1;
      else delete s.routes[String(tabId)];
      await deps.write(s); return true;
    }),
    removeTab: (tabId: number) => serial(async () => {
      const s = await deps.read();
      if (!Object.hasOwn(s.routes, String(tabId)) && !s.leases.some(l => l.tabId === tabId)) return false;
      s.leases = s.leases.filter(l => l.tabId !== tabId); delete s.routes[String(tabId)];
      await deps.write(s); return true;
    }),
    /** Also remove legacy/orphan route records after a worker/browser restart. */
    pruneTabs: (open: readonly number[]) => serial(async () => {
      const s = await deps.read(), live = new Set(open);
      const removed = [...new Set([...Object.keys(s.routes).map(Number), ...s.leases.map(l => l.tabId)])].filter(id => !live.has(id));
      if (!removed.length) return removed;
      s.routes = Object.fromEntries(Object.entries(s.routes).filter(([id]) => live.has(Number(id))));
      s.leases = s.leases.filter(l => live.has(l.tabId)); await deps.write(s); return removed;
    }),
    retire: (leaseId: string) => serial(async () => { const s = await deps.read(); s.leases = s.leases.filter(l => l.id !== leaseId); await deps.write(s); }),
    bootstrap: (raw: unknown, sender: SiteSender): Promise<BootstrapReply> => serial(async () => {
      if (!validBootstrap(raw) || raw.runtime !== 'bundled' || raw.adapterId !== definition.adapterId)
        return { status: 'unavailable', reason: 'version' };
      const currentUrl = await deps.current(sender);
      if (!validSiteSender(sender, deps.extensionId, definition) || !currentUrl) return { status: 'unavailable', reason: 'disabled' };
      if (!await deps.permitted()) return { status: 'unavailable', reason: 'permissionRequired' };
      const s = await deps.read();
      if (!s.enabled) return { status: 'unavailable', reason: 'disabled' };
      const request: BootstrapRequest = raw;
      if (request.source.state !== 'signedIn' || !definition.validateAccount(request.source.accountId)) {
        fence(s); s.sourceGeneration++; s.sourceUnresolved = true; s.candidateAccount = null; s.candidateLabel = undefined; await deps.write(s);
        return { status: 'unavailable', reason: 'sourceUnresolved' };
      }
      if (s.accountId !== request.source.accountId || s.sourceUnresolved) {
        if (definition.connectionKind === 'page') {
          fence(s); s.sourceGeneration++; s.accountId = request.source.accountId; s.accountLabel = request.source.displayName; s.sourceUnresolved = false; s.candidateAccount = null; s.candidateLabel = undefined;
        } else {
          fence(s); s.sourceGeneration++; s.sourceUnresolved = true; s.candidateAccount = request.source.accountId; s.candidateLabel = request.source.displayName; await deps.write(s);
          return { status: 'unavailable', reason: 'sourceUnresolved' };
        }
      }
      s.accountLabel = request.source.displayName ?? s.accountLabel;
      s.leases = s.leases.filter(l => l.expiresAt > deps.now());
      let lease = s.leases.find(l => l.documentId === sender.documentId && l.url === currentUrl && l.generation === s.generation
        && l.expiresAt > deps.now() + LIMITS.commandMs + 1000);
      if (!lease) {
        // A verified renewal must give a full command window and retire the old capability.
        s.leases = s.leases.filter(l => l.documentId !== sender.documentId);
        if (s.leases.length >= 32) return { status: 'unavailable', reason: 'disabled' };
        lease = { id: deps.random(), capability: deps.random(), tabId: sender.tab.id, documentId: sender.documentId,
          url: currentUrl, routeEpoch: s.routes[String(sender.tab.id)] ?? 0, generation: s.generation, sourceGeneration: s.sourceGeneration,
          accountId: s.accountId!, expiresAt: deps.now() + LIMITS.leaseMs }; s.leases.push(lease);
      }
      s.routes[String(sender.tab.id)] = lease.routeEpoch;
      await deps.write(s);
      return { status: 'ready', leaseId: lease.id, capability: lease.capability, routeEpoch: lease.routeEpoch, expiresAt: lease.expiresAt, readerEpoch: JSON.stringify([s.generation, s.sourceGeneration, lease.documentId, lease.routeEpoch]) };
    }),
    authorize: (raw: unknown, sender: SiteSender): Promise<Lease | null> => serial(async () => {
      if (!validAdapterMessage(raw) || !validSiteSender(sender, deps.extensionId, definition) || !await deps.permitted()) return null;
      const currentUrl = await deps.current(sender); if (!currentUrl) return null;
      const s = await deps.read(), m: AdapterMessage = raw;
      const lease = s.leases.find(l => l.id === m.leaseId && l.capability === m.capability);
      if (!s.enabled || s.sourceUnresolved || !lease || lease.expiresAt <= deps.now() || lease.generation !== s.generation
          || lease.sourceGeneration !== s.sourceGeneration || lease.accountId !== s.accountId || lease.documentId !== sender.documentId
          || lease.tabId !== sender.tab.id || lease.url !== currentUrl) return null;
      if (!allowsSiteMessage(definition, m) || !definition.validateMessage(m)) return null;
      return structuredClone(lease);
    }),
  };
}
