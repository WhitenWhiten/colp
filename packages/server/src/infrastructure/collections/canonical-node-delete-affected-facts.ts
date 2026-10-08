import { CompiledQuery } from 'kysely';
import { CanonicalMutationInvariantError } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Bound each fact insert. A large subtree must not become one statement or one event payload. */
export const NODE_DELETE_AFFECTED_FACT_PAGE_SIZE = 128;

export interface AffectedFactExecutor {
  (statement: string, parameters: readonly unknown[]): Promise<{
    readonly rows: readonly Record<string, unknown>[];
  }>;
}

export interface NodeDeleteAffectedFactWrite {
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly rootNodeId: string;
  readonly operationId: string;
  readonly resourceIds: readonly string[];
}

export function kyselyAffectedFactExecutor(transaction: DatabaseTransaction): AffectedFactExecutor {
  return async (statement, parameters) => {
    const result = await transaction.executeQuery<Record<string, unknown>>(
      CompiledQuery.raw(statement, [...parameters]),
    );
    return { rows: result.rows };
  };
}

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

/**
 * Persist the delete operation's node ids. Callers must pass the ids captured
 * for this operation, never a set re-read from the current tree.
 */
export async function persistNodeDeleteAffectedFacts(
  execute: AffectedFactExecutor,
  write: NodeDeleteAffectedFactWrite,
): Promise<void> {
  const ids = write.resourceIds;
  if (
    ids.length === 0
    || ids.some((id) => id.length === 0)
    || new Set(ids).size !== ids.length
    || !ids.includes(write.rootNodeId)
  ) {
    invariant('delete affected resource facts are invalid');
  }
  for (let offset = 0; offset < ids.length; offset += NODE_DELETE_AFFECTED_FACT_PAGE_SIZE) {
    const page = ids.slice(offset, offset + NODE_DELETE_AFFECTED_FACT_PAGE_SIZE)
      .map((resourceId, index) => ({
        resource_id: resourceId,
        fact_ordinal: offset + index,
      }));
    const inserted = await execute(
      `INSERT INTO node_delete_affected_resources (
         collection_id, commit_ordinal, root_node_id, resource_id, fact_ordinal, operation_id, recorded_at
       )
       SELECT $1, $2::bigint, $3, input.resource_id, input.fact_ordinal, $4, current_timestamp
       FROM jsonb_to_recordset($5::jsonb) AS input(resource_id text, fact_ordinal integer)
       RETURNING resource_id`,
      [
        write.collectionId,
        write.commitOrdinal.toString(),
        write.rootNodeId,
        write.operationId,
        JSON.stringify(page),
      ],
    );
    if (inserted.rows.length !== page.length) {
      invariant(
        `delete affected resource fact page inserted ${inserted.rows.length} rows instead of ${page.length}`,
      );
    }
  }
}
