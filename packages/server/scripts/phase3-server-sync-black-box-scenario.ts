import { createHash } from 'node:crypto';
import {
  P3_26_SERVER_SYNC_SCENARIOS, appendPhase3ServerSyncStep,
  type Phase3ServerSyncScenario, type Phase3ServerSyncStepFact,
} from './acceptance/phase3-server-sync-acceptance.js';

export interface BlackBoxStepObservation {
  readonly endpoint: { readonly key: string; readonly method: 'GET' | 'POST' | 'DELETE' | 'JOB'; readonly routeTemplate: string; readonly uri: string };
  readonly outcome: 'success' | 'problem' | 'internal' | 'timeout' | 'abort' | 'retry' | 'replay' | 'concurrency';
  readonly problem: string | null;
  readonly transactionEvidence: unknown;
  readonly generationBefore: string | null;
  readonly generationAfter: string | null;
  readonly boundaryBefore: string | null;
  readonly boundaryAfter: string | null;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Protocol-only orchestration boundary. Implementations must perform the HTTP/job operation before
 * returning an observation; this module neither imports nor calls a backend business module.
 */
export interface Phase3ServerSyncBlackBoxRuntime {
  execute(scenario: Phase3ServerSyncScenario, signal: AbortSignal): Promise<BlackBoxStepObservation>;
}

export async function runPhase3ServerSyncBlackBoxScenario(input: {
  readonly runtime: Phase3ServerSyncBlackBoxRuntime;
  readonly runtimeNonce: string;
  readonly perStepTimeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<readonly Phase3ServerSyncStepFact[]> {
  let facts: readonly Phase3ServerSyncStepFact[] = [];
  for (const scenario of P3_26_SERVER_SYNC_SCENARIOS) {
    if (input.signal.aborted) throw input.signal.reason;
    const startedAt = new Date().toISOString();
    const observation = await withStepTimeout(
      (signal) => input.runtime.execute(scenario, signal), input.perStepTimeoutMs, input.signal,
    );
    const finishedAt = new Date().toISOString();
    const { uri, ...endpoint } = observation.endpoint;
    facts = appendPhase3ServerSyncStep(facts, input.runtimeNonce, {
      id: scenario, scenario,
      endpoint: { ...endpoint, uriDigest: digest('known.p3-26.endpoint.v1', uri) },
      outcome: observation.outcome, problem: observation.problem,
      transaction: digest('known.p3-26.transaction.v1', canonicalJson(observation.transactionEvidence)),
      generationBefore: observation.generationBefore, generationAfter: observation.generationAfter,
      boundaryBefore: observation.boundaryBefore, boundaryAfter: observation.boundaryAfter,
      startedAt, finishedAt, counts: observation.counts,
    });
  }
  return facts;
}

async function withStepTimeout<Value>(
  run: (signal: AbortSignal) => Promise<Value>, timeoutMs: number, parent: AbortSignal,
): Promise<Value> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('P3-26 step timeout is invalid');
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('P3-26 step timeout')), timeoutMs);
  timeout.unref();
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
    ]);
  } finally {
    clearTimeout(timeout); parent.removeEventListener('abort', onAbort);
  }
}

function digest(domain: string, value: string): string { return createHash('sha256').update(domain).update('\0').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new TypeError('noncanonical observation'); return encoded;
}
