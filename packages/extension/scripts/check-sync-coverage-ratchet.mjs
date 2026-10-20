import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Executable owners added by the sync audit. These include production entry
 * points, not just extracted helpers, so wiring omissions remain measurable. */
export const SYNC_AUDIT_COVERAGE_FILES = Object.freeze([
  'src/advanced-first-run-ui.ts',
  'src/bookmark-boundary.ts',
  'src/bookmark-child-order.ts',
  'src/bookmark-content-capture.ts',
  'src/bookmark-event-codec.ts',
  'src/bookmark-event-ingress.ts',
  'src/bookmark-event-projection.ts',
  'src/bookmark-move-echo.ts',
  'src/bookmark-own-create-repair.ts',
  'src/bookmark-subscriptions/guards.ts',
  'src/bootstrap/advanced-run.ts',
  'src/bootstrap/local-facts.ts',
  'src/bootstrap/upload-rejection.ts',
  'src/browser-root-identity.ts',
  'src/chrome-bookmark-tree.ts',
  'src/cloud-capability.ts',
  'src/first-run-confirmation-session.ts',
  'src/first-run-draft.ts',
  'src/first-run-preview-copy.ts',
  'src/first-run-ui.ts',
  'src/generated/browser-ingress-title.ts',
  'src/kns-09-release.ts',
  'src/manifest-client.ts',
  'src/metadata-sync-policy.ts',
  'src/native-call-result.ts',
  'src/options.ts',
  'src/outbound-push-batch.ts',
  'src/outbound-push-encoding.ts',
  'src/personal-sync-fetch.ts',
  'src/public-server-manifest.ts',
  'src/pull-child-order.ts',
  'src/pull-create-evidence.ts',
  'src/pull-delete-apply.ts',
  'src/pull-item-set-aside.ts',
  'src/pull-native-content-barrier.ts',
  'src/pull-native-snapshot-resume.ts',
  'src/pull-range-materialize.ts',
  'src/pull-range-move.ts',
  'src/pull-restore-apply.ts',
  'src/push-recovery-barrier.ts',
  'src/queued-upload-batch-boundary.ts',
  'src/queued-upload-boundary.ts',
  'src/range-confirmation-session.ts',
  'src/range-ui.ts',
  'src/recovery-content.ts',
  'src/recovery-delete.ts',
  'src/recovery-placement.ts',
  'src/rejoin-decisions-ui.ts',
  'src/remote-delete-apply.ts',
  'src/remote-delete-local-work.ts',
  'src/replica-rebuild-ui.ts',
  'src/replica-repair-capability.ts',
  'src/replica-retirement.ts',
  'src/scope-range.ts',
  'src/scope-rejoin-authority.ts',
  'src/scope-rejoin-boundary.ts',
  'src/scope-rejoin-decisions.ts',
  'src/scope-rejoin-deletion.ts',
  'src/scope-rejoin-echo.ts',
  'src/scope-rejoin-materialize.ts',
  'src/scope-rejoin-members.ts',
  'src/scope-rejoin-mutation.ts',
  'src/scope-rejoin-order-progress.ts',
  'src/scope-rejoin-order.ts',
  'src/scope-rejoin-parents.ts',
  'src/scope-rejoin-placement.ts',
  'src/scope-rejoin-reconcile.ts',
  'src/scope-rejoin-rejection.ts',
  'src/scope-rejoin-remote-delete.ts',
  'src/scope-rejoin-restore.ts',
  'src/scope-rejoin-upload.ts',
  'src/server-account-ui.ts',
  'src/server-edition.ts',
  'src/service-worker.ts',
  'src/snapshot-create-boundary.ts',
  'src/snapshot-mounted-deletes.ts',
  'src/snapshot-native-boundary.ts',
  'src/sw/advanced-first-run.ts',
  'src/sw/auth.ts',
  'src/sw/bookmarks.ts',
  'src/sw/boundary-attempt.ts',
  'src/sw/boundary-confirmation.ts',
  'src/sw/first-run-browser-roots.ts',
  'src/sw/first-run.ts',
  'src/sw/messages.ts',
  'src/sw/native-chrome.ts',
  'src/sw/range-command.ts',
  'src/sw/range-remote-commands.ts',
  'src/sw/range.ts',
  'src/sw/rejoin-decisions.ts',
  'src/sw/rejoin-native.ts',
  'src/sw/roots.ts',
  'src/sw/scope-rebuild.ts',
  'src/sw/scope.ts',
  'src/sw/sync-attention.ts',
  'src/sw/sync-progress.ts',
  'src/sync-attention-ui.ts',
  'src/sync-effect-authority.ts',
  'src/sync-failure-class.ts',
  'src/sync-fetch-boundary.ts',
  'src/sync-folders.ts',
  'src/sync-issues.ts',
  'src/sync-label.ts',
  'src/sync-state/advanced-repository.ts',
  'src/sync-state/bookmark-event-child-order.ts',
  'src/sync-state/bookmark-event-dedupe.ts',
  'src/sync-state/bookmark-event-repository.ts',
  'src/sync-state/boundary-command-repository.ts',
  'src/sync-state/issue-dependencies.ts',
  'src/sync-state/mount-repository.ts',
  'src/sync-state/pull-mapping-writes.ts',
  'src/sync-state/pull-workset.ts',
  'src/sync-state/queue-hold.ts',
  'src/sync-state/queue-issue-repository.ts',
  'src/sync-state/queue-live-work.ts',
  'src/sync-state/queue-read-repository.ts',
  'src/sync-state/queued-upload-boundary-repository.ts',
  'src/sync-state/recovery-repository.ts',
  'src/sync-state/rejoin-decision-repository.ts',
  'src/sync-state/rejoin-queue-resolution.ts',
  'src/sync-state/rejoin-resolution-repository.ts',
  'src/sync-state/schema.ts',
  'src/sync-state/scope-command-evidence.ts',
  'src/sync-state/scope-command-record.ts',
  'src/sync-state/scope-facts-repository.ts',
  'src/sync-status-queue.ts',
]);

