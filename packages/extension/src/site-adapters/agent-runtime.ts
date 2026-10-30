import type { AdapterTaskAction, AdapterTaskKind } from './agent-tasks.js';
import type { ManagedLibrary } from './copy-identity.js';
export interface SiteAgentAction { connectionId: string; kind: AdapterTaskKind; id: string; revision: string; action: AdapterTaskAction;
  owner: ManagedLibrary; assertCurrent(): Promise<void> }
export interface SiteAgentManagement { operation: string; requestId: string; revision?: string; cursor?: string;
  request?: Record<string, unknown>; assertCurrent(): Promise<void> }
const hosts = new Map<string, { act(input: SiteAgentAction): Promise<unknown>; manage?: (input: SiteAgentManagement) => Promise<unknown> }>();
export function registerSiteAgent(adapterId: string, act: (input: SiteAgentAction) => Promise<unknown>, manage?: (input: SiteAgentManagement) => Promise<unknown>) {
  const host = { act, manage }; hosts.set(adapterId, host);
  return () => { if (hosts.get(adapterId) === host) hosts.delete(adapterId); };
}
export function controlSiteAgent(adapterId: string, input: SiteAgentAction) {
  const host = hosts.get(adapterId); if (!host) throw Error('adapter_unavailable'); return host.act(input);
}
export function manageSiteAgent(adapterId: string, input: SiteAgentManagement) {
  const host = hosts.get(adapterId); if (!host?.manage) throw Error('adapter_unavailable'); return host.manage(input);
}
