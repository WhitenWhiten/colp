import type { Rule, RuleInput, BindingSet, PreviewResult, PreviewInput, PauseState, AutomationExport, EventFacts, RoleBindings, RuleDefinition } from '@know-n/colp/automation';
import type { HealthStore } from './health-service.js';
import type { ProductCommandReceiptPort } from '../../commands/index.js';
import type { BindingReadPort, BindingStore, AutomationActor, FolderResolution } from '../domain/bindings.js';
export interface StoredRule { view: Rule; sortCreatedAt: string; definitionRevisionId: string; definitionRevision: string }
export interface PageAfter { createdAt: string; id: string }
export interface RuleStore {
  load(ownerId: string, id: string): Promise<StoredRule | null>;
  list(ownerId: string, after: PageAfter | null, limit: number): Promise<StoredRule[]>;
  save(ownerId: string, rule: StoredRule): Promise<void>;
  setState(ownerId: string, rule: StoredRule): Promise<void>;
}
export interface StoredPreview { id: string; configDigest: string; input: PreviewInput; result: PreviewResult; expiresAt: Date }
export interface CurrentSample { events: EventFacts[]; truncated: boolean; revisions: Record<string, string> }
export type ActivationTransition = { kind: 'disable' } | { kind: 'resume' } | { kind: 'enable'; collectionId: string; afterOrdinal: string };
export interface AutomationPorts {
  usage?: { rule(id: string): Promise<NonNullable<Rule['usage']>> };
  targets: import('./target-service.js').TargetStore;
  policies: import('./executor-policy.js').ExecutionPolicyStore;
  runtimeEnabled: boolean;
  workerEnabled?: boolean;
  ownerJobs?: import('./owner-jobs.js').OwnerJobStore;
  placementUndo: import('./placement-undo.js').PlacementUndoPort;
  runs: import('./run-service.js').RunStore;
  health: HealthStore;
  receipts: ProductCommandReceiptPort;
  rules: RuleStore;
  bindings: BindingStore;
  reads: BindingReadPort;
  dependencies: { replace(revisionId: string, resolutions: Record<string, FolderResolution>, values?: RoleBindings): Promise<void> };
  settings: { get(ownerId: string): Promise<PauseState>; save(ownerId: string, state: PauseState): Promise<void> };
  previews: { load(ownerId: string, id: string): Promise<StoredPreview | null>; save(ownerId: string, preview: StoredPreview): Promise<void> };
  sample(actor: AutomationActor, rule: RuleDefinition, values: RoleBindings): Promise<CurrentSample>;
  wakePendingRuns(): Promise<void>;
  pendingRuns(ruleRevisionId: string, policy: 'hold' | 'cancel' | 'continuePinned'): Promise<void>;
  activation(rule: StoredRule, transition: ActivationTransition): Promise<void>;
  export(ownerId: string): Promise<AutomationExport>;
  now(): Promise<Date>;
  id(): string;
}
export interface AutomationUnitOfWork {
  execute<Result>(actor: AutomationActor, work: (ports: AutomationPorts) => Promise<Result>): Promise<Result>;
}
export const ruleInput = (rule: Rule): RuleInput => ({ definition: rule.definition, bindingSetId: rule.bindingSetId,
  ...(rule.executionPolicyId ? { executionPolicyId: rule.executionPolicyId } : {}), ...(rule.templateRef ? { templateRef: rule.templateRef } : {}) });
export const nextRevision = (revision: string): string => (BigInt(revision) + 1n).toString();
export const etag = (revision: string): string => `"${revision}"`;
export type ResourceView = Rule | BindingSet | PauseState;
