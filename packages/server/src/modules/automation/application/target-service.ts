import type { ConnectionProfile, ConnectionProfileInput, Executor, ExecutorInput, Target, TargetInput, PairingGrant } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import { parseContract, requireEtag } from './rule-service.js';
import type { PageAfter } from './ports.js';

export interface ConfigurationStore<View,Input> {
  load(id: string): Promise<View | null>;
  list(after: PageAfter | null,limit: number): Promise<{ view: View; createdAt: string }[]>;
  save(input: Input,id?: string): Promise<View>;
}
export interface TargetStore {
  profiles: ConfigurationStore<ConnectionProfile,ConnectionProfileInput>;
  targets: ConfigurationStore<Target,TargetInput>;
  executors: ConfigurationStore<Executor,ExecutorInput>;
  issuePairing(id: string): Promise<PairingGrant>;
  revoke(id: string): Promise<Target>;
}
export async function saveConnectionProfile(store: TargetStore,body: unknown,id?: string,ifMatch?: string) {
  const input = parseContract('ConnectionProfileInput',body);
  if (id) { const previous = await store.profiles.load(id); if (!previous) throw new AutomationError('resource_not_found','Profile is unavailable.'); requireEtag(previous.revision,ifMatch ?? ''); }
  return store.profiles.save(input,id);
}
export async function saveTarget(store: TargetStore,body: unknown,id?: string,ifMatch?: string) {
  const input = parseContract('TargetInput',body);
  if (!await store.profiles.load(input.connectionProfileId)) throw new AutomationError('resource_not_found','Profile is unavailable.');
  if (input.wakeMode === 'poll' && !input.pollIntervalMinutes) throw new AutomationError('invalid_request','Polling requires an explicit interval.');
  if (id) { const previous = await store.targets.load(id); if (!previous) throw new AutomationError('resource_not_found','Target is unavailable.'); requireEtag(previous.revision,ifMatch ?? ''); }
  return store.targets.save(input,id);
}
export async function saveExecutor(store: TargetStore,body: unknown,id?: string,ifMatch?: string) {
  const input = parseContract('ExecutorInput',body);
  if (input.kind !== 'mcpEventsBot' || !input.targetId || input.credentialRef)
    throw new AutomationError('automation_unsupported_capability','Only external paired workers are installed; serverModel/browser executors are unavailable.');
  if (!await store.targets.load(input.targetId)) throw new AutomationError('resource_not_found','Target is unavailable.');
  if (id) { const previous = await store.executors.load(id); if (!previous) throw new AutomationError('resource_not_found','Executor is unavailable.'); requireEtag(previous.revision,ifMatch ?? ''); }
  return store.executors.save(input,id);
}

export interface WorkerPairingPort {
  pair(actor: import('./claim-job.js').WorkPrincipal,body: unknown,commandId?: string): Promise<{ kind: 'succeeded'; target: Target } | Exclude<import('../../commands/index.js').ProductCommandClaim,{ kind: 'claimed' }>>;
  /** The paired inboxes this credential works for; how a worker bound by consent learns its target IDs. */
  mine(actor: import('./claim-job.js').WorkPrincipal): Promise<Target[]>;
}
