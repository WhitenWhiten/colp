import { sql, type Kysely } from 'kysely';
import {
  CanonicalMutationInvariantError,
  createCanonicalMutationApplication,
  type AnnotationMutationPorts,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type TransactionIsolationLevel } from '../database/unit-of-work.js';
import {
  createPostgresCanonicalMutationPorts,
  loadAuthoritativeAnnotationForUpdate,
  type PostgresCanonicalMutationFaultInjector,
} from './canonical-mutation-postgres-ports.js';
import { createPostgresCollectionWritePort, createPostgresCollectionsClock } from './repositories.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

export type AnnotationMutationWritePhase =
  | 'receipt' | 'ledger' | 'resource' | 'revision' | 'operation' | 'audit' | 'outbox';

export interface AnnotationMutationFaultContext {
  readonly phase: AnnotationMutationWritePhase;
  readonly annotationId?: string;
}

export interface AnnotationMutationFaultInjector {
  afterPhase(context: AnnotationMutationFaultContext): void | Promise<void>;
}

export interface PostgresAnnotationMutationUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: AnnotationMutationFaultInjector;
  readonly outboxIdGenerator?: () => string;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export interface PostgresAnnotationMutationUnitOfWork {
  execute<Result>(work: (ports: AnnotationMutationPorts) => Promise<Result>): Promise<Result>;
}

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

function mapAnnotationFault(
  injector: AnnotationMutationFaultInjector | undefined,
): PostgresCanonicalMutationFaultInjector | undefined {
  if (!injector) return undefined;
  return {
    afterPhase: (context) => injector.afterPhase({
      phase: context.phase as AnnotationMutationWritePhase,
      annotationId: context.resourceId,
    }),
  };
}

export function createPostgresAnnotationMutationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresAnnotationMutationUnitOfWorkOptions = {},
): PostgresAnnotationMutationUnitOfWork {
  const unitOfWork = createUnitOfWork(db, { isolationLevel: options.isolationLevel });
  return {
    execute(work) {
      return unitOfWork.execute(async ({ transaction }) => {
        const rawReceipts = createPostgresProductCommandReceiptPort(transaction);
        const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, {
          outboxIdGenerator: options.outboxIdGenerator,
          faultInjector: mapAnnotationFault(options.faultInjector),
          reportSourceInvalidation: options.reportSourceInvalidation,
        }));
        const collectionWriter = createPostgresCollectionWritePort(transaction);
        let claimCalled = false;
        let claimed: string | undefined;
        let principal: string | undefined;
        let canonicalCalled = false;
        let canonicalSucceeded = false;
        let canonicalTarget: string | undefined;
        let completed = false;
        const ports: AnnotationMutationPorts = {
          receipts: {
            async claim(binding, fingerprint) {
              if (claimCalled) invariant('Annotation UoW may claim only one command');
              claimCalled = true;
              const result = await rawReceipts.claim(binding, fingerprint);
              if (result.kind === 'claimed') {
                claimed = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
                principal = binding.principalId;
              }
              return result;
            },
            async complete(binding, fingerprint, result) {
              const key = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
              if (!claimed || claimed !== key || !canonicalSucceeded || canonicalTarget !== result.targetIdentity) {
                invariant('Annotation receipt does not own the canonical result');
              }
              if (completed) invariant('Annotation receipt may complete only once');
              await rawReceipts.complete(binding, fingerprint, result);
              await options.faultInjector?.afterPhase({ phase: 'receipt', annotationId: canonicalTarget });
              completed = true;
            },
            purgeExpired: (purgeOptions) => rawReceipts.purgeExpired(purgeOptions),
            deletePrincipalReceipts: (principalId) => rawReceipts.deletePrincipalReceipts(principalId),
          },
          clock: createPostgresCollectionsClock(transaction),
          collections: { lockForUpdate: (collectionId) => collectionWriter.lockForUpdate(collectionId) },
          accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
          subjects: {
            async resolveLiveSubject(collectionId, type, subjectId) {
              if (type === 'collection') {
                const row = await transaction.selectFrom('collections').select(['id', 'visibility', 'deleted_at'])
                  .where('id', '=', subjectId).where('id', '=', collectionId).executeTakeFirst();
                return row ? { type, id: row.id, collectionId: row.id,
                  visibility: row.visibility, deletedAt: row.deleted_at } : null;
              }
              const row = await transaction.selectFrom('nodes').innerJoin('collections', 'collections.id', 'nodes.collection_id')
                .select(['nodes.id', 'nodes.collection_id', 'nodes.visibility', 'nodes.deleted_at', 'collections.visibility as collection_visibility'])
                .where('nodes.id', '=', subjectId).where('nodes.collection_id', '=', collectionId).executeTakeFirst();
              if (!row) return null;
              const visibility = row.visibility === 'inherit' ? row.collection_visibility : row.visibility;
              return { type, id: row.id, collectionId: row.collection_id, visibility, deletedAt: row.deleted_at };
            },
          },
          annotations: {
            async hasOwnPrivateNote(collectionId, subjectId, principalId) {
              const row = await transaction.selectFrom('annotations').select('id')
                .where('collection_id', '=', collectionId).where('subject_type', '=', 'node')
                .where('subject_id', '=', subjectId).where('creator_principal_id', '=', principalId)
                .where('deleted_at', 'is', null).where('visibility', '=', 'private')
                .where(sql<string>`payload_json->>'type'`, '=', 'note').executeTakeFirst();
              return Boolean(row);
            },
            async countLiveForSubject(collectionId, type, subjectId) {
              const result = await transaction.selectFrom('annotations')
                .select(({ fn }) => fn.countAll<number>().as('count'))
                .where('collection_id', '=', collectionId).where('subject_type', '=', type)
                .where('subject_id', '=', subjectId).where('deleted_at', 'is', null)
                .executeTakeFirstOrThrow();
              return Number(result.count);
            },
            loadAuthoritativeForUpdate(collectionId, annotationId, requestingPrincipalId) {
              return loadAuthoritativeAnnotationForUpdate(
                transaction,
                collectionId,
                annotationId,
                requestingPrincipalId,
              );
            },
          },
          canonical: { async execute(input) {
            if (canonicalCalled) invariant('Annotation UoW may execute one mutation');
            if (!claimed || input.actor.principalId !== principal) invariant('Annotation canonical mutation requires owned receipt claim');
            canonicalCalled = true;
            const result = await rawCanonical.execute({ transaction }, input);
            canonicalSucceeded = true;
            canonicalTarget = result.resourceId;
            return result;
          } },
        };
        const result = await work(ports);
        if (!claimCalled) invariant('Annotation UoW must claim one command');
        if (claimed && (!canonicalSucceeded || !completed)) invariant('Annotation command left an incomplete receipt');
        return result;
      });
    },
  };
}
