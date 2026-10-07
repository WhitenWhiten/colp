import { sql, type Kysely } from 'kysely';
import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandClaim,
} from '../../modules/commands/index.js';
import {
  createCanonicalMutationApplication,
  OrganizePlanRateLimitError,
  type ApplyCollectionOrganizePlanPorts,
  type OrganizePlanActionDto,
  type OrganizePlanCollectionPort,
  type OrganizePlanReadPort,
  type OrganizePlanReceiptPort,
  type OrganizePlanRecord,
  type OrganizePlanStatus,
  type OrganizePlanWritePort,
  type ProductCollectionCanonicalPorts,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresBookmarkIconWritePort } from './bookmark-icon-postgres.js';
import { createPostgresCanonicalMutationPorts } from './canonical-mutation-postgres-ports.js';
import {
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresNodeWritePort,
} from './repositories.js';
import type { Metrics } from '../telemetry/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { DatabaseOperationError, isPostgresErrorCode } from '../database/errors.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import { createRequestUnitOfWork } from '../database/request-unit-of-work.js';
import {
  lockActiveSyncReplicasForCollection,
  lockCollectionForReplicaInvalidation,
} from '../database/lock-order.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresCollectionVersionStore } from './collection-tree-version-postgres.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

export const ORGANIZE_PLAN_OPEN_UNIQUE_INDEX = 'collection_organize_plans_account_collection_open_uidx';

interface PlanRow {
  plan_id: string;
  account_id: string;
  collection_id: string;
  collection_revision: string;
  planner_id: string;
  status: OrganizePlanStatus;
  expires_at: Date;
  etag: string;
  truncated: boolean;
  actions: unknown;
  applied_action_ids: unknown;
  apply_receipt: unknown;
  created_at: Date;
  updated_at: Date;
}

function constraintName(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const named = (current as { constraint?: unknown }).constraint;
    if (typeof named === 'string' && named.length > 0) return named;
    const message = current instanceof Error ? current.message : '';
    if (message.includes(ORGANIZE_PLAN_OPEN_UNIQUE_INDEX)) return ORGANIZE_PLAN_OPEN_UNIQUE_INDEX;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) return error.kind === 'unique_violation';
  if (isPostgresErrorCode(error, '23505')) return true;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause !== undefined && isUniqueViolation(cause);
}

function isOpenUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error) && constraintName(error) === ORGANIZE_PLAN_OPEN_UNIQUE_INDEX;
}


function asActionDtos(value: unknown): readonly OrganizePlanActionDto[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value as OrganizePlanActionDto[]);
}

function asStringArray(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.filter((item): item is string => typeof item === 'string'));
}

