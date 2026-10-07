import type { Kysely } from 'kysely';
import type { CommunityCommentQueryPorts } from '../../modules/community/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
} from '../database/unit-of-work.js';
import {
  countCommunityVisibleDirectReplies,
  countCommunityVisibleThreadReplies,
  loadCommunityCommentAuthors,
  loadCommunityCommentCuration,
  loadCommunityCommentRecord,
  loadCommunityCommentSettings,
  scanCommunityCommentDescendants,
  scanCommunityCommentRoots,
} from './community-comment-shared-postgres.js';
import {
  communityTargetCurator,
  loadCommunityTargetCreatedAt,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';

export interface PostgresCommunityCommentQueryUnitOfWork {
  execute<Result>(
    work: (ports: CommunityCommentQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

/**
 * CS-03 read ports for the three comment read operations. One read-only
 * transaction per page: the shared target resolve re-proves CURRENT
 * visibility, the scans are bound to the resolved generation, and the
 * public-author projection joins live account/profile/handle rows.
 */
export function createPostgresCommunityCommentQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cancelBackend?: (backendPid: number) => Promise<boolean>,
): PostgresCommunityCommentQueryUnitOfWork {
  return Object.freeze<PostgresCommunityCommentQueryUnitOfWork>({
    execute<Result>(
      work: (ports: CommunityCommentQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed', signal: execution.signal,
        cancelBackend })
        .execute(({ transaction }) => work(createPorts(transaction)));
    },
  });
}

function createPorts(transaction: DatabaseTransaction): CommunityCommentQueryPorts {
  return Object.freeze<CommunityCommentQueryPorts>({
    targets: {
      resolve: (query) => resolveCommunityTargetRow(transaction, query, 'none'),
      createdAt: (identity) => loadCommunityTargetCreatedAt(transaction, identity),
    },
    curators: {
      canCurate: (identity, subjectId) => communityTargetCurator(transaction, identity, subjectId),
    },
    comments: {
      findById: (commentId) => loadCommunityCommentRecord(transaction, commentId, 'none'),
      scanRoots: (identity, generation, after, limit) =>
        scanCommunityCommentRoots(transaction, identity, generation, after, limit),
      scanDescendants: (rootId, after, limit) =>
        scanCommunityCommentDescendants(transaction, rootId, after, limit),
      countVisibleThreadReplies: (rootIds) =>
        countCommunityVisibleThreadReplies(transaction, rootIds),
      countVisibleDirectReplies: (commentIds) =>
        countCommunityVisibleDirectReplies(transaction, commentIds),
    },
    curations: {
      find: (commentId) => loadCommunityCommentCuration(transaction, commentId, 'none'),
    },
    settings: {
      find: (identity) => loadCommunityCommentSettings(transaction, identity, 'none'),
    },
    authors: {
      publicActors: (accountIds) => loadCommunityCommentAuthors(transaction, accountIds),
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}
