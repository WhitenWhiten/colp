import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readApiCompositionSource } from '../../support/api-composition-source.js';
import {
  PHASE3_BROWSER_DIAGNOSTIC_FORMAT,
  PHASE3_EVIDENCE_FORMAT,
  PHASE3_FAIL_CLOSED_PREFIX,
  PHASE3_FULL_FAST_STAGE,
  PHASE3_SYNC_PULL_CURSOR_TTL_MS,
  PHASE3_SYNC_PULL_RECOMMENDED_AFTER_SECONDS,
  PHASE3_SYNC_PULL_RECOVERY_PROOF_RETENTION_MS,
} from '../../../scripts/phase3-multi-device-recovery-bindings.mjs';

const repository = resolve(import.meta.dirname, '../../../..');

function readExtensionServiceWorkerGraph(): string {
  const swDir = resolve(repository, 'Known-Extension/src/sw');
  const names = readdirSync(swDir).filter((name) => name.endsWith('.ts')).sort();
  return [
    readFileSync(resolve(repository, 'Known-Extension/src/service-worker.ts'), 'utf8'),
    ...names.map((name) => readFileSync(resolve(swDir, name), 'utf8')),
  ].join('\n');
}

const runnerPath = resolve(repository, 'Known-Backend/scripts/phase3-multi-device-recovery-acceptance.mjs');
const runnerCorePath = resolve(repository, 'Known-Backend/scripts/phase3-multi-device-recovery-runner.mjs');
const playwrightPath = resolve(repository, 'Known-Extension/e2e/mv3-multi-device-recovery.spec.ts');
const readRunner = () => `${readFileSync(runnerPath, 'utf8')}\n${readFileSync(runnerCorePath, 'utf8')}`;