function mapPlanRow(row: PlanRow): OrganizePlanRecord {
  return Object.freeze({
    planId: row.plan_id,
    accountId: row.account_id,
    collectionId: row.collection_id,
    collectionRevision: row.collection_revision,
    plannerId: row.planner_id,
    status: row.status,
    expiresAt: row.expires_at,
    etag: row.etag,
    truncated: row.truncated,
    actions: asActionDtos(row.actions),
    appliedActionIds: asStringArray(row.applied_action_ids),
    applyReceipt: row.apply_receipt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createPostgresOrganizePlanReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): OrganizePlanReadPort {
  return Object.freeze({
    async getById(accountId: string, collectionId: string, planId: string) {
      const row = await transaction.selectFrom('collection_organize_plans')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .where('plan_id', '=', planId)
        .executeTakeFirst();
      return row ? mapPlanRow(row as PlanRow) : null;
    },
  });
}

export function createPostgresOrganizePlanWritePort(
  transaction: DatabaseTransaction,
): OrganizePlanWritePort {
  const port: OrganizePlanWritePort = {
    async expireOpen(accountId: string, collectionId: string, now: Date) {
      await transaction.updateTable('collection_organize_plans')
        .set({ status: 'expired', updated_at: now })
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .where('status', '=', 'open')
        .execute();
    },
    async insert(row: OrganizePlanRecord) {
      try {
        await transaction.insertInto('collection_organize_plans').values({
          plan_id: row.planId,
          account_id: row.accountId,
          collection_id: row.collectionId,
          collection_revision: row.collectionRevision,
          planner_id: row.plannerId,
          status: row.status,
          expires_at: row.expiresAt,
          etag: row.etag,
          truncated: row.truncated,
          actions: sql`${JSON.stringify(row.actions)}::jsonb`,
          applied_action_ids: row.appliedActionIds
            ? sql`${JSON.stringify(row.appliedActionIds)}::jsonb`
            : null,
          apply_receipt: row.applyReceipt == null
            ? null
            : sql`${JSON.stringify(row.applyReceipt)}::jsonb`,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        }).execute();
      } catch (error: unknown) {
        if (isOpenUniqueViolation(error)) throw new OrganizePlanRateLimitError();
        throw error;
      }
    },
    async findLatestCreatedAt(accountId: string, collectionId: string) {
      const row = await transaction.selectFrom('collection_organize_plans')
        .select('created_at')
        .where('account_id', '=', accountId)
        .where('collection_id', '=', collectionId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row?.created_at ?? null;
    },
    async persistApplyReceipt(input) {
      await transaction.updateTable('collection_organize_plans')
        .set({
          apply_receipt: sql`${JSON.stringify(input.applyReceipt)}::jsonb`,
          updated_at: input.now,
        })
        .where('account_id', '=', input.accountId)
        .where('collection_id', '=', input.collectionId)
        .where('plan_id', '=', input.planId)
        .execute();
    },
    async markApplied(input) {
      await transaction.updateTable('collection_organize_plans')
        .set({
          status: 'applied',
          applied_action_ids: sql`${JSON.stringify(input.appliedActionIds)}::jsonb`,
          updated_at: input.now,
        })
        .where('account_id', '=', input.accountId)
        .where('collection_id', '=', input.collectionId)
        .where('plan_id', '=', input.planId)
        .execute();
    },
  };
  return Object.freeze(port);
}

export function createPostgresOrganizePlanCollectionPort(
  transaction: DatabaseTransaction,
): OrganizePlanCollectionPort {
  return Object.freeze({
    async lockOwnedLive(collectionId: string, ownerSubjectId: string) {
      // T-10 lock order (ADR-0027): every organize-plan command that reaches
      // here continues into the canonical mutation below, which marks this
      // collection's active replicas `recovery_required`. Take the replica row
      // locks before `collections` so the pair is never acquired in the
      // opposite order from the Sync Push/Pull/Ack authority prefix.
      await lockActiveSyncReplicasForCollection(transaction, collectionId);
      const row = await transaction.selectFrom('collections')
        .select(['id', 'owner_subject_id', 'content_revision', 'root_node_id', 'deleted_at'])
        .where('id', '=', collectionId)
        .where('owner_subject_id', '=', ownerSubjectId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      return Object.freeze({
        collectionId: row.id,
        ownerSubjectId: row.owner_subject_id,
        contentRevision: row.content_revision,
        rootNodeId: row.root_node_id,
      });
    },
    async loadLiveTree(collectionId: string) {
      const rows = await transaction.selectFrom('nodes')
        .select(['id', 'parent_id', 'kind', 'is_root', 'title', 'url'])
        .where('collection_id', '=', collectionId)
        .where('deleted_at', 'is', null)
        .execute();
      const folders = rows
        .filter((row) => row.kind === 'folder')
        .map((row) => Object.freeze({
          id: row.id,
          parentId: row.parent_id ?? '',
          title: row.title ?? '',
        }));
      const bookmarks = rows
        .filter((row) => row.kind === 'bookmark' && typeof row.url === 'string')
        .map((row) => Object.freeze({
          id: row.id,
          parentId: row.parent_id ?? '',
          title: row.title ?? '',
          url: row.url as string,
        }));
      return Object.freeze({
        folders: Object.freeze(folders),
        bookmarks: Object.freeze(bookmarks),
      });
    },
  });
}

export function createPostgresOrganizePlanMutationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: {
    readonly productOrigin?: string;
    readonly metrics?: Metrics;
    readonly collectionHistoryEnabled?: boolean;
    readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  } = {},
): {
  execute<Result>(
    work: (ports: Omit<ApplyCollectionOrganizePlanPorts, never>) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: ApplyCollectionOrganizePlanPorts) => Promise<Result>,
      request: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createRequestUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => {
          const reads = createPostgresOrganizePlanReadPort(transaction);
          const writes = createPostgresOrganizePlanWritePort(transaction);
          return work({
            receipts: createOrganizePlanReceiptPort(transaction),
            plans: Object.freeze<OrganizePlanWritePort & OrganizePlanReadPort>({
              getById: (accountId, collectionId, planId) =>
                reads.getById(accountId, collectionId, planId),
              expireOpen: (accountId, collectionId, now) =>
                writes.expireOpen(accountId, collectionId, now),
              insert: (row) => writes.insert(row),
              findLatestCreatedAt: (accountId, collectionId) =>
                writes.findLatestCreatedAt(accountId, collectionId),
              persistApplyReceipt: (input) => writes.persistApplyReceipt(input),
              markApplied: (input) => writes.markApplied(input),
            }),
            collections: createPostgresOrganizePlanCollectionPort(transaction),
            mutations: createOrganizePlanCanonicalPorts(transaction, options),
            clock: { now: () => new Date() },
            ...(options.collectionHistoryEnabled === true
              ? {
                  treeVersions: {
                    enabled: true as const,
                    versions: createPostgresCollectionVersionStore(transaction),
                  },
                }
              : {}),
          });
        }, request);
    },
  });
}

