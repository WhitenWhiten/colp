/**
 * Attempts transaction rollback without hiding either the operation failure
 * or a broken connection/transaction discovered during rollback.
 */
export async function rollbackTransaction(
  operationError: unknown,
  rollback: () => Promise<unknown>,
  context: string,
): Promise<void> {
  try {
    await rollback();
  } catch (rollbackError: unknown) {
    throw new AggregateError(
      [operationError, rollbackError],
      `${context} failed and transaction rollback also failed`,
    );
  }
}
