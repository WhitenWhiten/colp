import type { SyncDomainRule } from '../domain/rule.js';
import type { SyncClock } from '../ports/clock.js';

export interface SyncPullApplication {
  readonly rule: SyncDomainRule;
  readonly clock: SyncClock;
}
