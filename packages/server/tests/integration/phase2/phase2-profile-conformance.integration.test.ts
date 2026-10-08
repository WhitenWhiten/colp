import assert from 'node:assert/strict';
import {
  bundledConformanceEvidence,
  createDeploymentConformancePlan,
  runDeploymentConformanceProbes,
  type DeploymentConformanceCommand,
  type VerifiedDeploymentConformanceEvidence,
} from '@know-n/colp/conformance';
import { afterAll, beforeAll, test } from 'vitest';
import { createPhase2AcceptanceDeployment } from '../../../scripts/phase2-publication-acceptance-adapter.js';
import { runPhase2PublicationAcceptance } from '../../../scripts/acceptance/phase2-publication-acceptance.js';
import { POSTGRES_PUBLICATION_ENTRY_TARGET } from '../../../scripts/evidence/postgres-publication-entry.js';
import {
  createPhase2ReleaseRequirementMapping,
  evaluatePhase2ReleaseGate,
} from '../../../scripts/evidence/phase2-release-gate.js';
import {
  claimPhase2PublicationProfiles,
  PHASE2_DEPLOYMENT_CONFORMANCE_PLAN,
  PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE,
  verifyPhase2PublicationEvidence,
} from '../../../src/modules/publication/index.js';
import {
  describeWithPostgres,
  requireTestDatabaseUrl,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('Phase 2 Profile conformance real deployment', () => {
  let deployment: Awaited<ReturnType<typeof createPhase2AcceptanceDeployment>>;
  let observed: DeploymentConformanceCommand[];
  let restartCount: number;
  let deploymentEvidence: VerifiedDeploymentConformanceEvidence;

  beforeAll(async () => {
    deployment = await createPhase2AcceptanceDeployment({
      env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
    });
    observed = [];
    restartCount = 0;
    const target = deployment.profileConformanceTarget;
    deploymentEvidence = await runDeploymentConformanceProbes({
      async execute(command) {
        observed.push(structuredClone(command));
        return target.execute(command);
      },
      async restart() {
        restartCount += 1;
        await target.restart();
      },
      async readDiagnostics() {
        return target.readDiagnostics();
      },
    }, PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE);
  }, 900_000);

  afterAll(async () => {
    await deployment?.close();
  });

  test('runs the exact public planner scope without optional deployment roles', () => {
    const plan = createDeploymentConformancePlan(PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE);
    assert.deepEqual(plan, PHASE2_DEPLOYMENT_CONFORMANCE_PLAN);
    assert.deepEqual(plan.profiles, ['core', 'publication']);
    assert.deepEqual(plan.capabilities, ['core-authoritative-writes']);
    assert.deepEqual(deploymentEvidence.passedProbeIds, plan.probeIds);
    assert.deepEqual(plan.probeIds, [
      'core.id-ledger-persistence',
      'core.pre-write-validation',
      'core.parent-cycle-transaction',
      'core.node-subtree-transaction',
      'publication.http-contracts',
    ]);
    for (const excluded of [
      'core.sync-extension-persistence',
      'core.managed-bookmarks-transaction',
      'core.ai-provenance-transaction',
      'core.profile-id-persistence',
      'core.profile-id-key-rotation',
      'core.secret-redaction',
    ]) assert.equal(plan.probeIds.includes(excluded as never), false, excluded);
  });

  test('drives the real durable ID ledger through replay, cross-type conflict, concurrency, deletion, and restart', () => {
    const ledger = observed.filter((command) => command.kind.startsWith('id-ledger.'));
    const reservations = ledger.filter((command) => command.kind === 'id-ledger.reserve');
    assert.deepEqual(new Set(reservations.map((command) => command.resourceType)), new Set([
      'collection', 'event', 'node', 'annotation', 'relation',
    ]));
    assert.equal(ledger.filter((command) => command.kind === 'id-ledger.delete-resource').length, 1);
    assert.equal(restartCount, 1, 'the production target must recreate its PostgreSQL runtime');
    const requestedIds = reservations.map((command) => command.requestedId);
    assert.ok(requestedIds.some((id, index) => requestedIds.indexOf(id) !== index));
  });

  test('uses canonical write ports for pre-write rejection, cycle rollback, and complete subtree deletion', () => {
    assert.deepEqual(commandKinds('pre-write.'), [
      'pre-write.write', 'pre-write.load',
      'pre-write.write', 'pre-write.load',
      'pre-write.write', 'pre-write.load',
    ]);
    assert.deepEqual(commandKinds('parent-cycle.'), [
      'parent-cycle.seed', 'parent-cycle.move', 'parent-cycle.parent',
    ]);
    assert.deepEqual(commandKinds('node-subtree.'), [
      'node-subtree.seed', 'node-subtree.delete',
      'node-subtree.read', 'node-subtree.read', 'node-subtree.read',
      'node-subtree.read', 'node-subtree.read',
    ]);
    assert.equal(observed.some((command) => command.kind.startsWith('managed-bookmarks.')), false);
  });

  test('serves real conditional Manifest, Directory, Metadata, and Snapshot representations', async () => {
    const manifest = await conditionalRead(deployment.manifestUrl, {
      accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
      'collection-protocol-version': '0.1',
    });
    const mount = (manifest.value as { mounts: Array<{
      id: string;
      endpoints: { directory: string; collection: string; snapshot: string };
    }> }).mounts.find(({ id }) => id === 'publication');
    assert.ok(mount);
    const collectionId = POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId;
    await conditionalRead(mount.endpoints.directory, publicationHeaders('catalog'));
    await conditionalRead(
      mount.endpoints.collection.replace('{collectionId}', collectionId),
      publicationHeaders('collection'),
    );
    const snapshot = await conditionalRead(
      mount.endpoints.snapshot.replace('{collectionId}', collectionId),
      publicationHeaders('snapshot'),
    );
    assert.deepEqual(
      (snapshot.value as { attachments: unknown[] }).attachments,
      [],
      'the real shared-exposure facts port keeps unapproved attachments out of the public snapshot',
    );
    assert.equal(observed.filter((command) => command.kind === 'publication.http-contract').length, 1);
  });

  test('claims core/publication only with official package evidence and the real P2-16 stack', async () => {
    const mapping = createPhase2ReleaseRequirementMapping();
    if (!mapping.complete) {
      assert.equal(bundledConformanceEvidence.sourceRevision, 'unverified');
      assert.equal(mapping.passed, 0);
      return;
    }

    const artifact = await runPhase2PublicationAcceptance(
      deployment.target,
      deployment.expectations,
    );
    const verified = verifyPhase2PublicationEvidence(artifact, {
      sourceRevision: artifact.sourceRevision,
      sourceDigest: artifact.sourceDigest,
      now: new Date(artifact.generatedAt),
    });
    const claims = claimPhase2PublicationProfiles({ evidence: verified, deploymentEvidence });
    const release = evaluatePhase2ReleaseGate({
      acceptanceEvidence: verified,
      profileClaims: claims,
    });
    assert.deepEqual(release.claimedProfiles, ['core', 'publication']);
    assert.equal(release.packageRequirements.passed, mapping.expected);
    deployment.activateProfileClaims(claims);

    const manifest = await conditionalRead(deployment.manifestUrl, {
      accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
      'collection-protocol-version': '0.1',
    });
    const publication = (manifest.value as { mounts: Array<{ id: string; profiles: string[] }> })
      .mounts.find(({ id }) => id === 'publication');
    assert.deepEqual(publication?.profiles, ['core', 'publication']);
  }, 900_000);

  function commandKinds(prefix: string): string[] {
    return observed.filter((command) => command.kind.startsWith(prefix)).map(({ kind }) => kind);
  }

  async function conditionalRead(url: string, headers: Record<string, string>) {
    const initial = await deployment.fetch(url, { headers });
    assert.equal(initial.status, 200, url);
    const etag = initial.headers.get('etag');
    assert.ok(etag, `${url} ETag`);
    const value: unknown = await initial.json();
    const head = await deployment.fetch(url, { method: 'HEAD', headers });
    assert.equal(head.status, 200, `${url} HEAD`);
    assert.equal(await head.text(), '');
    const conditional = await deployment.fetch(url, {
      headers: { ...headers, 'if-none-match': etag },
    });
    assert.equal(conditional.status, 304, `${url} conditional GET`);
    return { value, etag };
  }
});

function publicationHeaders(representation: 'catalog' | 'collection' | 'snapshot') {
  return {
    accept: `application/vnd.collection-protocol.${representation}+json;version=0.1`,
    'collection-protocol-version': '0.1',
  };
}
