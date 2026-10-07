import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { SyncSessionIssueError } from '../../modules/sync/index.js';
import { validateOptions } from './postgres/sync-session-admission-postgres.js';
import { issueInTransaction, verifyInTransaction } from './postgres/sync-session-coordinator-postgres.js';
import {
  isCommittedIssueDenial,
  type IssueTransactionOutcome,
  type PostgresSyncSessionIssuer,
  type PostgresSyncSessionIssuerOptions,
} from './postgres/sync-session-types-postgres.js';

export type {
  PostgresSyncSessionCommittedDenial,
  PostgresSyncSessionIssueTransactionOutcome,
  PostgresSyncSessionIssuer,
  PostgresSyncSessionIssuerOptions,
  SyncSessionIdGenerator,
  SyncSessionIssueFaultInjector,
  SyncSessionIssueFaultPhase,
} from './postgres/sync-session-types-postgres.js';

export function createPostgresSyncSessionIssuer(
  db: Kysely<DatabaseSchema>,
  inputOptions: PostgresSyncSessionIssuerOptions,
): PostgresSyncSessionIssuer {
  const options = validateOptions(inputOptions);
  const completeIssue = (outcome: IssueTransactionOutcome) => {
    if (isCommittedIssueDenial(outcome)) {
      throw new SyncSessionIssueError(outcome.code, outcome.snapshotUrl);
    }
    return outcome;
  };
  return {
    issue(input) {
      return createUnitOfWork(db).execute(({ transaction }) =>
        issueInTransaction(transaction, input, options)).then(completeIssue);
    },
    issueInTransaction(transaction, input) {
      return issueInTransaction(transaction, input, options);
    },
    completeIssue,
    verify(input) {
      return createUnitOfWork(db)
        .execute(({ transaction }) => verifyInTransaction(transaction, input, options))
        .then((outcome) => {
          if (isCommittedIssueDenial(outcome)) {
            throw new SyncSessionIssueError(outcome.code, outcome.snapshotUrl);
          }
          return outcome;
        });
    },
  };
}
