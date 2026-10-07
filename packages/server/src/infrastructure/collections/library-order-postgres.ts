import { sql, type Kysely } from 'kysely';
import {
  LIBRARY_ORDER_SECTIONS,
  type LibraryOrderCommandPorts,
  type LibraryOrderQueryPorts,
  type LibraryOrderSection,
  type LibraryOrderSectionState,
} from '../../modules/collections/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

export interface PostgresLibraryOrderCommandUnitOfWork {
  execute<Result>(
    work: (ports: LibraryOrderCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export interface PostgresLibraryOrderQueryUnitOfWork {
  execute<Result>(
    work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresLibraryOrderCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
): PostgresLibraryOrderCommandUnitOfWork {
  return Object.freeze<PostgresLibraryOrderCommandUnitOfWork>({
    execute<Result>(work: (ports: LibraryOrderCommandPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(db, work, execution.signal);
      }
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work(createCommandPorts(transaction)));
    },
  });
}

export function createPostgresLibraryOrderQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
): PostgresLibraryOrderQueryUnitOfWork {
  return Object.freeze<PostgresLibraryOrderQueryUnitOfWork>({
    execute<Result>(
      work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeQueryAbortable(db, work, execution.signal);
      }
      return work(createQueryPorts(db));
    },
  });
}

async function executeQueryAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      const result = await work(createQueryPorts(transaction));
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      await disposeCancellation();
    }
  });
}

function createQueryPorts(
  executor: Kysely<DatabaseSchema> | DatabaseTransaction,
): LibraryOrderQueryPorts {
  return Object.freeze<LibraryOrderQueryPorts>({
    orders: {
      async load(subjectId): Promise<readonly LibraryOrderSectionState[]> {
        const result = await sql<{ section: LibraryOrderSection; collection_ids: unknown }>`
          select section, collection_ids
          from library_sidebar_orders
          where subject_id=${subjectId}
        `.execute(executor);
        return result.rows
          .filter((row) => LIBRARY_ORDER_SECTIONS.includes(row.section))
          .map((row) => ({
            section: row.section,
            collectionIds: parseStoredIds(row.collection_ids),
          }));
      },
    },
  });
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  work: (ports: LibraryOrderCommandPorts) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      const result = await work(createCommandPorts(transaction));
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      await disposeCancellation();
    }
  });
}

function createCommandPorts(transaction: DatabaseTransaction): LibraryOrderCommandPorts {
  return Object.freeze<LibraryOrderCommandPorts>({
    receipts: createPostgresProductCommandReceiptPort(transaction),
    orders: {
      async save(entry): Promise<void> {
        await sql`
          insert into library_sidebar_orders (subject_id, section, collection_ids, updated_at)
          values (${entry.subjectId}, ${entry.section},
            ${JSON.stringify(entry.collectionIds)}::jsonb, ${entry.updatedAt})
          on conflict (subject_id, section) do update
            set collection_ids=excluded.collection_ids, updated_at=excluded.updated_at
        `.execute(transaction);
      },
    },
    clock: {
      async now(): Promise<Date> {
        return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now;
      },
    },
  });
}

function parseStoredIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
