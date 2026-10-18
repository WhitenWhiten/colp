export interface SyncResilienceCheck { readonly id: string; readonly title: string; readonly level: 'MUST' }
export interface SyncResilienceReport {
  readonly target: string; readonly profile: string; readonly requestCount: number;
  readonly summary: { readonly pass: number; readonly fail: number; readonly skip: number; readonly warn: number };
  readonly results: readonly (SyncResilienceCheck & { readonly status: string; readonly observations: number; readonly details: readonly string[] })[];
  readonly notes: readonly string[];
}
export const SYNC_RESILIENCE_CHECKS: readonly SyncResilienceCheck[];
export function verifySyncResilienceCase(id: string, observed: unknown): string[];
export function runSyncResilienceConformance(target: {
  readonly name?: string; runScenario(id: string): Promise<unknown>;
}, options?: { readonly cases?: readonly string[] }): Promise<SyncResilienceReport>;
