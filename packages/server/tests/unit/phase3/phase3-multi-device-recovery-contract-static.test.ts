import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { verifyPhase3Pkce } from '../../../scripts/phase3-multi-device-recovery-runtime.mjs';
import { loadConfig } from '../../support/test-config.js';
import {
  createPhase3BackendEnvironment,
} from '../../../scripts/phase3-multi-device-recovery-runner.mjs';
import { containsPhase3Marker, markerVariants } from '../../../scripts/phase3-marker-scan.mjs';
import {
  PHASE3_ACCEPTANCE_FAIL_CLOSED,
  PHASE3_ACCEPTANCE_LEASE_SECONDS,
  PHASE3_ACCEPTANCE_MODE,
  PHASE3_ACCEPTANCE_RECOVERY_WAIT_MS,
  PHASE3_ACCEPTANCE_STAGE,
  PHASE3_ALLOWED_ENV,
  PHASE3_CURSOR_FAMILIES,
  PHASE3_DIAGNOSTIC_FAST_LEASE_SECONDS,
  PHASE3_DIAGNOSTIC_FAST_RECOVERY_WAIT_MS,
  PHASE3_DIAGNOSTIC_FAST_STAGES,
  PHASE3_DIAGNOSTIC_FORMAT,
  PHASE3_DIAGNOSTIC_MODE,
  PHASE3_EVIDENCE_OUTPUT_RELATIVE,
  PHASE3_FAILURE_FORMAT,
  PHASE3_FORBIDDEN_RUNNER_PATTERNS,
  PHASE3_FULL_FAST_STAGE,
  PHASE3_PRODUCTION_ARTIFACT_RELATIVE,
  PHASE3_PRODUCT_CURSOR_FAMILIES,
  PHASE3_READ_ONLY,
  PHASE3_REQUIRED_COMMAND_TOKENS,
  PHASE3_WITH_POSTGRES_SCRIPT,
} from '../../../scripts/phase3-multi-device-recovery-bindings.mjs';

const repository = resolve(import.meta.dirname, '../../../..');

function extensionSrc(relative: string): string {
  return readFileSync(resolve(repository, 'Known-Extension', relative), 'utf8');
}

function readExtensionServiceWorkerGraph(): string {
  const swDir = resolve(repository, 'Known-Extension/src/sw');
  const names = readdirSync(swDir).filter((name) => name.endsWith('.ts')).sort();
  return [
    extensionSrc('src/service-worker.ts'),
    ...names.map((name) => readFileSync(resolve(swDir, name), 'utf8')),
  ].join('\n');
}

const runnerPath = resolve(repository, 'Known-Backend/scripts/phase3-multi-device-recovery-acceptance.mjs');
const runnerCorePath = resolve(repository, 'Known-Backend/scripts/phase3-multi-device-recovery-runner.mjs');
const retentionRehearsalPath = resolve(repository,
  'Known-Backend/scripts/phase3-sync-retention-rehearsal.mjs');
const diagnosticRunnerPath = resolve(repository, 'Known-Backend/scripts/phase3-multi-device-recovery-diagnostic.mjs');
const playwrightPath = resolve(repository, 'Known-Extension/e2e/mv3-multi-device-recovery.spec.ts');
const extensionManifestPath = resolve(repository, 'Known-Extension/manifest.base.json');
const containerPath = resolve(repository, 'Known-Backend/scripts/phase3-linux-managed-bookmarks-policy.mjs');
const containerProbePath = resolve(repository, 'Known-Backend/scripts/phase3-linux-managed-bookmarks-probe.mjs');
const readRunner = () => `${readFileSync(runnerPath, 'utf8')}\n${readFileSync(runnerCorePath, 'utf8')}`;