export const SYNC_CORE_COVERAGE_FILES = Object.freeze([
  'src/authority-fence.ts',
  'src/bookmark-event-queue.ts',
  'src/colp-transport-budget-browser.ts',
  'src/durable-sync-engine.ts',
  'src/effect-page-download.ts',
  'src/outbound-push-worker.ts',
  'src/pull-applier.ts',
  'src/pull-apply-runtime.ts',
  'src/pull-mapping-view.ts',
  'src/pull-local-projection-evidence.ts',
  'src/pull-bookmark-api.ts',
  'src/pull-codec.ts',
  'src/pull-page-stager.ts',
  'src/pull-projection.ts',
  'src/recovery-overlay.ts',
  'src/recovery-projection-executor.ts',
  'src/recovery-guard.ts',
  'src/local-projection-recovery.ts',
  'src/pull-mount-apply.ts',
  'src/scope-commands.ts',
  'src/bootstrap/coordinator.ts',
  'src/bootstrap/matcher.ts',
  'src/bookmark-node-identity.ts',
  'src/bookmark-event-reconcile.ts',
  'src/bookmark-deletion-scope.ts',
  'src/bookmark-create-receipt-identity.ts',
  'src/bookmark-event-pages.ts',
  'src/projection-native-occupancy.ts',
  'src/session-client.ts',
  'src/sync-state-store.ts',
  // B3-4: the durable-store repositories, the service-worker composition and the
  // native create/error seams were Sync core in behaviour but sat outside the
  // ratchet, so a hollow file could not fail the gate. They join the list with
  // their measured baseline; deliberately *not* added to `SYNC_PULL_COVERAGE_FILES`
  // or `SYNC_NEW_COVERAGE_FILES`, whose 80% branch floors they do not yet meet.
  'src/sync-state/engine-repository.ts',
  'src/sync-state/mapping-repository.ts',
  'src/sync-state/pull-repository.ts',
  'src/sync-state/queue-repository.ts',
  'src/sync-state/scope-repository.ts',
  'src/sw/engine.ts',
  'src/native-create-executor.ts',
  'src/bookmark-api-error.ts',
  // Remediation lifecycle owners: decisions, durable reorder staging and rebuild.
  'src/bookmark-reorder-uplink.ts',
  'src/native-wait.ts',
  'src/native-wait-target.ts',
  'src/replica-rebuild.ts',
  'src/sync-state/intent-facts-repository.ts',
  'src/sync-state/reorder-repository.ts',
  // Data-safety owners added by the DS audit; original file floors remain unchanged.
  'src/native-delete-executor.ts',
  'src/bookmark-event-heal.ts',
  'src/bookmark-observed-base.ts',
  'src/bookmark-event-resolve.ts',
  'src/bookmark-projection-metadata.ts',
  'src/subtree-observation.ts',
  'src/compacted-native-facts.ts',
  'src/pull-queue-facts.ts',
  'src/unmounted-range-repair.ts',
  'src/bootstrap/advanced-remote-executor.ts',
  'src/sync-compaction.ts',
  ...SYNC_AUDIT_COVERAGE_FILES,
]);