function createOrganizePlanCanonicalPorts(
  transaction: DatabaseTransaction,
  options: { readonly productOrigin?: string; readonly metrics?: Metrics; readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort },
): ProductCollectionCanonicalPorts {
  const rawCanonical = createCanonicalMutationApplication(
    createPostgresCanonicalMutationPorts(transaction, {
      metrics: options.metrics,
      invalidateSyncReplicasOnNodeMutation: true,
      ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    }),
  );
  const rawReceipts = createPostgresProductCommandReceiptPort(transaction);
  const collections = createPostgresCollectionWritePort(transaction, options.metrics);
  const nodeReader = createPostgresNodeWritePort(transaction, options.metrics);
  return {
    receipts: {
      claim: (binding, fingerprint) => rawReceipts.claim(binding, fingerprint),
      complete: (binding, fingerprint, result) =>
        rawReceipts.complete(binding, fingerprint, result),
    },
    clock: createPostgresCollectionsClock(transaction),
    collections: {
      // T-10 lock order (ADR-0027): replica rows are locked before the
      // collection row because the canonical mutation below invalidates them.
      lockForUpdate: (collectionId) => lockCollectionForReplicaInvalidation(
        transaction, collectionId, () => collections.lockForUpdate(collectionId)),
    },
    nodes: {
      getNode: (collectionId, nodeId) => nodeReader.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId, parentId, maxDepth) =>
        nodeReader.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId, parentId) =>
        nodeReader.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId, parentId) =>
        nodeReader.hasLiveChildren!(collectionId, parentId),
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
    canonical: {
      execute: (input) => rawCanonical.execute({ transaction }, input),
      async bootstrapOwnedCollection() {
        throw new Error('canonical bootstrap is outside organize-plan apply');
      },
    },
    bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
    ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
  };
}

function createOrganizePlanReceiptPort(transaction: DatabaseTransaction): OrganizePlanReceiptPort {
  const base = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze({
    claim: (binding: ProductCommandBinding, fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (
      binding: ProductCommandBinding,
      fingerprint: string,
      result: Parameters<OrganizePlanReceiptPort['complete']>[2],
    ) => base.complete(binding, fingerprint, result),
    lookup: (binding: ProductCommandBinding, fingerprint: string) =>
      lookupOrganizePlanReceipt(transaction, binding, fingerprint),
  });
}

async function lookupOrganizePlanReceipt(
  transaction: DatabaseTransaction,
  binding: ProductCommandBinding,
  fingerprint: string,
): Promise<
  | { readonly kind: 'absent' }
  | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
> {
  assertCanonicalCommandId(binding.commandId);
  const row = await transaction.selectFrom('product_command_receipts').selectAll()
    .where('principal_id', '=', binding.principalId)
    .where('command_scope', '=', binding.commandScope)
    .where('command_id', '=', binding.commandId)
    .executeTakeFirst();
  if (!row) return { kind: 'absent' };
  if (row.request_fingerprint !== fingerprint) return { kind: 'reused' };
  if ((row.compact_claim || row.result_purged_at !== null || row.result_bytes === null)
      && row.completed_at !== null) {
    return { kind: 'expired', resultDigest: row.result_digest };
  }
  if (row.completed_at === null) return { kind: 'in_progress', retryAfterSeconds: 1 };
  return {
    kind: 'replay',
    result: {
      status: row.result_status!,
      body: row.result_bytes!,
      stableHeaders: row.result_headers ?? {},
      mediaType: row.result_media_type!,
      contractVersion: row.contract_version,
      targetIdentity: row.target_identity ?? undefined,
    },
  };
}
