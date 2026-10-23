import type { ResolvedServiceOptions } from './change-plan-options.js';
import { assertCommitTransaction, normalizeCommitFailure } from './change-plan-state.js';
import { McpChangePlanError, type McpChangePlanCommitTransaction, type McpChangePlanTransactionBeginContext } from './change-plan-types.js';

type Coordinator<Transaction extends McpChangePlanCommitTransaction> = Pick<
  ResolvedServiceOptions<Transaction>['commitCoordinator'], 'receiver' | 'begin' | 'commit' | 'rollback' | 'release'
>;

/** One lifecycle for approval, commit and cancellation, including cleanup failures. */
export async function runChangePlanTransaction<Transaction extends McpChangePlanCommitTransaction, Value>(
  coordinator: Coordinator<Transaction>,
  context: McpChangePlanTransactionBeginContext,
  label: 'Approval' | 'Commit' | 'Cancel',
  work: (transaction: Transaction) => Promise<Value>,
): Promise<Value> {
  let transaction: Transaction | undefined;
  let outcome: { ok: true; value: Value } | { ok: false; error: unknown } | undefined;
  try {
    transaction = await Reflect.apply(coordinator.begin, coordinator.receiver, [context]);
    assertCommitTransaction(transaction);
    const value = await work(transaction);
    await Reflect.apply(coordinator.commit, coordinator.receiver, [transaction]);
    outcome = { ok: true, value };
  } catch (cause) {
    outcome = { ok: false, error: cause };
    if (transaction !== undefined) {
      try {
        await Reflect.apply(coordinator.rollback, coordinator.receiver, [transaction, cause]);
      } catch {
        outcome = { ok: false, error: new McpChangePlanError('commit_failed', `${label} rollback failed; transaction outcome is not reported as successful.`) };
      }
    }
  } finally {
    if (transaction !== undefined) {
      try {
        await Reflect.apply(coordinator.release, coordinator.receiver, [transaction]);
      } catch {
        outcome = { ok: false, error: new McpChangePlanError('commit_failed', `${label} transaction release failed; the request failed closed.`) };
      }
    }
  }
  if (outcome === undefined) throw new McpChangePlanError('commit_failed', `${label} completed without a transaction outcome.`);
  if (!outcome.ok) throw normalizeCommitFailure(outcome.error);
  return outcome.value;
}