export const SYNC_COVERAGE_METRICS = Object.freeze(['lines', 'branches', 'functions', 'statements']);
export const SYNC_COVERAGE_MARGIN_PERCENTAGE_POINTS = 0.5;
export const SYNC_PULL_COVERAGE_FILES = Object.freeze([
  'src/pull-applier.ts',
  'src/pull-apply-runtime.ts',
  'src/pull-bookmark-api.ts',
  'src/pull-page-stager.ts',
]);
export const SYNC_PULL_BRANCH_MINIMUM = 80;
export const SYNC_NEW_COVERAGE_FILES = Object.freeze([
  'src/pull-local-projection-evidence.ts',
  'src/pull-mapping-view.ts',
  'src/recovery-guard.ts',
  'src/local-projection-recovery.ts',
  'src/pull-mount-apply.ts',
  'src/bootstrap/coordinator.ts',
  'src/bootstrap/matcher.ts',
  'src/bookmark-node-identity.ts',
  'src/bookmark-event-reconcile.ts',
  'src/bookmark-deletion-scope.ts',
  'src/bookmark-create-receipt-identity.ts',
  'src/bookmark-event-pages.ts',
  'src/projection-native-occupancy.ts',
  ...SYNC_AUDIT_COVERAGE_FILES,
]);
export const SYNC_NEW_COVERAGE_MINIMUM = 80;
export const SYNC_NEW_BRANCH_MINIMUM = SYNC_NEW_COVERAGE_MINIMUM;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSummaryPath = join(packageRoot, 'coverage/sync/coverage-summary.json');
const defaultBaselinePath = join(packageRoot, 'tests/fixtures/sync-coverage-baseline.json');

export function syncCoreSourcePath(filePath) {
  const normalized = String(filePath).split('\\').join('/');
  const marker = '/src/';
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return `src/${normalized.slice(index + marker.length)}`;
  if (normalized.startsWith('src/')) return normalized;
  return null;
}

function metricPct(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.pct === 'number' && Number.isFinite(entry.pct)) return entry.pct;
  return null;
}

export function evaluateSyncCoverageRatchet(summary, baseline) {
  const errors = [];
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return ['coverage summary is missing'];
  }
  if (!baseline || typeof baseline !== 'object' || baseline.files === null || typeof baseline.files !== 'object') {
    return ['coverage baseline is missing'];
  }
  const files = {};
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue;
    const relative = syncCoreSourcePath(key);
    if (relative) files[relative] = value;
  }
  for (const path of SYNC_CORE_COVERAGE_FILES) {
    const floors = baseline.files[path];
    const reported = files[path];
    if (!floors || typeof floors !== 'object') {
      errors.push(`${path}: missing from shrinking-only baseline`);
      continue;
    }
    if (!reported) {
      errors.push(`${path}: missing from coverage report`);
      continue;
    }
    const reportedBranches = metricPct(reported.branches);
    if (SYNC_PULL_COVERAGE_FILES.includes(path) && reportedBranches !== null
        && reportedBranches < SYNC_PULL_BRANCH_MINIMUM) {
      errors.push(`${path}: branches ${reportedBranches}% below hard Pull minimum ${SYNC_PULL_BRANCH_MINIMUM}%`);
    }
    for (const metric of SYNC_COVERAGE_METRICS) {
      const floor = floors[metric];
      const actual = metricPct(reported[metric]);
      if (typeof floor !== 'number' || !Number.isFinite(floor)) {
        errors.push(`${path}: ${metric} baseline is not a number`);
        continue;
      }
      if (actual === null) {
        errors.push(`${path}: ${metric} coverage is missing`);
        continue;
      }
      if (SYNC_NEW_COVERAGE_FILES.includes(path) && actual < SYNC_NEW_COVERAGE_MINIMUM) {
        errors.push(`${path}: ${metric} ${actual}% below new-file minimum ${SYNC_NEW_COVERAGE_MINIMUM}%`);
      }
      if (actual + SYNC_COVERAGE_MARGIN_PERCENTAGE_POINTS < floor) {
        errors.push(`${path}: ${metric} ${actual}% dropped below ${floor}%`);
      }
    }
  }
  return errors;
}

