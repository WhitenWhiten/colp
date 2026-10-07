export type LimiterCapabilityStatus = 'ready' | 'not-ready';

export interface LimiterCapabilityReadiness {
  readonly capability: 'limiter';
  readonly status: LimiterCapabilityStatus;
  readonly mode: 'in-process' | 'shared';
  readonly reason?: 'limiter_unavailable';
}

export function limiterCapabilityFromStates(
  sharedEnabled: boolean,
  unhealthy: boolean,
): LimiterCapabilityReadiness {
  if (!sharedEnabled) {
    return Object.freeze({ capability: 'limiter', status: 'ready', mode: 'in-process' });
  }
  if (unhealthy) {
    return Object.freeze({
      capability: 'limiter',
      status: 'not-ready',
      mode: 'shared',
      reason: 'limiter_unavailable',
    });
  }
  return Object.freeze({ capability: 'limiter', status: 'ready', mode: 'shared' });
}