describe('P3-38 real extension acceptance static contract (profile/replica)', () => {
  test('takes a browser-consistent profile snapshot without weakening recovery coverage', () => {
    const runner = readRunner();
    const spec = readFileSync(playwrightPath, 'utf8');
    const profile = readFileSync(resolve(repository,
      'Known-Extension/e2e/mv3-multi-device-recovery-profile.ts'), 'utf8');
    expect(spec).toContain("import { copyProfileSnapshot, probeRetiredReplicaSession, remoteCollectionIdentity } from './mv3-multi-device-recovery-profile.js'");
    const sourceBinding = spec.indexOf('const sourceBackupBinding = await backupBindingFact(pageA)');
    const closeSource = spec.indexOf('await a.close()', sourceBinding);
    const copyRecovery = spec.indexOf('await copyProfileSnapshot(profileA, backupProfile)', closeSource);
    const copyRetired = spec.indexOf('await copyProfileSnapshot(profileA, retiredBackupProfile)', copyRecovery);
    const relaunchSource = spec.indexOf('a = await launch(profileA)', copyRetired);
    const uninstall = spec.indexOf('await uninstallExtension(a, pageA)', relaunchSource);
    expect(sourceBinding).toBeGreaterThan(-1);
    expect(closeSource).toBeGreaterThan(sourceBinding);
    expect(copyRecovery).toBeGreaterThan(closeSource);
    expect(copyRetired).toBeGreaterThan(copyRecovery);
    expect(relaunchSource).toBeGreaterThan(copyRetired);
    expect(uninstall).toBeGreaterThan(relaunchSource);
    expect(profile).toMatch(/async function copyProfileSnapshot[\s\S]*Date\.now\(\) \+ 30_000[\s\S]*rm\(destination, \{ recursive: true, force: true \}\)[\s\S]*cp\(source, destination, \{ recursive: true, force: false \}\)[\s\S]*\['EBUSY', 'EPERM', 'EACCES'\]/u);
    expect(spec).toMatch(/expect\(backupBinding\)\.toEqual\(sourceBackupBinding\)[\s\S]*expect\(recoveredBinding\)\.toEqual\(sourceBackupBinding\)/u);
    expect(spec).toMatch(/async function backupBindingFact[\s\S]*bindingDigest:\s*sha\(JSON\.stringify\(binding\)\)[\s\S]*identityDigest[\s\S]*generation/u);
    expect(spec).toMatch(/freshBinding[\s\S]*not\.toBe\(sourceBackupBinding\.identityDigest\)[\s\S]*generation\)\.toBe\(1\)/u);
    expect(spec).toMatch(/name: 'Sign out'[\s\S]*#login-panel[\s\S]*status: 410, code: 'replica_retired'/u);
    expect(spec).toMatch(/expect\(retiredBackupBinding\)\.toEqual\(sourceBackupBinding\)[\s\S]*probeRetiredReplicaSession[\s\S]*expect\(await backupBindingFact\(retiredPage\)\)\.toEqual\(sourceBackupBinding\)/u);
    expect(profile).toMatch(/async function probeRetiredReplicaSession[\s\S]*syncSessions[\s\S]*method: 'POST'/u);
    expect(profile).toMatch(/finally \{[\s\S]*rm\(destination, \{ recursive: true, force: true \}\)\.catch/u);

    const scenarioDeclaration = spec.match(/const scenarioNames = \[([\s\S]*?)\] as const/u)?.[1] ?? '';
    const requiredScenarios = scenarioDeclaration.match(/'[^']+'/gu) ?? [];
    expect(requiredScenarios).toHaveLength(20);
    expect(spec).toContain('await pageB.waitForTimeout(runtime.recoveryWaitMs)');
    expect(spec).toMatch(/runtime\.mode === 'acceptance'[\s\S]*runtime\.recoveryWaitMs\)\.toBe\(601_000\)/u);
    expect(spec).toMatch(/clientCheckpointOrdinals[\s\S]*durableFacts\(pageA, profileA, checkpointOrdinals\[0\]![\s\S]*managedBookmarkTreeDigest\(page\)/u);
    expect(spec).toMatch(/runtime\.mode === 'diagnostic'[\s\S]*browser-diagnostic\.v1[\s\S]*observations: fullResult/u);
    expect(PHASE3_FULL_FAST_STAGE).toBe('full-fast');
    expect(PHASE3_SYNC_PULL_CURSOR_TTL_MS).toBe('600000');
    expect(PHASE3_SYNC_PULL_RECOMMENDED_AFTER_SECONDS).toBe('4');
    expect(PHASE3_SYNC_PULL_RECOVERY_PROOF_RETENTION_MS).toBe('86400000');
    expect(PHASE3_BROWSER_DIAGNOSTIC_FORMAT)
      .toBe('known.phase3.multi-device-recovery.browser-diagnostic.v1');
    expect(PHASE3_EVIDENCE_FORMAT).toBe('known.phase3.multi-device-recovery.v1');
    expect(PHASE3_FAIL_CLOSED_PREFIX).toBe('FAIL-CLOSED');
    expect(runner).toContain('requestedStage === PHASE3_FULL_FAST_STAGE');
    expect(runner).toContain('requireBrowserResult(completed, true)');
    expect(runner).toContain('runLinuxManagedBookmarksPolicy');
    expect(runner).toContain('requireBrowserResult(completed, false)');
    expect(runner).toContain('clients[0].treeDigest !== value.clients[1].treeDigest');
    expect(runner).toContain('checkpointOrdinal');
    expect(runner).toContain('cursorDigest === value.clients[1].cursorDigest');
    expect(runner).toMatch(/SYNC_PULL_CURSOR_TTL_MS: PHASE3_SYNC_PULL_CURSOR_TTL_MS/u);
    expect(runner).toMatch(/SYNC_PULL_RECOMMENDED_AFTER_SECONDS: PHASE3_SYNC_PULL_RECOMMENDED_AFTER_SECONDS/u);
    expect(runner).toMatch(/SYNC_PULL_RECOVERY_PROOF_RETENTION_MS: PHASE3_SYNC_PULL_RECOVERY_PROOF_RETENTION_MS/u);
    expect(86_400_000).toBeGreaterThan(600_000 + 900_000);
    expect(spec).toContain('authorityRefreshRequired === false');
    expect(spec).toMatch(/const crashSequence = seededCrashSequence\(seed\);\s*expect\(crashSequence\)\.toHaveLength\(11\)/u);
    const boundaryDeclaration = spec.match(/const points = \[([\s\S]*?)\];/u)?.[1] ?? '';
    expect(boundaryDeclaration.match(/'[^']+'/gu)).toHaveLength(11);
    expect(spec).toMatch(/Extensions\.loadUnpacked/u);
    expect(spec).toMatch(/Extensions\.uninstall/u);
    expect(spec).toMatch(/publicCanonicalFacts/u);
  });

  test('production logout retires the replica on the server and cannot report a local-only retirement', () => {
    const worker = readExtensionServiceWorkerGraph();
    const controller = readFileSync(resolve(repository, 'Known-Extension/src/auth-controller.ts'), 'utf8');
    expect(worker).toMatch(/message\.kind === 'known\.auth\.refresh'[\s\S]{0,160}pushSessionAuthority\(true\)/u);
    // 600-char window: the logout handler may wait for an in-flight sync
    // engine cycle to settle before the server-side auth.logout() call.
    expect(worker).toMatch(/message\.kind === 'known\.auth\.logout'[\s\S]{0,600}auth\.logout\(\)/u);
    expect(worker).toMatch(/message\.kind === 'known\.auth\.logout'[\s\S]*finally[\s\S]*cleanupAccount/u);
    expect(worker).toMatch(/const observedSessionId = forceRefresh[\s\S]*shouldForceSessionRefresh\(forceRefresh, observedSessionId, session\?\.sessionId \?\? null\)[\s\S]*if \(effectiveForce \|\| before\?\.accessToken/u);
    expect(controller).toMatch(/credential\s*&&\s*session\s*&&\s*dependencies\.retire\)[\s\S]{0,180}dependencies\.retire\([^)]*remoteAbort\.signal/u);
    expect(controller).toMatch(/Remote retirement\/sign-out are deliberately best-effort/u);
  });

  test('fresh production installation can register only an unknown generation-one Replica', () => {
    const admission = readFileSync(resolve(repository,
      'Known-Backend/src/infrastructure/sync/sync-session-http-postgres.ts'), 'utf8');
    const runtime = readFileSync(resolve(repository,
      'Known-Backend/src/bootstrap/sync-session-runtime.ts'), 'utf8');
    const composition = readApiCompositionSource(resolve(repository, 'Known-Backend'));
    expect(admission).toMatch(/registerUnknownGenerationOneReplica/u);
    expect(admission).toMatch(/binding\?\.generation === '1'/u);
    expect(admission).toMatch(/ReplicaIdAlreadyReservedError/u);
    expect(admission).toMatch(/pg_advisory_xact_lock/u);
    expect(admission).toMatch(/createUnitOfWork/u);
    expect(admission).toMatch(/issueInTransaction/u);
    expect(runtime).toMatch(/registerUnknownGenerationOneReplica: true/u);
    expect(composition).toMatch(/createSyncSessionRuntime/u);
  });
});