export function measuredSyncCoverageBaseline(summary, previous) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('coverage summary is missing');
  const byPath = {};
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue;
    const relative = syncCoreSourcePath(key);
    if (!relative || !SYNC_CORE_COVERAGE_FILES.includes(relative)) continue;
    byPath[relative] = value;
  }
  const files = {};
  for (const path of SYNC_CORE_COVERAGE_FILES) {
    const value = byPath[path];
    if (!value) throw new Error(`${path}: missing from coverage report`);
    files[path] = Object.fromEntries(SYNC_COVERAGE_METRICS.map((metric) => {
      const pct = metricPct(value[metric]);
      if (pct === null || pct < 0 || pct > 100) throw new Error(`${path}: ${metric} coverage is invalid`);
      if (SYNC_NEW_COVERAGE_FILES.includes(path) && pct < SYNC_NEW_COVERAGE_MINIMUM) {
        throw new Error(`${path}: ${metric} ${pct}% below new-file minimum ${SYNC_NEW_COVERAGE_MINIMUM}%`);
      }
      return [metric, Math.max(previous?.files?.[path]?.[metric] ?? 0, Math.floor(pct * 10) / 10)];
    }));
  }
  return { metrics: [...SYNC_COVERAGE_METRICS], files };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const writeBaseline = process.argv.includes('--write-baseline');
  // From-scratch bootstrap is deliberately a separate, explicit flag: an
  // ordinary `--write-baseline` must preserve existing reviewed floors, and a
  // missing baseline must not silently become a full set of zero floors. The
  // flag still refuses to run over an existing baseline, so it can only create
  // a first reviewed measurement, never silently replace one.
  const bootstrapBaseline = process.argv.includes('--bootstrap-baseline');
  const summary = readJson(defaultSummaryPath);
  if (bootstrapBaseline) {
    if (existsSync(defaultBaselinePath)) {
      throw new Error('--bootstrap-baseline refuses to overwrite an existing reviewed baseline; use --write-baseline');
    }
    const baseline = measuredSyncCoverageBaseline(summary);
    mkdirSync(dirname(defaultBaselinePath), { recursive: true });
    writeFileSync(defaultBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`sync-coverage: bootstrap wrote ${SYNC_CORE_COVERAGE_FILES.length}-file baseline from a complete measurement\n`);
    return;
  }
  if (writeBaseline) {
    const previous = readJson(defaultBaselinePath);
    const baseline = measuredSyncCoverageBaseline(summary, previous);
    const errors = evaluateSyncCoverageRatchet(summary, previous);
    if (errors.length) throw new Error(errors.join('\n'));
    writeFileSync(defaultBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`sync-coverage: wrote ${SYNC_CORE_COVERAGE_FILES.length}-file baseline\n`);
    return;
  }
  const baseline = readJson(defaultBaselinePath);
  const errors = evaluateSyncCoverageRatchet(summary, baseline);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`sync-coverage: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `sync-coverage: ${SYNC_CORE_COVERAGE_FILES.length} Sync core files at or above the per-file baseline\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
