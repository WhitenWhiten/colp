import type { ProductCommandReceiptPort } from '../../commands/index.js';
import type {
  Evidence,
  EvidenceCapture,
  GovernanceTarget,
  ModerationCaseStatus,
  ModerationCategory,
  ModerationRole,
  MyCase,
  OfficialCase,
} from '../domain/moderation.js';
import type {
  AccountControlDecision,
  Action,
  CollectionControlDecision,
  ModerationActionState,
  ModerationActionType,
} from '../domain/moderation-actions.js';
import type {
  Appeal,
  ModerationAppealStatus,
} from '../domain/moderation-appeals.js';

export interface ModerationCaseRecord {
  readonly id: string;
  readonly reporterAccountId: string;
  readonly target: GovernanceTarget;
  readonly targetFingerprint: string;
  readonly category: ModerationCategory;
  readonly description: string;
  readonly status: ModerationCaseStatus;
  readonly publicResolution: string | null;
  readonly assignedToAccountId: string | null;
  readonly internalNote: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly string[];
}

export interface ModerationPageRead {
  readonly after?: { readonly createdAt: string; readonly id: string };
  readonly status?: ModerationCaseStatus;
  readonly assignee?: string;
  readonly limit: number;
}

export interface ModerationActionRecord extends Action {
  readonly targetFingerprint: string;
  readonly revokedByAccountId: string | null;
  /**
   * Owner snapshot captured when the action was created: the account that
   * owned the target at that moment. Appeal/affected-owner rights bind to
   * this stable value, so deleting or transferring the parent resource never
   * moves or revokes the self-service right.
   */
  readonly ownerAccountId: string | null;
}

export interface ModerationAppealRecord extends Appeal {
  readonly appellantAccountId: string;
  readonly decidedByAccountId: string | null;
}

export interface ModerationExpiredEvidence {
  readonly id: string;
  readonly caseId: string;
  readonly retainUntil: string;
}

