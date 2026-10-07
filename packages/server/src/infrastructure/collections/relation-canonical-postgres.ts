import type { Kysely } from 'kysely';
import {
  CanonicalMutationInvariantError,
  createCanonicalMutationApplication,
  type RelationMutationPorts,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type TransactionIsolationLevel } from '../database/unit-of-work.js';
import {
  createPostgresCanonicalMutationPorts,
  loadAuthoritativeRelationForUpdate,
  type PostgresCanonicalMutationFaultInjector,
} from './canonical-mutation-postgres-ports.js';
import { createPostgresCollectionWritePort, createPostgresCollectionsClock } from './repositories.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

export type RelationMutationWritePhase =
  | 'endpoints' | 'receipt' | 'ledger' | 'resource' | 'revision' | 'operation' | 'audit' | 'outbox';

export interface RelationMutationFaultContext {
  readonly phase: RelationMutationWritePhase;
  readonly relationId?: string;
}

export interface RelationMutationFaultInjector {
  afterPhase(context: RelationMutationFaultContext): void | Promise<void>;
}

export interface PostgresRelationMutationUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: RelationMutationFaultInjector;
  readonly outboxIdGenerator?: () => string;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export interface PostgresRelationMutationUnitOfWork {
  execute<Result>(work: (ports: RelationMutationPorts) => Promise<Result>): Promise<Result>;
}

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

function mapRelationFault(
  injector: RelationMutationFaultInjector | undefined,
): PostgresCanonicalMutationFaultInjector | undefined {
  if (!injector) return undefined;
  return {
    afterPhase: (context) => injector.afterPhase({
      phase: context.phase as RelationMutationWritePhase,
      relationId: context.resourceId,
    }),
  };
}

export function createPostgresRelationMutationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresRelationMutationUnitOfWorkOptions = {},
): PostgresRelationMutationUnitOfWork {
  const unitOfWork = createUnitOfWork(db, { isolationLevel: options.isolationLevel });
  return {
    execute(work) {
      return unitOfWork.execute(async ({ transaction }) => {
        const rawReceipts = createPostgresProductCommandReceiptPort(transaction);
        const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, {
          outboxIdGenerator: options.outboxIdGenerator,
          faultInjector: mapRelationFault(options.faultInjector),
          reportSourceInvalidation: options.reportSourceInvalidation,
        }));
        const collectionWriter = createPostgresCollectionWritePort(transaction);
        let claimed: string | undefined;
        let principal: string | undefined;
        let canonicalTarget: string | undefined;
        let canonicalSucceeded = false;
        let completed = false;
        let endpointResolutions = 0;
        const ports: RelationMutationPorts = {
          receipts: {
            async claim(binding, fingerprint) {
              if (claimed) invariant('Relation UoW may claim only one command');
              const result = await rawReceipts.claim(binding, fingerprint);
              if (result.kind === 'claimed') {
                claimed = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
                principal = binding.principalId;
              }
              return result;
            },
            async complete(binding, fingerprint, result) {
              const key = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
              if (!claimed || key !== claimed || !canonicalSucceeded || canonicalTarget !== result.targetIdentity) {
                invariant('Relation receipt does not own canonical result');
              }
              await rawReceipts.complete(binding, fingerprint, result);
              await options.faultInjector?.afterPhase({ phase: 'receipt', relationId: canonicalTarget });
              completed = true;
            },
            purgeExpired: (value) => rawReceipts.purgeExpired(value),
            deletePrincipalReceipts: (value) => rawReceipts.deletePrincipalReceipts(value),
          },
          clock: createPostgresCollectionsClock(transaction),
          collections: { lockForUpdate: (collectionId) => collectionWriter.lockForUpdate(collectionId) },
          accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
          endpoints: {
            async resolveLiveEndpoint(collectionId, nodeId) {
              const row = await transaction.selectFrom('nodes')
                .innerJoin('collections', 'collections.id', 'nodes.collection_id')
                .select(['nodes.id', 'nodes.collection_id', 'nodes.visibility', 'nodes.deleted_at',
                  'collections.visibility as collection_visibility'])
                .where('nodes.id', '=', nodeId).where('nodes.collection_id', '=', collectionId).executeTakeFirst();
              const value = row ? { id: row.id, collectionId: row.collection_id,
                visibility: row.visibility === 'inherit' ? row.collection_visibility : row.visibility,
                deletedAt: row.deleted_at } : null;
              endpointResolutions += 1;
              if (endpointResolutions === 2) {
                await options.faultInjector?.afterPhase({ phase: 'endpoints' });
              }
              return value;
            },
          },
          relations: {
            async hasLiveSemanticEdge(collectionId, fromNodeId, toNodeId, type) {
              return Boolean(await transaction.selectFrom('relations').select('id')
                .where('collection_id', '=', collectionId).where('from_node_id', '=', fromNodeId)
                .where('to_node_id', '=', toNodeId).where('type', '=', type)
                .where('deleted_at', 'is', null).executeTakeFirst());
            },
            loadAuthoritativeForUpdate(collectionId, relationId) {
              return loadAuthoritativeRelationForUpdate(transaction, collectionId, relationId);
            },
          },
          canonical: { async execute(input) {
            if (!claimed || input.actor.principalId !== principal || canonicalSucceeded) {
              invariant('Relation canonical mutation requires one owned receipt claim');
            }
            const result = await rawCanonical.execute({ transaction }, input);
            canonicalSucceeded = true;
            canonicalTarget = result.resourceId;
            return result;
          } },
        };
        const result = await work(ports);
        if (claimed && (!canonicalSucceeded || !completed)) invariant('Relation claimed command did not complete atomically');
        return result;
      });
    },
  };
}
