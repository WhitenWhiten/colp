export interface EngineStabilityStatus {
  readonly ok?: boolean;
  readonly error?: string;
  readonly engine?: {
    readonly phase?: string;
    readonly recoveryFrozen?: boolean;
    readonly authorityRefreshRequired?: boolean;
    readonly cooldownPending?: boolean;
    readonly engineWakeInFlight?: boolean;
    readonly authorityRefreshInFlight?: boolean;
    readonly credentialReady?: boolean;
    readonly sessionReady?: boolean;
    readonly hasPendingWork?: boolean;
    readonly listenerInstalled?: boolean;
    readonly eventObserved?: number;
    readonly eventAccepted?: number;
    readonly eventRejected?: number;
    readonly eventRejectedReason?: string;
    readonly errorCode?: string;
  };
}

export interface AuthorityNetworkCounts {
  readonly authRequests: number;
  readonly sessionRequests: number;
}

export function engineStatusIsStable(status: EngineStabilityStatus): boolean {
  return engineUnstableFacts(status).length === 0;
}

export type EngineUnstableFact = 'status' | 'phase' | 'recoveryFrozen' | 'authorityRefreshRequired'
  | 'cooldownPending' | 'engineWakeInFlight' | 'authorityRefreshInFlight' | 'credentialReady'
  | 'sessionReady' | 'hasPendingWork' | 'listenerInstalled';

export function engineUnstableFacts(status: EngineStabilityStatus | undefined): EngineUnstableFact[] {
  const engine = status?.engine; const facts: EngineUnstableFact[] = [];
  if (status?.ok !== true) facts.push('status');
  if (engine?.phase !== 'sleeping') facts.push('phase');
  if (engine?.recoveryFrozen !== false) facts.push('recoveryFrozen');
  if (engine?.authorityRefreshRequired !== false) facts.push('authorityRefreshRequired');
  if (engine?.cooldownPending !== false) facts.push('cooldownPending');
  if (engine?.engineWakeInFlight !== false) facts.push('engineWakeInFlight');
  if (engine?.authorityRefreshInFlight !== false) facts.push('authorityRefreshInFlight');
  if (engine?.credentialReady !== true) facts.push('credentialReady');
  if (engine?.sessionReady !== true) facts.push('sessionReady');
  if (engine?.hasPendingWork !== false) facts.push('hasPendingWork');
  if (engine?.listenerInstalled !== true) facts.push('listenerInstalled');
  return facts;
}

export async function waitForEngineStability(options: {
  readonly readStatus: () => Promise<EngineStabilityStatus>;
  readonly networkCounts: () => AuthorityNetworkCounts;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly quietWindowMilliseconds?: number;
  readonly requiredStableSamples?: number;
}): Promise<AuthorityNetworkCounts> {
  const now = options.now ?? Date.now;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 250;
  const quietWindowMilliseconds = options.quietWindowMilliseconds ?? 1_500;
  const requiredStableSamples = options.requiredStableSamples ?? 3;
  const deadline = now() + timeoutMilliseconds;
  let priorCounts = validCounts(options.networkCounts());
  let quietSince: number | undefined;
  let stableSamples = 0;
  let polls = 0;
  let lastStatus: EngineStabilityStatus | undefined;

  while (now() <= deadline) {
    lastStatus = await options.readStatus(); polls += 1;
    const counts = validCounts(options.networkCounts());
    const trafficChanged = counts.authRequests !== priorCounts.authRequests
      || counts.sessionRequests !== priorCounts.sessionRequests;
    priorCounts = counts;
    if (!engineStatusIsStable(lastStatus) || trafficChanged) {
      stableSamples = engineStatusIsStable(lastStatus) ? 1 : 0;
      quietSince = engineStatusIsStable(lastStatus) ? now() : undefined;
    } else {
      stableSamples += 1;
      quietSince ??= now();
    }
    if (stableSamples >= requiredStableSamples && quietSince !== undefined
        && now() - quietSince >= quietWindowMilliseconds) return counts;
    await options.wait(pollIntervalMilliseconds);
  }
  throw new Error(`engine_stability_timeout:${JSON.stringify({ code: safeCode(lastStatus?.error) ?? 'not_stable',
    phase: safeCode(lastStatus?.engine?.phase) ?? 'missing', unstableFacts: engineUnstableFacts(lastStatus),
    engineError: safeCode(lastStatus?.engine?.errorCode) ?? 'none',
    polls, authRequests: priorCounts.authRequests,
    sessionRequests: priorCounts.sessionRequests })}`);
}

function validCounts(value: AuthorityNetworkCounts): AuthorityNetworkCounts {
  if (!Number.isSafeInteger(value.authRequests) || value.authRequests < 0
      || !Number.isSafeInteger(value.sessionRequests) || value.sessionRequests < 0) {
    throw new Error('engine_stability_collector_invalid');
  }
  return value;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(value) ? value : undefined;
}
