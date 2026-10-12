import type { BuildConfig } from './types.js';

export function managedServerOrigin(managed: Readonly<Record<string, unknown>>): string | undefined {
  return typeof managed.serverOrigin === 'string' && managed.serverOrigin.length > 0 ? managed.serverOrigin : undefined;
}

export function enforceManagedConfiguration(managed: Readonly<Record<string, unknown>>, _config: BuildConfig): void {
  const known = new Set(['identityDisabled', 'serverOrigin']);
  if (Object.keys(managed).some((key) => !known.has(key))) throw new Error('managed_configuration_conflict');
  if (managed.identityDisabled === true) throw new Error('policy_blocked');
  if (managed.identityDisabled !== undefined && managed.identityDisabled !== false) throw new Error('managed_configuration_conflict');
  // A managed serverOrigin prefills and locks the Account field. It is not a conflict with the pinned build.
  if (managed.serverOrigin !== undefined && typeof managed.serverOrigin !== 'string') {
    throw new Error('managed_configuration_conflict');
  }
}
