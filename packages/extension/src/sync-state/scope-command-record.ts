import { SyncStateError, type JsonObject, type ScopeCommandKind, type ScopeCommandPhase, type ScopeCommandPlanRecord } from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';

const COMMAND_KINDS: readonly ScopeCommandKind[] = ['detach', 'rejoin', 'remoteDelete', 'rangeExit'];
const COMMAND_PHASES: readonly ScopeCommandPhase[] = ['preview', 'confirmed', 'fetching', 'comparing', 'applying', 'pending', 'active', 'failed'];

export function validateScopeCommandPlan(key: string, input: unknown, maxBytes: number): ScopeCommandPlanRecord {
  const row = strictObject(clone(input), ['scopeKey', 'commandId', 'kind', 'confirmationVersion', 'baselineDigest',
    'phase', 'dependencies', 'retryReason', 'mountId', 'updatedAt', 'rejoinDecision'], 'scope command plan',
    ['scopeKey', 'retryReason', 'mountId', 'rejoinDecision']);
  if (row.scopeKey !== undefined && row.scopeKey !== key) throw new SyncStateError('command_scope_invalid');
  const kind = String(row.kind) as ScopeCommandKind;
  const phase = String(row.phase) as ScopeCommandPhase;
  if (!COMMAND_KINDS.includes(kind)) throw new SyncStateError('command_kind_invalid');
  if (!COMMAND_PHASES.includes(phase)) throw new SyncStateError('command_phase_invalid');
  if (!Array.isArray(row.dependencies)) throw new SyncStateError('command_dependencies_invalid');
  const record: ScopeCommandPlanRecord = {
    scopeKey: key, commandId: boundedString(row.commandId, 'commandId'), kind,
    confirmationVersion: boundedString(row.confirmationVersion, 'confirmationVersion', 64),
    baselineDigest: row.baselineDigest === null ? null : boundedString(row.baselineDigest, 'baselineDigest'),
    phase, dependencies: row.dependencies.map((item) => boundedString(item, 'dependency')),
    updatedAt: safeInteger(row.updatedAt, 'updatedAt', 1),
    ...(row.rejoinDecision === undefined ? {} : { rejoinDecision: validateDecision(row.rejoinDecision) }),
    ...(row.retryReason === undefined ? {} : { retryReason: boundedString(row.retryReason, 'retryReason', 128) }),
    ...(row.mountId === undefined ? {} : { mountId: boundedString(row.mountId, 'mountId') }),
  };
  validateRecord(record, maxBytes); return record;
}

function validateDecision(value: unknown): JsonObject {
  const decision = validateJson(value, 'rejoinDecision');
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new SyncStateError('command_decision_invalid');
  return decision;
}
