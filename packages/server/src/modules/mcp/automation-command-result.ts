import { AutomationError } from '../automation/index.js';
import type { ProductSyncCommandOutcome } from '../sync/index.js';

/** Product recovery receipts are shared by HTTP and MCP callers. */
export function automationCommandResult(outcome: ProductSyncCommandOutcome<unknown>): unknown {
  if (outcome.kind === 'committed') return outcome.result;
  if (outcome.kind === 'replay') return JSON.parse(new TextDecoder().decode(outcome.body));
  if (outcome.kind === 'in_progress') throw new AutomationError('rate_limited',
    'This command is still running; retry the same command and arguments.', [], null, outcome.retryAfterSeconds);
  throw new AutomationError('automation_command_conflict', outcome.kind === 'expired'
    ? 'The command receipt expired; inspect current state before requesting another command.' : 'This command id was reused with different arguments.');
}