export interface ModerationStore {
  insertCase(record: ModerationCaseRecord): Promise<'inserted' | 'duplicate_open'>;
  findOpenCase(
    reporterAccountId: string,
    targetFingerprint: string,
    category: ModerationCategory,
  ): Promise<ModerationCaseRecord | null>;
  getCase(caseId: string): Promise<ModerationCaseRecord | null>;
  updateCase(
    record: ModerationCaseRecord,
    expectedRevision: string,
  ): Promise<boolean>;
  listReporterCases(
    reporterAccountId: string,
    read: ModerationPageRead,
  ): Promise<readonly ModerationCaseRecord[]>;
  listOfficialCases(read: ModerationPageRead): Promise<readonly ModerationCaseRecord[]>;
  insertEvidence(evidence: Evidence): Promise<void>;
  getEvidence(caseId: string, evidenceId: string): Promise<Evidence | null>;
  insertAction(record: ModerationActionRecord): Promise<void>;
  getAction(actionId: string): Promise<ModerationActionRecord | null>;
  updateAction(
    record: ModerationActionRecord,
    expectedRevision: string,
  ): Promise<boolean>;
  listActionsForTarget(targetFingerprint: string): Promise<readonly ModerationActionRecord[]>;
  listActionsAffectingOwner(
    ownerAccountId: string,
    read: ModerationPageRead,
  ): Promise<readonly ModerationActionRecord[]>;
  isAffectedOwner(accountId: string, actionId: string): Promise<boolean>;
  /** Resolves the account id that owns `target` at command time (content targets resolve through their live parent; account targets resolve to themselves). */
  actionOwnerAccountId(target: GovernanceTarget): Promise<string | null>;
  insertAppeal(record: ModerationAppealRecord): Promise<'inserted' | 'duplicate_open'>;
  findOpenAppeal(actionId: string): Promise<ModerationAppealRecord | null>;
  getAppeal(appealId: string): Promise<ModerationAppealRecord | null>;
  updateAppeal(
    record: ModerationAppealRecord,
    expectedRevision: string,
  ): Promise<boolean>;
  listAppellantAppeals(
    appellantAccountId: string,
    read: ModerationPageRead,
  ): Promise<readonly ModerationAppealRecord[]>;
  listOfficialAppeals(read: {
    readonly after?: { readonly createdAt: string; readonly id: string };
    readonly status?: ModerationAppealStatus;
    readonly limit: number;
  }): Promise<readonly ModerationAppealRecord[]>;
  listExpiredEvidence(now: Date, limit: number): Promise<readonly ModerationExpiredEvidence[]>;
  recycleExpiredEvidence(now: Date, limit: number): Promise<number>;
  collectionControl(collectionId: string): Promise<CollectionControlDecision>;
  collectionControls(
    collectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, CollectionControlDecision>>;
  collectionPublicationSlug(collectionId: string): Promise<string | null>;
  bookmarkFaviconObjectId(collectionId: string, nodeId: string): Promise<string | null>;
  digestSeriesSlug(seriesId: string): Promise<string | null>;
  accountControl(accountId: string): Promise<AccountControlDecision>;
  accountControls(
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountControlDecision>>;
  accountPublicLocator(accountId: string): Promise<{
    readonly handle: string | null;
    readonly avatarObjectId: string | null;
  }>;
}

export interface ModerationTargetResolver {
  resolve(
    actor: { readonly accountId: string; readonly subjectId: string },
    target: GovernanceTarget,
  ): Promise<EvidenceCapture>;
}

export interface ModerationRoleStore {
  getRoles(accountId: string): Promise<ReadonlySet<ModerationRole>>;
  grant(accountId: string, role: ModerationRole): Promise<boolean>;
  revoke(accountId: string, role: ModerationRole): Promise<boolean>;
  accountExists(accountId: string): Promise<boolean>;
}

export interface ModerationAuditPort {
  append(input: {
    readonly principalId: string | null;
    readonly eventType: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): Promise<string>;
}

export interface ModerationIds {
  nextCaseId(): string;
  nextEvidenceId(): string;
  nextActionId(): string;
  nextAppealId(): string;
  nextOutboxId(): string;
  nextEventId(): string;
}

export interface ModerationOutboxPort {
  appendCollectionControl(event: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly collectionId: string;
    readonly actionId: string;
    readonly action: Extract<ModerationActionType, 'delist' | 'hide_public'>;
    readonly state: ModerationActionState;
    readonly publicationSlug: string | null;
    readonly occurredAt: Date;
  }): Promise<void>;
  appendBookmarkControl(event: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly collectionId: string;
    readonly nodeId: string;
    readonly actionId: string;
    readonly action: Extract<ModerationActionType, 'delist' | 'hide_public'>;
    readonly state: ModerationActionState;
    readonly publicationSlug: string | null;
    readonly faviconObjectId: string | null;
    readonly occurredAt: Date;
  }): Promise<void>;
  appendDigestControl(event: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly seriesId: string;
    readonly editionId: string | null;
    readonly actionId: string;
    readonly action: Extract<ModerationActionType, 'delist' | 'hide_public'>;
    readonly state: ModerationActionState;
    readonly seriesSlug: string | null;
    readonly occurredAt: Date;
  }): Promise<void>;
  appendAccountControl(event: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly accountId: string;
    readonly actionId: string;
    readonly action: Extract<ModerationActionType, 'restrict_interaction' | 'restrict_publication'>;
    readonly state: ModerationActionState;
    readonly handle: string | null;
    readonly avatarObjectId: string | null;
    readonly occurredAt: Date;
  }): Promise<void>;
}

export interface ModerationCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly store: ModerationStore;
  readonly targets: ModerationTargetResolver;
  readonly roles: ModerationRoleStore;
  readonly audit: ModerationAuditPort;
  readonly outbox: ModerationOutboxPort;
  readonly clock: { now(): Promise<Date> };
  readonly ids: ModerationIds;
}

export interface ModerationQueryPorts {
  readonly store: ModerationStore;
  readonly roles: ModerationRoleStore;
  readonly clock: { now(): Promise<Date> };
}

export interface ModerationRolePorts {
  readonly roles: ModerationRoleStore;
  readonly audit: ModerationAuditPort;
}

export function toMyCase(record: ModerationCaseRecord): MyCase {
  return Object.freeze({
    id: record.id,
    target: record.target,
    category: record.category,
    status: record.status,
    publicResolution: record.publicResolution,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toOfficialCase(record: ModerationCaseRecord): OfficialCase {
  return Object.freeze({
    case: toMyCase(record),
    reporterAccountId: record.reporterAccountId,
    description: record.description,
    assignedToAccountId: record.assignedToAccountId,
    evidenceIds: Object.freeze([...record.evidenceIds]),
    actionIds: Object.freeze([...record.actionIds]),
    internalNote: record.internalNote,
  });
}
