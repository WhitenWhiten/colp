/** Each group is an independent PostgreSQL + xvfb CI job. */
export const syncAcceptanceGroups = Object.freeze({
  onboarding: [
    'e2e/mv3-first-sync-from-ui.spec.ts',
    'e2e/mv3-first-sync-promises.spec.ts',
    'e2e/mv3-advanced-first-run.spec.ts',
    'e2e/mv3-boundary-settings.spec.ts',
    'e2e/mv3-bookmark-roots.spec.ts',
  ],
  recovery: [
    'e2e/mv3-ongoing-sync-recovery.spec.ts',
    'e2e/mv3-sync-resilience.spec.ts',
    'e2e/mv3-first-sync-recovery.spec.ts',
    'e2e/mv3-personal-sync-lifecycle.spec.ts',
    'e2e/mv3-personal-sync-reconnect.spec.ts',
    'e2e/mv3-rejoin-local-deletion.spec.ts',
  ],
  web: ['e2e/mv3-library-web-flow.spec.ts'],
});

export function acceptanceSpecs(group) {
  if (!Object.hasOwn(syncAcceptanceGroups, group)) throw new Error(`Unknown sync acceptance group: ${group}`);
  const specs = syncAcceptanceGroups[group];
  if (specs.length === 0) throw new Error(`Empty sync acceptance group: ${group}`);
  return specs;
}

/** These specs serve the built web product from the real PostgreSQL harness. */
const webProductSpecs = new Set(['e2e/mv3-sync-resilience.spec.ts', 'e2e/mv3-library-web-flow.spec.ts']);
export function acceptanceNeedsWebProduct(group) {
  return acceptanceSpecs(group).some(spec => webProductSpecs.has(spec));
}

// Require actual successful jobs, including each shard. A docs-only ci-gate
// success with skipped acceptance owners cannot qualify a release artifact.
export const requiredReleaseJobs = Object.freeze([
  'server', 'server-sync-audit-coverage', ...[1, 2, 3, 4, 5, 6].map(shard => `server-integration (${shard})`),
  'extension', 'extension-coverage', 'extension-mv3', 'extension-sync-real-stack',
  'extension-kns-09-release', 'extension-kns-09-e2e',
  ...Object.keys(syncAcceptanceGroups).map(group => `extension-sync-lifecycle (${group})`),
  'ci-gate',
]);
