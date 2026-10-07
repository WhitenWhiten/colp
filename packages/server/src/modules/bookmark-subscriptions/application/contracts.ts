import type { ProductCommandReceiptPort } from '../../commands/index.js';
import type { SourceRef, SourceView, SourceNodeRef, ProjectionNode, Mapping, Subscription, ExitPreview, ExitTask, ActionReceipt, SnapshotDescriptor } from '../domain/types.js';
export interface SubscriptionActor { accountId: string; subjectId: string }
export interface MemberReaderDetails { seriesSummary:string|null;editionSummary:string|null;sourceSummary:string|null;notes:{key:string;description:string|null}[];annotations:{id:string;subjectType:'collection'|'node';subjectId:string;type:string;format:string|null;value:unknown}[] }
export interface SourceProjection { reader?:MemberReaderDetails; mappingRevision?: string; source: SourceView; nodes: ProjectionNode[]; policyRevision: string; contentRevision: string; editions: SnapshotDescriptor['editions']; skippedByReason: SnapshotDescriptor['skippedByReason'] }
/** Every method uses the caller's transaction; unavailable dependencies throw, never deny. */
export interface SubscriptionSourcePort {
  memberSeries(actor:SubscriptionActor,id:string):Promise<SourceView|null>;
  memberEditions(actor:SubscriptionActor,id:string,after?:string,limit?:number):Promise<SourceProjection['editions']>;
  memberEdition(actor:SubscriptionActor,id:string,editionId:string):Promise<SourceProjection|null>;
  get(actor: SubscriptionActor, source: SourceRef, requireRelation?: boolean): Promise<SourceView | null>;
  list(actor: SubscriptionActor, filter: { sourceType?: string; relation?: string; q?: string }, after?: string, limit?: number): Promise<SourceView[]>;
  project(actor: SubscriptionActor, source: SourceRef, mode: 'latest' | 'recent' | null, limit: number | null): Promise<SourceProjection | null>;
  check(actor: SubscriptionActor, source: SourceRef, editions: string[], nodes?: SourceNodeRef[]): Promise<{ available: boolean; removeEditionIds: string[]; removeNodes: SourceNodeRef[]; authorityRevision: string }>;
}
export interface StorePage { after?: [string,string]; limit: number }
export interface SubscriptionFilter { status?: 'active'|'terminated'; source?: SourceRef; ids?:string[] }
export interface MappingFilter { status?: 'active'|'terminating'|'detached'|'live'; profileId?:string; subscriptionIds?:string[]; source?:SourceRef; sourceType?:string; ids?:string[] }
export interface TaskFilter { profileId?:string; mappingIds?:string[]; actionId?:string; pendingOnly?:boolean; afterSequence?:string; limit?:number }
export interface SubscriptionStore {
  getSubscription(accountId: string, id: string): Promise<Subscription | null>;
  getMapping(accountId: string, id: string): Promise<Mapping | null>;
  saveSubscription(accountId: string, value: Subscription): Promise<void>;
  saveMapping(accountId: string, source: SourceRef, value: Mapping): Promise<void>;
  subscriptions(accountId: string, filter?: SubscriptionFilter, page?:StorePage): Promise<Subscription[]>;
  mappings(accountId: string, filter?:MappingFilter, page?:StorePage): Promise<Mapping[]>;
  getPreview(accountId: string, id: string): Promise<{preview:ExitPreview;selectionRevision:string|null} | null>;
  savePreview(accountId: string, value: ExitPreview, selectionRevision:string): Promise<void>;
  tasks(accountId: string, filter?:TaskFilter): Promise<ExitTask[]>;
  saveTask(accountId: string, task: ExitTask): Promise<ExitTask>;
  getReceipt(accountId: string, actionId: string): Promise<ActionReceipt | null>;
  acknowledge(accountId: string, receipt: ActionReceipt): Promise<void>;
  getSnapshot(accountId: string, id: string): Promise<{ descriptor: SnapshotDescriptor; projection: SourceProjection } | null>;
  saveSnapshot(accountId: string, descriptor: SnapshotDescriptor, projection: SourceProjection): Promise<void>;
}
export interface SubscriptionTransactionPorts {
  store: SubscriptionStore; sources: SubscriptionSourcePort; receipts: ProductCommandReceiptPort;
  lockAccount(accountId: string): Promise<void>;
  preferences(accountId: string): Promise<{ revision: string; subscriptionOnUnfollow: 'keep'|'remove'; subscriptionOnUnsubscribe: 'keep'|'remove' }>;
  now(): Promise<Date>;
}
export interface BookmarkSubscriptionUnitOfWork { execute<T>(work: (ports: SubscriptionTransactionPorts) => Promise<T>, options?: { write?: boolean; signal?: AbortSignal }): Promise<T> }
/** Both existing unfollow commands invoke this inside their existing transaction. */
export interface BookmarkSubscriptionExitPort {
  lockAccount(accountId: string): Promise<void>;
  unfollow(input: { accountId: string; subjectId: string; source: SourceRef; previewId?: string }): Promise<void>;
}
