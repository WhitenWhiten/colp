import type { AdapterTaskAction, AdapterTaskKind } from './agent-tasks.js';
import type { ManagedLibrary } from './copy-identity.js';
export interface SiteAgentAction { connectionId: string; kind: AdapterTaskKind; id: string; revision: string; action: AdapterTaskAction;
  owner: ManagedLibrary; assertCurrent(): Promise<void> }
const hosts = new Map<string, (input: SiteAgentAction) => Promise<unknown>>();
export function registerSiteAgent(adapterId: string, act: (input: SiteAgentAction) => Promise<unknown>) {
  hosts.set(adapterId, act);
  return () => { if (hosts.get(adapterId) === act) hosts.delete(adapterId); };
}
export function controlSiteAgent(adapterId: string, input: SiteAgentAction) {
  const act = hosts.get(adapterId); if (!act) throw Error('adapter_unavailable'); return act(input);
}
