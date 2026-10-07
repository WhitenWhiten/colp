import type { Kysely } from 'kysely';
import type { CommunityTargetQueryPorts } from '../../modules/community/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { loadCommunityCommentSettings } from './community-comment-shared-postgres.js';
import { resolveCommunityTargetRows } from './community-target-batch-postgres.js';
import {
  communityTargetCurator,
  readCommunityVoteCounts,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';

export interface PostgresCommunityTargetQueryUnitOfWork {
  execute<Result>(
    work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresCommunityTargetQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cancelBackend?: (backendPid: number) => Promise<boolean>,
): PostgresCommunityTargetQueryUnitOfWork {
  return Object.freeze<PostgresCommunityTargetQueryUnitOfWork>({
    execute<Result>(
      work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed', signal: execution.signal,
        cancelBackend })
        .execute(({ transaction }) => work(createPorts(transaction)));
    },
  });
}

function createPorts(transaction: DatabaseTransaction): CommunityTargetQueryPorts {
  return Object.freeze<CommunityTargetQueryPorts>({
    targets: {
      resolve: (query) => resolveCommunityTargetRow(transaction, query, 'none'),
      // One statement per kind for the whole batch; the ranking scan re-proves
      // up to MAX_SCAN_ENTRIES candidates per page.
      resolveMany: (queries) => resolveCommunityTargetRows(transaction, queries),
    },
    votes: {
      readCounts: (identity, generation, viewerAccountId) =>
        readCommunityVoteCounts(transaction, identity, generation, viewerAccountId),
    },
    curators: {
      canCurate: (identity, subjectId) => communityTargetCurator(transaction, identity, subjectId),
    },
    settings: {
      find: (identity) => loadCommunityCommentSettings(transaction, identity, 'none'),
    },
  });
}