describe('P3-38 real extension acceptance static contract', () => {
  test('keeps one shared fail-closed marker scanner and sanitizes traces before retention', () => {
    const runner = readFileSync(runnerCorePath, 'utf8');
    const marker = 'P3-38 confidential shared-scanner-marker';
    expect(markerVariants([marker])).toContain(createHash('sha256').update(marker).digest('hex'));
    expect(containsPhase3Marker([marker], marker)).toBe(true);
    expect(runner).toContain("from './phase3-marker-scan.mjs'");
    expect(runner).toMatch(/sanitizeOwnedTraceArtifacts\(allMarkers, paths\.traces\)[\s\S]{0,200}copyEvidenceArtifacts/u);
    expect(runner).toMatch(/containsPhase3Marker\(markers, bytes\.toString\('utf8'\)\)/u);
    expect(runner.match(/capture\('python3', \['-m', 'zipfile', '-e'/gu)).toHaveLength(2);
    expect(runner).toMatch(/zipfile', '-e'[\s\S]*redactPhase3MarkerBytes[\s\S]*zipfile\.ZipFile[\s\S]*rename\(sanitized, traceFile\)/u);
  });

  test('is production-artifact, public-boundary, two-profile evidence', () => {
    const runner = readRunner();
    const spec = readFileSync(playwrightPath, 'utf8');
    expect(PHASE3_PRODUCTION_ARTIFACT_RELATIVE).toBe('dist/production');
    expect(PHASE3_ACCEPTANCE_FAIL_CLOSED.productionArtifact)
      .toBe('production artifact contains a service-worker evidence control surface');
    expect(runner).toMatch(/resolve\(extension, PHASE3_PRODUCTION_ARTIFACT_RELATIVE\)/u);
    expect(runner).toMatch(/PHASE3_ACCEPTANCE_FAIL_CLOSED\.productionArtifact/u);
    expect(spec).toMatch(/launchPersistentContext/u);
    expect(spec).toMatch(/let a = await launch\(profileA\); let b: BrowserContext;[\s\S]{0,200}b = await launch\(profileB\)/u);
    expect(spec).toMatch(/chrome\.bookmarks\.(?:create|update|move|remove)/u);
    expect(spec).toMatch(/indexedDB\.open/u);
    expect(spec).toMatch(/service_worker/u);
    expect(spec).toMatch(/same-field conflict|different-field merge/iu);
    expect(spec).toMatch(/stale recovery|purge watermark|retired replica/iu);
    expect(spec).toMatch(/ack-tombstone-purge[\s\S]*finalConvergenceState[\s\S]*uninstallExtension/u);
    expect(spec).not.toMatch(/finalConvergenceState[\s\S]{0,800}waitForTimeout\(5_000\)/u);
  });

  test('does not admit mocks, route fulfillment, SQL scenario setup, skips, or application imports', () => {
    const runner = readRunner();
    const spec = readFileSync(playwrightPath, 'utf8');
    const combined = `${runner}\n${spec}`;
    expect(spec).not.toMatch(/known\.sync-state\.evidence/u);
    expect(runner.match(/known\.sync-state\.evidence/gu)).toHaveLength(1);
    expect(combined).not.toMatch(/route\s*\([^\n]*fulfill|\.fulfill\s*\(/u);
    expect(combined).not.toMatch(/mock(?:ed)?\s+(?:fetch|chrome)|fake-indexeddb/iu);
    expect(combined).not.toMatch(/test\.(?:skip|fixme)|describe\.(?:skip|only)|test\.only/u);
    expect(PHASE3_READ_ONLY).toBe('READ ONLY');
    expect(runner).toMatch(/BEGIN \$\{PHASE3_READ_ONLY\}/u);
    expect(runner).toMatch(/\bselect\b/iu);
    for (const pattern of PHASE3_FORBIDDEN_RUNNER_PATTERNS) {
      expect(runner).not.toMatch(pattern);
    }
  });

  test('retires the temporary public protocol driver even when its scenario fails', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const helper = spec.slice(spec.indexOf('async function pushUnknownExtension'),
      spec.indexOf('async function publicCanonicalFacts'));
    expect(helper).toMatch(/sync-retire[\s\S]*try \{[\s\S]*finally \{[\s\S]*method: 'DELETE'/u);
    expect(helper).toMatch(/'Known-Sync-Session': sessionId[\s\S]*retireStatus !== 204/u);
    expect(spec).toMatch(/expect\(unknownPush\.retireStatus\)\.toBe\(204\)[\s\S]*expect\(unknownPush\.retired\)\.toBe\(true\)/u);
  });

  test('production build removes the service-worker evidence message surface', () => {
    const build = readFileSync(resolve(repository, 'Known-Extension/scripts/build.mjs'), 'utf8');
    const worker = extensionSrc('src/service-worker.ts');
    expect(build).toMatch(/__KNOWN_EXTENSION_EVIDENCE__.*environment === 'production'.*false/su);
    expect(worker).toMatch(/__KNOWN_EXTENSION_EVIDENCE__\s*&&\s*validSyncStateEvidenceRequest/u);
  });

  test('re-establishes optional bookmark capability after every real profile launch', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const readiness = spec.slice(spec.indexOf('async function ensureBootstrapPrerequisites'),
      spec.indexOf('async function bootstrapProductAccount'));
    expect(readiness).toMatch(/chrome\.permissions\.contains\(\{ permissions: \['bookmarks'\] \}\)/u);
    expect(readiness).toMatch(/grantOptionalBookmarks\(page, 'Allow bookmark access'/u);
    expect(readiness).toMatch(/chrome\.bookmarks\?\.create/u);
    expect(readiness).toMatch(/chrome\.bookmarks\?\.getTree/u);
    expect(readiness).toMatch(/chrome\.bookmarks\?\.update/u);
    expect(readiness).toMatch(/chrome\.bookmarks\?\.move/u);
    expect(readiness).toMatch(/chrome\.bookmarks\?\.remove/u);
    expect(readiness).toMatch(/bookmarks_permission_denied/u);
    expect(readiness).toMatch(/bookmarks_permission_timeout/u);
    expect(readiness).toMatch(/bookmarks_permission_check_failed/u);
    expect(readiness).toMatch(/bookmarks_api_unavailable/u);
    expect(readiness).toMatch(/sync_engine_not_ready/u);
    expect(spec).toMatch(/signInAndSelectRoot[\s\S]*ensureBootstrapPrerequisites\(page\.context\(\), page, name\)[\s\S]*ensureDeviceReady\(page\.context\(\), page, name\)/u);
    expect(spec).toMatch(/a = await launch\(profileA\); b = await launch\(profileB\);\s*pageA = await openOptions\(a\); pageB = await openOptions\(b\);\s*await ensureDeviceReady\(a, pageA,[\s\S]{0,100}await ensureDeviceReady\(b, pageB,/u);
    expect(spec).toMatch(/a = await launch\(profileA\); pageA = await openOptions\(a\);\s*try \{ await ensureDeviceReady\(a, pageA, 'Device A response-loss restart'\)/u);
    expect(spec).toMatch(/Device A boundary restart[\s\S]{0,220}Device B boundary restart/u);
    expect(spec).toMatch(/launch\(backupProfile, 'copied-backup'\)[\s\S]{0,180}ensureDeviceReady\(restored, restoredPage/u);
    expect(spec).toMatch(/launch\(retiredBackupProfile, 'copied-backup'\)[\s\S]{0,180}ensureBootstrapPrerequisites\(retiredBackup, retiredPage/u);
    expect(spec).toMatch(/async function refreshConnection[\s\S]*ensureDeviceReady\(page\.context\(\), page, 'Recovered profile'\)/u);
  });

  test('first login configures the bookmark root before waiting for engine bootstrap stability', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const roots = extensionSrc('src/sw/roots.ts');
    const signIn = spec.slice(spec.indexOf('async function signInAndSelectRoot'),
      spec.indexOf('async function refreshConnection'));
    expect(signIn).toMatch(/ensureBootstrapPrerequisites\(page\.context\(\), page, name\)[\s\S]*checkbox[\s\S]*\.check\(\)[\s\S]*locator\('#first-run-start'\)[\s\S]*toBeEnabled[\s\S]*await start\.click\(\)[\s\S]*toHaveAttribute\('data-first-run', ''[\s\S]*ensureDeviceReady\(page\.context\(\), page, name\)/u);
    expect(signIn).not.toMatch(/ensureEnginesStable[\s\S]*checkbox/u);
    const rootUpdate = roots.slice(roots.indexOf("if (message.kind === 'known.roots.update')"),
      roots.indexOf('return { ok: true, view: await loadRootView(scope) }'));
    expect(rootUpdate).toMatch(/commitBrowserRootAuthorityAndWake/u);
    const commitAndWake = roots.slice(roots.indexOf('async function commitBrowserRootAuthorityAndWake'),
      roots.indexOf('async function loadRootView'));
    expect(commitAndWake).toMatch(/await syncState\.configureBrowserRoots[\s\S]*scheduleSyncEngineWake\('manual'\)/u);
    expect(commitAndWake.indexOf("scheduleSyncEngineWake('manual')"))
      .toBeGreaterThan(commitAndWake.indexOf('await syncState.configureBrowserRoots'));
    expect(rootUpdate).toMatch(/try \{ await commitBrowserRootAuthorityAndWake[\s\S]*catch \{ return \{ ok: false, error: 'root_update_failed' \}; \}/u);
  });

  test('fresh-profile failures cannot enter the barrier and persisted-root restarts do not reselect', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const auth = extensionSrc('src/sw/auth.ts');
    const prerequisites = spec.slice(spec.indexOf('async function ensureBootstrapPrerequisites'),
      spec.indexOf('async function ensureDeviceReady'));
    expect(prerequisites).toMatch(/bookmarks_permission_(?:denied|timeout)|bookmarks_api_unavailable/u);
    expect(prerequisites).not.toMatch(/waitForEngineStability|ensureEnginesStable/u);
    const readiness = spec.slice(spec.indexOf('async function ensureDeviceReady'),
      spec.indexOf('async function ensureEnginesStable'));
    expect(readiness).toMatch(/ensureBootstrapPrerequisites[\s\S]*ensureEnginesStable/u);
    const restartRegion = spec.slice(spec.indexOf("'Device A restarted'"), spec.indexOf('// Local and remote create'));
    expect(restartRegion).not.toMatch(/(?:signInAndSelectRoot|root-select|name: \/Save\/u)/u);
    const login = auth.slice(auth.indexOf('const login = await auth.login(message)'),
      auth.indexOf('async function scheduleSyncEngineWakeIfRootConfigured'));
    expect(login).toMatch(/scheduleSyncEngineWakeIfRootConfigured/u);
    expect(login).not.toMatch(/scheduleSyncEngineWake\('manual'\)/u);
    const conditionalWake = auth.slice(auth.indexOf('async function scheduleSyncEngineWakeIfRootConfigured'));
    expect(conditionalWake).toMatch(/if \(await syncState\.getScope\(scope\)\) scheduleSyncEngineWake\('manual'\)/u);
    expect(conditionalWake).not.toMatch(/selectedRoots\.length/u);
  });

  test('fails closed before chrome.bookmarks writes when optional permission recovery fails', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const scenario = spec.slice(spec.indexOf("test('production MV3"), spec.indexOf('async function launch'));
    expect(scenario.indexOf("await signInAndSelectRoot(pageA, 'Device A'")).toBeGreaterThan(-1);
    expect(scenario.indexOf('chrome.bookmarks.create')).toBeGreaterThan(
      scenario.indexOf("await signInAndSelectRoot(pageA, 'Device A'"));
    const manifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8')) as {
      permissions?: string[]; optional_permissions?: string[] };
    expect(manifest.permissions).not.toContain('bookmarks');
    expect(manifest.permissions).not.toContain('tabs');
    // Tab capture adds its own optional permission; bookmark recovery must
    // still require an explicit grant rather than an install-time privilege.
    expect(manifest.optional_permissions).toEqual(['bookmarks', 'tabs']);
    expect(spec).not.toMatch(/indexedDB[^\n]*(?:put|add)\([^\n]*bookmark/iu);
    const readiness = spec.slice(spec.indexOf('async function ensureBootstrapPrerequisites'),
      spec.indexOf('async function bootstrapProductAccount'));
    expect(readiness).not.toMatch(/chrome\.permissions\.request/u);
    expect(readiness).toMatch(/Promise\.race/u);
    expect(readiness).toMatch(/throw new Error\('bookmarks_permission_(?:denied|timeout)'\)/u);
    expect(readiness).not.toMatch(/throw error/u);
  });

  test('60-second convergence polling is read-only and never rotates auth or Session authority', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const helper = (name: string, next: string) => spec.slice(spec.indexOf(`async function ${name}`), spec.indexOf(`async function ${next}`));
    const bookmarkPoll = helper('waitForBookmark', 'waitForConflict');
    const conflictPoll = helper('waitForConflict', 'queueDepth');
    const queuePoll = helper('drainQueue', 'syncEngineStatus');
    for (const pollingHelper of [bookmarkPoll, conflictPoll, queuePoll]) {
      expect(pollingHelper).not.toMatch(/refreshConnection|sendRefreshMessage|known\.auth\.refresh/u);
    }
    expect(bookmarkPoll).toMatch(/findBookmark/u);
    expect(conflictPoll).toMatch(/readStore/u);
    expect(queuePoll).toMatch(/queueDepth/u);
    expect(spec).toMatch(/async function readSyncEngineStatus[\s\S]{0,300}known\.sync\.engine\.status/u);
    expect(spec).toMatch(/authRequestsBeforeObservation[\s\S]*networkRequestCount\('\/oauth2\/token'\)\)\.toBe\(authRequestsBeforeObservation\)/u);
    expect(spec).toMatch(/sessionRequestsBeforeObservation[\s\S]*networkRequestCount\('\/colp\/v0\.1\/sync\/sessions'\)\)\.toBe\(sessionRequestsBeforeObservation\)/u);
    expect(spec).toMatch(/observationBaseline = await ensureEnginesStable\(\[pageA, pageB\]\)[\s\S]*authRequestsBeforeObservation = observationBaseline\.authRequests[\s\S]*sessionRequestsBeforeObservation = observationBaseline\.sessionRequests/u);
    const sixtySecondsOfObservation = Array.from({ length: 60 }, () =>
      `${bookmarkPoll}\n${conflictPoll}\n${queuePoll}`).join('\n');
    expect(sixtySecondsOfObservation.match(/known\.auth\.refresh|sendRefreshMessage|refreshConnection/gu) ?? []).toHaveLength(0);
    expect(spec).not.toMatch(/expect\.poll\(async \(\) => \{\s*await refreshConnection/u);
    const engine = extensionSrc('src/sw/engine.ts');
    const statusHandler = engine.slice(engine.indexOf('export async function handleSyncEngineRequest'));
    expect(statusHandler).toMatch(/publicSyncEngineState/u);
    expect(statusHandler).not.toMatch(/fetch\(|pushSessionAuthority|scheduleSyncEngineWake|save|transition|clear/u);
    const publicProjection = engine.slice(engine.indexOf('export async function publicSyncEngineState'),
      engine.indexOf('export async function handleSyncEngineRequest'));
    expect(publicProjection).toMatch(/cursorsConverged/u);
    expect(publicProjection).toMatch(/scopeKey/u);
    expect(publicProjection).not.toMatch(/lastPublishedCursor\s*:|lastAckedCursor\s*:|\bsessionId\b|accessToken|receipt|payload/u);
  });

  test('launch readiness waits for a pure-read engine and authority stability barrier before baselining traffic', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const barrier = readFileSync(resolve(repository, 'Known-Extension/e2e/engine-stability-barrier.ts'), 'utf8');
    const engine = extensionSrc('src/sw/engine.ts');
    const scope = extensionSrc('src/sw/scope.ts');
    const worker = `${engine}\n${scope}`;
    const readiness = spec.slice(spec.indexOf('async function ensureDeviceReady'),
      spec.indexOf('async function bootstrapProductAccount'));
    expect(readiness).toMatch(/waitForEngineStability/u);
    expect(readiness).toMatch(/networkRequestCounts/u);
    expect(barrier).toMatch(/requiredStableSamples/u);
    expect(barrier).toMatch(/quietWindowMilliseconds/u);
    expect(barrier).toMatch(/authRequests[\s\S]*sessionRequests/u);
    expect(barrier).not.toMatch(/known\.auth\.refresh|pushSessionAuthority|scheduleSyncEngineWake|forceRefresh/u);
    for (const fact of ['recoveryFrozen', 'authorityRefreshRequired', 'cooldownPending', 'engineWakeInFlight', 'authorityRefreshInFlight',
      'credentialReady', 'sessionReady', 'hasPendingWork']) expect(`${worker}\n${barrier}`).toContain(fact);
    const handler = engine.slice(engine.indexOf('export async function handleSyncEngineRequest'));
    expect(handler).not.toMatch(/fetch\(|scheduleSyncEngineWake|pushSessionAuthority|transition|save|clear/u);
    expect(engine).toMatch(/workCoordinator\.hasInFlight\('engine'\)/u);
    expect(engine).toMatch(/workCoordinator\.hasInFlight\('auth'\)/u);
    expect(engine).toMatch(/workCoordinator\.hasInFlight\('session'\)/u);
    const statusAuthority = scope.slice(scope.indexOf('export async function currentSyncStatusAuthority'),
      scope.indexOf('export async function pushSessionAuthority'));
    expect(statusAuthority).not.toMatch(/fetch\(|scheduleSyncEngineWake|pushSessionAuthority|transition|save|clear/u);
    expect(spec.indexOf('const authRequestsBeforeObservation = observationBaseline.authRequests'))
      .toBeGreaterThan(spec.indexOf("await ensureDeviceReady(b, pageB, 'Device B restarted')"));
  });

  test('auth refresh remains an explicit, cooldown-respecting recovery boundary', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const worker = readExtensionServiceWorkerGraph();
    expect(spec).toMatch(/async function refreshConnection[\s\S]*known\.auth\.refresh/u);
    expect(spec).toMatch(/async function refreshAfterAuthorityInvalidation[\s\S]*refreshConnection/u);
    expect(spec).toMatch(/refreshCooldownUntil/u);
    expect(worker).toMatch(/sessionRetryNotBefore/u);
    expect(worker).toMatch(/shouldForceSessionRefresh/u);
  });

  test('package exposes separate diagnostic and fail-closed evidence commands without duplicate builds', () => {
    const extensionPackage = JSON.parse(readFileSync(resolve(repository, 'Known-Extension/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const command = extensionPackage.scripts['evidence:phase3-multi-device-recovery'];
    const diagnostic = extensionPackage.scripts['diagnose:phase3-multi-device-recovery'];
    const withPostgres = readFileSync(resolve(repository, 'Known-Backend/scripts/with-postgres.mjs'), 'utf8');
    expect(command).toBeTruthy();
    expect(command).toMatch(/phase3-multi-device-recovery-acceptance\.mjs/u);
    expect(command).toMatch(/with-postgres\.mjs --tls --isolated-owner --/u);
    expect(command).not.toMatch(/npm run build|verify-release-artifact/u);
    expect(diagnostic).toMatch(/with-postgres\.mjs --tls --isolated-owner --/u);
    expect(diagnostic).toMatch(/phase3-multi-device-recovery-diagnostic\.mjs/u);
    expect(withPostgres).toMatch(/isolatedOwner[\s\S]*TESTCONTAINERS_RYUK_DISABLED = 'true'[\s\S]*import\('@testcontainers\/postgresql'\)/u);
    expect(withPostgres).toMatch(/if \(!isolatedOwner\) \{[\s\S]*configuredTestDatabaseUrl\(\)/u);
    expect(withPostgres).toMatch(/Testcontainers started but connection probe failed[\s\S]*finally\s*\{[\s\S]*rm\(tlsRoot/u);
    expect(command).not.toMatch(/\|\||skip|--passWithNoTests/iu);
  });

  test('local OIDC proves the extension PKCE verifier instead of accepting an unbound code', () => {
    const verifier = 'p3-38-verifier-with-enough-entropy-0123456789';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPhase3Pkce(verifier, challenge)).toBe(true);
    expect(verifyPhase3Pkce(`${verifier}-wrong`, challenge)).toBe(false);
    expect(verifyPhase3Pkce('', challenge)).toBe(false);
  });

  test('focused runner is self-contained and accepts only optional seed/output configuration', () => {
    const runner = readRunner();
    const source = ts.createSourceFile(runnerPath, runner, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const environmentReads = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(source) === 'process'
          && node.expression.name.text === 'env' && ts.isStringLiteral(node.argumentExpression)) {
        environmentReads.add(node.argumentExpression.text);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(source) === 'process' && node.expression.name.text === 'env') {
        environmentReads.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect([...environmentReads].sort()).toEqual([...PHASE3_ALLOWED_ENV].sort());
    expect(PHASE3_EVIDENCE_OUTPUT_RELATIVE)
      .toBe('test-results/evidence/phase3-multi-device-recovery.json');
    expect(PHASE3_WITH_POSTGRES_SCRIPT).toBe('scripts/with-postgres.mjs');
    expect(runner).toMatch(/PHASE3_EVIDENCE_OUTPUT_RELATIVE/u);
    expect(PHASE3_ACCEPTANCE_FAIL_CLOSED.databaseUrlRequired)
      .toContain(PHASE3_WITH_POSTGRES_SCRIPT);
    for (const pattern of PHASE3_FORBIDDEN_RUNNER_PATTERNS) {
      expect(runner).not.toMatch(pattern);
    }
    expect(`${runner}\n${readFileSync(playwrightPath, 'utf8')}`).not.toMatch(
      /KNOWN_P3_38_(?:CONTROL|OBSERVATION|INGRESS|EXTERNAL|MANAGED_POLICY|CHROMIUM_ARGS|EXTENSION_LOG|PROBLEM_LOG)/u,
    );
  });

  test('keeps diagnostic controls outside the unfilterable acceptance entry point', () => {
    const acceptance = readFileSync(runnerPath, 'utf8');
    const diagnostic = readFileSync(diagnosticRunnerPath, 'utf8');
    const core = readFileSync(runnerCorePath, 'utf8');
    expect(PHASE3_ACCEPTANCE_MODE).toBe('acceptance');
    expect(PHASE3_ACCEPTANCE_STAGE).toBe('full');
    expect(PHASE3_DIAGNOSTIC_MODE).toBe('diagnostic');
    expect(PHASE3_ACCEPTANCE_RECOVERY_WAIT_MS).toBe(601_000);
    expect(PHASE3_DIAGNOSTIC_FAST_RECOVERY_WAIT_MS).toBe(121_000);
    expect(PHASE3_DIAGNOSTIC_FAST_LEASE_SECONDS).toBe('120');
    expect(PHASE3_ACCEPTANCE_LEASE_SECONDS).toBe('600');
    expect([...PHASE3_DIAGNOSTIC_FAST_STAGES]).toEqual(['recovery-fast', PHASE3_FULL_FAST_STAGE]);
    expect(PHASE3_DIAGNOSTIC_FORMAT).toBe('known.phase3.multi-device-recovery.diagnostic.v1');
    expect(acceptance).toMatch(/runPhase3MultiDeviceRecovery\(\{ mode: PHASE3_ACCEPTANCE_MODE, stage: PHASE3_ACCEPTANCE_STAGE \}\)/u);
    expect(acceptance).not.toMatch(/process\.(?:argv|env)|diagnostic|--stage/u);
    expect(diagnostic).toMatch(/process\.argv/u);
    expect(diagnostic).toMatch(/<stage>/u);
    expect(diagnostic).toMatch(/PHASE3_MULTI_DEVICE_DIAGNOSTIC_STAGES/u);
    expect(diagnostic).toMatch(/PHASE3_DIAGNOSTIC_MODE/u);
    expect(core).toMatch(/mode === PHASE3_ACCEPTANCE_MODE && requestedStage !== PHASE3_ACCEPTANCE_STAGE/u);
    expect(core).toMatch(/mode: PHASE3_ACCEPTANCE_MODE, stage: PHASE3_ACCEPTANCE_STAGE, recoveryWaitMs: PHASE3_ACCEPTANCE_RECOVERY_WAIT_MS/u);
    expect(core).toContain('PHASE3_DIAGNOSTIC_FORMAT');
    expect(core).toMatch(/accepted:\s*false/u);
    expect(core).toContain('PHASE3_DIAGNOSTIC_FAST_STAGES.includes(requestedStage)');
    expect(core).toContain('PHASE3_DIAGNOSTIC_FAST_RECOVERY_WAIT_MS');
    expect(core).toContain('const acceleratedRecovery = modeValue === PHASE3_DIAGNOSTIC_MODE');
    expect(core).toContain(
      'const leaseSeconds = acceleratedRecovery ? PHASE3_DIAGNOSTIC_FAST_LEASE_SECONDS : PHASE3_ACCEPTANCE_LEASE_SECONDS',
    );
  });

  test('retains only marker-scanned failure artifacts and emits a non-accepting capsule', () => {
    const runner = readFileSync(runnerCorePath, 'utf8');
    expect(runner).toContain('writeFailureCapsule(error)');
    expect(runner).toContain('retainSafeArtifacts');
    expect(runner).toContain('scanOwnedArtifacts');
    expect(PHASE3_FAILURE_FORMAT).toBe('known.phase3.multi-device-recovery.failure.v1');
    expect(runner).toContain('PHASE3_FAILURE_FORMAT');
    expect(runner).toMatch(/accepted:\s*false/u);
    expect(runner).toContain('failureDigest: sha(sanitized)');
    expect(runner).toContain('accepted: false, mode, requestedStage, scenarioSeed: seed');
    expect(runner).toContain('lastCheckpoint');
    expect(runner).toContain('runnerPhase');
    expect(runner).toContain('failureClass');
    expect(runner).not.toMatch(/failureMessage:|errorMessage:|rawError:/u);
    expect(runner).toMatch(/stage-timeline/u);
  });

  test('owns TLS, OIDC, production bootstrap, browser artifacts, and cleanup inside the repository runner', () => {
    const runner = readRunner();
    const runtime = readFileSync(resolve(repository,
      'Known-Backend/scripts/phase3-multi-device-recovery-runtime.mjs'), 'utf8');
    const combined = `${runner}\n${runtime}`;
    expect(PHASE3_REQUIRED_COMMAND_TOKENS).toEqual([
      'createSecureIngress', 'createOidcIssuer', 'generateKeyPair', 'SignJWT',
      'dist/src/bootstrap/api.js', PHASE3_READ_ONLY, 'selectManagedPolicyProvider', 'trace.zip',
      'browser-console.jsonl', 'browser-network.jsonl', 'browser-problems.jsonl',
    ]);
    for (const token of PHASE3_REQUIRED_COMMAND_TOKENS) {
      if (token === PHASE3_READ_ONLY) {
        expect(runner).toMatch(/BEGIN \$\{PHASE3_READ_ONLY\}/u);
        continue;
      }
      expect(combined).toContain(token);
    }
    expect(runner).toMatch(/--config/u);
    for (const cursor of PHASE3_CURSOR_FAMILIES) {
      expect(runner).toContain(`${cursor}_CURSOR_ACTIVE_KEY_ID`);
      expect(runner).toContain(`${cursor}_CURSOR_ACTIVE_SECRET`);
    }
    expect(PHASE3_PRODUCT_CURSOR_FAMILIES).toEqual([
      'EDITOR', 'OWNED_COLLECTIONS', 'LINK_HEALTH', 'CLASSIFY_INBOX', 'COLLECTION_VERSIONS',
    ]);
    for (const cursor of PHASE3_PRODUCT_CURSOR_FAMILIES) {
      expect(runner).toContain(`PRODUCT_${cursor}_CURSOR_HMAC_KEY`);
      expect(runner).toContain(`PRODUCT_${cursor}_CURSOR_KEY_ID`);
    }
    expect(runner).toContain('finally');
    expect(runner).toMatch(/managedPolicySelection\?\.policy\?\.restore\(\)/u);
    expect(runner).toMatch(/await rm\(work/u);
    expect(runner).toContain('retainedArtifactsOwned');
    expect(runner).toContain('evidenceWritten');
    expect(runner).toContain('rm(retainedArtifacts');
  });

  test('production runtime environment satisfies the complete application config contract', () => {
    const environment = createPhase3BackendEnvironment({
      url: 'postgresql://known:known@127.0.0.1:5432/known',
      port: 3310,
      origin: 'https://p3-38.known.invalid',
      extensionId: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      seedValue: 'phase3-production-config-contract',
      modeValue: PHASE3_ACCEPTANCE_MODE,
      requestedStageValue: PHASE3_ACCEPTANCE_STAGE,
    });
    expect(environment.SYNC_TOMBSTONE_RETENTION_SECONDS).toBe('2592000');
    expect(() => loadConfig(environment)).not.toThrow();
  });

  test('rehearses the 30-day retention boundary through the production purge coordinator', () => {
    const runner = readFileSync(runnerCorePath, 'utf8');
    const ingress = readFileSync(resolve(repository,
      'Known-Backend/scripts/phase3-multi-device-recovery-runtime.mjs'), 'utf8');
    const rehearsal = readFileSync(retentionRehearsalPath, 'utf8');
    const browser = readFileSync(playwrightPath, 'utf8');
    expect(rehearsal).toContain("import('../dist/src/infrastructure/sync/index.js')");
    expect(rehearsal).toContain('PostgresSyncTombstonePurgeCoordinator');
    expect(rehearsal).toMatch(/runBatch\(\{ now:/u);
    expect(runner).toContain('advancePhase3SyncRetention(databaseUrl)');
    expect(runner).toContain('update auth_users set "emailVerified"=true');
    expect(runner).not.toMatch(/insert into auth_sessions/iu);
    expect(ingress).toContain("'/__runner/sync-retention-advance'");
    expect(ingress).toContain('secureEqual(supplied, retentionAdvanceToken)');
    expect(browser).toContain('/__runner/sync-retention-advance');
    expect(browser).toContain('production-ack-and-explicit-operations-clock');
    expect(browser).toContain("retentionDirect.hostname = '127.0.0.1'");
    expect(browser).toContain('mirrorDirectProductCookies');
    expect(browser).toContain('/api/v1/auth/sign-out');
    expect(browser).toContain('clearCookies({ name: SESSION_COOKIE_NAME })');
    expect(browser).toMatch(/const fixtureRootTitle = await page\.evaluate[\s\S]*chrome\.bookmarks\.getTree\(\)[\s\S]*node\.folderType === 'bookmarks-bar'[\s\S]*if \(!browserRoot\) throw new Error\('browser_root_missing'\)[\s\S]*return browserRoot\.title/u);
    expect(browser).toContain("getByRole('checkbox', { name: fixtureRootTitle, exact: true })");
    expect(browser).not.toContain("locator('input[type=\"checkbox\"]:not(:disabled)').first()");
    expect(browser).toContain("readStore(page, 'native_mappings')");
    expect(browser).toContain('selected_root_mapping_missing');
    expect(browser).toMatch(/waitForRecoveryComplete\(pageA[\s\S]{0,180}showOptionsPane\(pageA, 'account'\)/u);
    expect(browser).not.toContain("tree[0]!.children![0]!.id");
    expect(browser).toMatch(/resolveOpenConflict\(\[pageA, pageB\]\);[\s\S]{0,180}ensureEnginesStable\(\[pageA, pageB\]\)/u);
    expect(browser).toContain("locator('#login-panel')).toBeVisible({ timeout: 120_000 })");
    expect(runner).toContain("'scripts/with-xvfb.mjs'");
    expect(runner).toContain('assertSecureSyncIngress(origin, ingress.certificate, config.extensionId)');
    expect(runner).toContain("response.statusCode === 422 && code === 'invalid_document'");
    expect(runner).toContain("authFacts: resolve(work, 'auth-session-facts.json')");
    expect(browser).toContain("kind: 'credential-metadata'");
    expect(browser).not.toMatch(/request\.post\(`\$\{(?:runtime\.)?origin\}/u);
  });

  test('records the real browser version rather than a navigator user-agent string', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    expect(spec).toMatch(/const browserVersion = b\.browser\(\)\?\.version\(\)/u);
    expect(spec).not.toMatch(/const browserVersion = await pageB\.evaluate\(\(\) => navigator\.userAgent\)/u);
  });

  test('uses a fixed matching Playwright image and a real isolated Linux managed-policy profile', () => {
    const provider = readFileSync(containerPath, 'utf8');
    expect(provider).toContain("'--user', `${hostUid}:${hostGid}`");
    expect(provider).toContain("'--env', 'HOME=/tmp'");
    expect(provider).toContain("commandChecked('python3', ['-m', 'zipfile', '-e', file, extracted])");
    const probe = readFileSync(containerProbePath, 'utf8');
    expect(probe).toContain("button.textContent = 'Grant bookmark access'");
    expect(probe).toContain('for (let attempt = 0; attempt < 3; attempt += 1)');
    expect(probe).toContain('for keysym, pressed in events:');
    expect(provider).toContain('mcr.microsoft.com/playwright:v1.61.1-noble');
    expect(provider).toMatch(/v1\.61\.1-noble@\$\{PLAYWRIGHT_POLICY_IMAGE_DIGEST\}/u);
    expect(provider).not.toMatch(/:latest\b/u);
    expect(provider).toMatch(/\/etc\/opt\/chrome_for_testing\/policies\/managed/u);
    expect(provider).toMatch(/extensions:\s*\{\s*\[extensionId\]:\s*\{\s*identityDisabled:\s*false,\s*serverOrigin/u);
    expect(provider).not.toMatch(/\[extensionId\]:\s*\{\s*policy:/u);
    expect(provider).toMatch(/docker[\s\S]*image[\s\S]*inspect/u);
    expect(provider).toMatch(/localImage[\s\S]*code !== 0[\s\S]*dockerChecked\(\['pull'/u);
    expect(provider).toMatch(/finally[\s\S]*(?:rm|remove)[\s\S]*container/iu);
    expect(provider).toMatch(/finally\s*\{\s*try\s*\{[\s\S]*docker\(\['rm'[\s\S]*finally\s*\{[\s\S]*rm\(profileRoot/u);
    expect(provider).toMatch(/--network[\s\S]*none/u);
    expect(provider).toMatch(/Xvfb :99[\s\S]*X11-unix\/X99[\s\S]*exit 70/u);
    expect(provider).toMatch(/trap 'kill \\"\$xvfb_pid\\"[\s\S]*wait \\"\$xvfb_pid\\"/u);
    expect(provider).toMatch(/timeout --signal=TERM --kill-after=15s 120s[\s\S]*node \/run\/known\/probe\.mjs/u);
    expect(provider).toMatch(/container failed with exit code \$\{outcome\.code\}/u);
    expect(probe).toMatch(/launchPersistentContext/u);
    expect(probe).toMatch(/headless:\s*false/u);
    expect(probe).toMatch(/serviceWorkers\(\)/u);
    expect(probe).toMatch(/page\.click[\s\S]*waitForTimeout\(500\)[\s\S]*allowLinuxPermission\(attempt\)/u);
    expect(probe).toMatch(/libXtst\.so\.6[\s\S]*XTestFakeKeyEvent/u);
    expect(probe).toMatch(/0xff09[\s\S]*0xff0d/u);
    expect(probe).toMatch(/progress\('launch-entered'\)[\s\S]*progress\('result-written'\)/u);
    expect(probe).toMatch(/chrome\.storage\.managed\.get/u);
    expect(probe).toMatch(/chrome\.bookmarks\.getTree/u);
    expect(probe).toMatch(/chrome\.bookmarks\.update/u);
    expect(`${provider}\n${probe}`).not.toMatch(/route\s*\([^\n]*fulfill|\.fulfill\s*\(|\bsupported:\s*true|\bskip(?:ped)?:/iu);
    expect(`${provider}\n${probe}`).not.toMatch(/src[\/](?:application|modules|infrastructure)[\/]/u);
    expect(`${provider}\n${probe}`).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from)?\s*(?:sync_|nodes|collections|operations)/iu);
  });

  test('scenario and boundary evidence comes from actions plus multi-surface observations', () => {
    const spec = readFileSync(playwrightPath, 'utf8');
    const redaction = readFileSync(
      resolve(repository, 'Known-Extension/e2e/mv3-multi-device-recovery-redaction.ts'),
      'utf8',
    );
    const evidence = `${spec}\n${redaction}`;
    expect(spec).not.toMatch(/\bcompleted\b|completed:\s*true|preflight:\s*true/iu);
    expect(spec).toMatch(/actionEvidence/u);
    expect(spec).toMatch(/observationEvidence/u);
    expect(spec).toMatch(/browser-tree|public-http|indexeddb/iu);
    expect(spec).toMatch(/triggerEvidence/u);
    expect(spec).toMatch(/recoveryEvidence/u);
    expect(spec).toMatch(/assertPublicCanonicalFinalState\(collectionId, pageB\)/u);
    expect(spec).toMatch(/P3-38 folder[\s\S]*P3-38 unknown extension[\s\S]*P3-38 different-field merge/u);
    expect(spec).toMatch(/containsFieldValue\(authority\.conflicts, 'status', 'open'\)/u);
    expect(spec).toMatch(/kind: 'snapshot_problem'/u);
    expect(spec).toMatch(/kind: 'pull_problem'/u);
    expect(spec).toMatch(/bodyBytes/u);
    expect(spec).toMatch(/bodyDigest/u);
    expect(spec).toMatch(/authorityDigest/u);
    expect(spec).toMatch(/authoritySource/u);
    expect(spec).toMatch(/session_collection_replica|session_credential|session_missing/u);
    expect(spec).toMatch(/remoteCollectionDigest/u);
    expect(spec).toMatch(/selectedCollectionDigest/u);
    expect(spec).toMatch(/expect\(identityA\.remoteCollectionDigest\)\.toBe\(identityB\.remoteCollectionDigest\)/u);
    expect(spec).toMatch(/expect\(restartedIdentityA\)\.toEqual\(identityA\)/u);
    expect(evidence).toMatch(/credentialSubject/u);
    expect(evidence).toMatch(/credentialId/u);
    expect(evidence).toMatch(/headerSession/u);
    expect(spec).not.toMatch(/kind: 'snapshot_problem'[\s\S]{0,300}\b(?:sessionId|cursor):\s*(?!secretMetadata)/u);
    expect(spec).not.toMatch(/authority:\s*\{[^}]*\b(?:authorization|accessToken|token|rawCursor)\b/iu);
    expect(spec).toMatch(/async function syncEngineStatus[\s\S]*cursorsConverged/u);
    expect(spec).not.toMatch(/receipts[AB]:\s*await readStore\([^)]*,\s*'receipts'\)/u);
    expect(spec).not.toMatch(/operationId:\s*row\.operationId|targetId:\s*row\.payload\?\.targetId|value:\s*row\.payload\?\.payload\?\.value/u);
    expect(spec).not.toMatch(/browserLogs\.push\([^\n]*message\.text\(\)/u);
    expect(spec).not.toMatch(/nodeId:\s*event\.effect\?\.node\?\.id|managedWriteBody/u);
  });
});
