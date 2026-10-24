import type { Kysely } from 'kysely';
import { AutomationError,parseWorkerCommand,submitResult,type WorkerCommand,type AutomationWorkerService,type ResultSubmissionPort } from '../../modules/automation/index.js';
import { canonicalCommandFingerprint,assertCanonicalCommandId,type ProductCommandClaim } from '../../modules/commands/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createWorkerReadStore } from './worker-read-store.js';
import { createJobLeaseStore } from './lease-store.js';
import { advanceRunTasks } from './task-scheduler.js';
import { lockWorkJob } from './work-authority.js';
import type { TargetWorkerService } from './target-worker.js';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';

/** Shared HTTP/MCP commands; the Plan coordinator always runs outside the short job transaction. */
export function createAutomationWorkerService(db: Kysely<DatabaseSchema>,serverUuid: string,worker: TargetWorkerService,
  results: ResultSubmissionPort,cursorKey: string,serverDailyCap: number): AutomationWorkerService {
  return { ...createWorkerReadStore(db,serverUuid,worker,cursorKey),
    async mutate(actor,id,operation,body,commandId) {
      assertCanonicalCommandId(commandId);
      const command = parseWorkerCommand(operation,body),input = command.input;
      const binding = { principalId: actor.accountId,commandScope: JSON.stringify(['automation-work',actor.clientId,actor.credentialBindingId,id,operation]),commandId };
      const fingerprint = canonicalCommandFingerprint({ method: 'POST',route: `automation.jobs.${operation}`,resource: id,mediaType: 'application/json',body: input });
      const complete = (tx: DatabaseTransaction,value: unknown) => createPostgresProductCommandReceiptPort(tx).complete(binding,fingerprint,{ status: 200,
        body: new TextEncoder().encode(JSON.stringify(value)),mediaType: 'application/json',contractVersion: AUTOMATION_CONTRACT_VERSION,stableHeaders: { 'cache-control': 'private, no-store' } });
      const initial = await db.transaction().execute(async tx => {
        const job = await lockWorkJob(tx,actor,id,worker.authorizeRequest,operation !== 'claim');
        const claim = await createPostgresProductCommandReceiptPort(tx).claim(binding,fingerprint);
        if (claim.kind === 'replay') {
          if (command.operation === 'claim') throw new AutomationError('automation_claim_conflict','The one-time lease response cannot be reissued. Read the job and reconcile; the claim token is never stored in receipts.');
          if (command.operation === 'heartbeat') await createJobLeaseStore(tx,worker.authorizeRequest,serverDailyCap,serverUuid).verify(actor,id,command.input);
          return { value: decode(claim,command) };
        }
        if (claim.kind !== 'claimed' && !(operation === 'submit' && claim.kind === 'in_progress')) return { error: commandError(claim) };
        if (command.operation === 'submit') return { submit: true };
        const leases = createJobLeaseStore(tx,worker.authorizeRequest,serverDailyCap,serverUuid);
        if (command.operation === 'claim') {
          const result = await leases.claim(actor,id,command.input);
          if (result.kind === 'budget') await advanceRunTasks(tx,actor,serverUuid,job.run_id);
          // Persist a secret-free completed claim even when uncertainty/budget was durably changed.
          await complete(tx,{ oneTimeLease: true });
          if (result.kind === 'invalid') return { error: result.error };
          return result.kind === 'claimed' ? { value: result.lease } : { error: new AutomationError(result.kind === 'budget' ? 'automation_budget_exceeded' : 'automation_claim_conflict',
            result.kind === 'uncertain' ? 'External outcome is uncertain; explicit reconciliation is required.' : 'Job is not ready or optional budget is exhausted.') };
        }
        if (command.operation === 'heartbeat') {
          const value = await leases.heartbeat(actor,id,command.input),{ claimToken: _token,...safe } = value;
          await complete(tx,safe);return { value };
        }
        await leases.fail(actor,id,command.input);
        await advanceRunTasks(tx,actor,serverUuid,job.run_id);
        const value = { id: commandId,resourceId: job.id,status: 'completed',diagnostics: [] };
        await complete(tx,value);return { value };
      });
      if (initial.error) throw initial.error;
      if (!initial.submit) return initial.value;
      // Only submit is resumable: its durable proposal and stable plan/command IDs prevent duplicate effects.
      const value = await submitResult(results,actor,id,input);
      return db.transaction().execute(async tx => {
        await lockWorkJob(tx,actor,id,worker.authorizeRequest,true);
        const claim = await createPostgresProductCommandReceiptPort(tx).claim(binding,fingerprint);
        if (claim.kind === 'replay') return decode(claim,command);
        if (claim.kind !== 'in_progress' && claim.kind !== 'claimed') throw commandError(claim);
        await complete(tx,value);return value;
      });
    },
  };
}
function commandError(claim: Exclude<ProductCommandClaim,{ kind: 'claimed' | 'replay' }>): AutomationError {
  return new AutomationError(claim.kind === 'reused' ? 'automation_command_conflict' : 'automation_claim_conflict',
    claim.kind === 'reused' ? 'Command identity was reused with different input.' : claim.kind === 'expired' ? 'Command response expired; reconcile the existing job.' : 'Command is in progress.');
}
function decode(claim: Extract<ProductCommandClaim,{ kind: 'replay' }>,command: WorkerCommand): unknown {
  const value = JSON.parse(new TextDecoder().decode(claim.result.body));
  return command.operation === 'heartbeat' ? { ...value,claimToken: command.input.claimToken } : value;
}
