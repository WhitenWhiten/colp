import { randomBytes } from 'node:crypto';
import { type Kysely } from 'kysely';
import type {
  ModerationCommandPorts,
  ModerationQueryPorts,
} from '../../modules/governance/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { databaseNow } from '../database/time.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresModerationAudit, createPostgresModerationRoleStore } from './postgres-moderation-roles.js';
import { createPostgresModerationStore } from './postgres-moderation-store.js';
import { createPostgresModerationTargetResolver } from './postgres-moderation-targets.js';
import { createPostgresModerationOutbox } from './postgres-moderation-outbox.js';
export { createPostgresModerationActionMethods } from './postgres-moderation-actions.js';

export function createPostgresModerationCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
): { execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result> } {
  const base = createUnitOfWork(db);
  return {
    execute: (work) => base.execute(async ({ transaction }) => {
      const clock = { now: () => databaseNow(transaction) };
      return work({
        receipts: createPostgresProductCommandReceiptPort(transaction),
        store: createPostgresModerationStore(transaction),
        targets: createPostgresModerationTargetResolver(transaction, clock),
        roles: createPostgresModerationRoleStore(transaction),
        audit: createPostgresModerationAudit(transaction),
        outbox: createPostgresModerationOutbox(transaction),
        clock,
        ids: {
          nextCaseId: nextOpaqueId,
          nextEvidenceId: nextOpaqueId,
          nextActionId: nextOpaqueId,
          nextAppealId: nextOpaqueId,
          nextOutboxId: nextOpaqueId,
          nextEventId: nextOpaqueId,
        },
      });
    }),
  };
}

export function createPostgresModerationQueryPorts(
  db: Kysely<DatabaseSchema>,
): ModerationQueryPorts {
  return {
    store: createPostgresModerationStore(db),
    roles: createPostgresModerationRoleStore(db),
    clock: { now: () => databaseNow(db) },
  };
}

function nextOpaqueId(): string {
  return randomBytes(16).toString('base64url');
}
