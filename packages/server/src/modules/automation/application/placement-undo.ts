import type { OperationReceipt, UndoInput } from '@know-n/colp/automation';
import type { AutomationPorts } from './ports.js';
import { getAutomationRun } from './run-service.js';
import { parseContract, requireEtag } from './rule-service.js';
import { AutomationError } from '../domain/errors.js';
export interface PlacementUndoPort { undo(runId: string, input: UndoInput): Promise<OperationReceipt> }
export async function undoAutomationRun(ports: AutomationPorts, id: string, body: unknown, ifMatch: string): Promise<OperationReceipt> {
  const input = parseContract('UndoInput', body), run = await getAutomationRun(ports.runs, id);
  requireEtag(run.revision, ifMatch);
  const effect = run.effects.find(item => item.id === input.effectReceiptId);
  if (!effect || effect.effectDigest !== input.expectedEffectDigest)
    throw new AutomationError('automation_stale_input', 'Effect identity or digest changed.');
  return ports.placementUndo.undo(id, input);
}
