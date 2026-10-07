/**
 * P4A-I16 contract suite: source-bound fail-closed paths.
 *
 * The runner must REFUSE to run when the reviewed revision is unpinned, the
 * worktree is dirty, the production migration head is missing/mismatched, the
 * production config digest cannot be computed, or the I01 capability cannot
 * be attested. Each path surfaces a STABLE non-zero code
 * (`source_revision_unpinned`, `source_worktree_not_clean`,
 * `source_revision_unavailable`, `migration_head_missing`,
 * `migration_head_mismatch`, `config_digest_missing`, `i01_capability_missing`)
 * so the acceptance gate can never confuse a fail-closed refusal with a pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, test } from 'vitest';
import {
  I16_MIGRATION_HEAD,
  assertI01CapabilityPresent,
  canonicalizeI16,
  computeI16ConfigDigest,
  resolveMigrationHead,
  resolveSourceBinding,
  sha256HexI16,
  type I16GitRunner,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import { productionMigrationNamesFromDisk } from '../../../scripts/lexical-migration-head.mjs';
import {
  I16_TEST_REVISION,
  I16_TEST_TREE,
  i16Config,
} from '../../support/phase4a-i16-test-helpers.js';

const REV = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function git(script: Record<string, string>, failures: Set<string> = new Set()): I16GitRunner {
  return async (args, options) => {
    const key = args.join(' ');
    if (failures.has(key)) throw new Error('git exploded');
    const stdout = script[key] ?? '';
    return { stdout, stderr: '' };
  };
}

describe('P4A-I16 source binding fail-closed paths', () => {
  test('clean + pinned worktree resolves revision and tree hash', async () => {
    const context = await resolveSourceBinding(git({
      'rev-parse HEAD': REV,
      'rev-parse HEAD^{tree}': TREE,
      'status --porcelain': '',
    }), { expectedRevision: REV });
    assert.deepEqual(context, { revision: REV, treeHash: TREE, clean: true });
  });

  test('dirty tree refuses to run', async () => {
    await assert.rejects(
      resolveSourceBinding(git({
        'rev-parse HEAD': REV,
        'rev-parse HEAD^{tree}': TREE,
        'status --porcelain': ' M src/foo.ts',
      }), { expectedRevision: REV }),
      /source_worktree_not_clean/,
    );
  });

  test('unpinned revision refuses to run', async () => {
    await assert.rejects(
      resolveSourceBinding(git({
        'rev-parse HEAD': REV,
        'rev-parse HEAD^{tree}': TREE,
        'status --porcelain': '',
      }), {}),
      /source_revision_unpinned/,
    );
  });

  test('revision differing from the reviewed pin refuses to run', async () => {
    await assert.rejects(
      resolveSourceBinding(git({
        'rev-parse HEAD': REV,
        'rev-parse HEAD^{tree}': TREE,
        'status --porcelain': '',
      }), { expectedRevision: 'c'.repeat(40) }),
      /source_revision_unpinned/,
    );
  });

  test('unavailable git metadata refuses to run', async () => {
    await assert.rejects(
      resolveSourceBinding(git({
        'rev-parse HEAD': REV,
        'rev-parse HEAD^{tree}': TREE,
        'status --porcelain': '',
      }, new Set(['rev-parse HEAD'])), { expectedRevision: REV }),
      /source_revision_unavailable/,
    );
    await assert.rejects(
      resolveSourceBinding(git({
        'rev-parse HEAD': '',
        'rev-parse HEAD^{tree}': TREE,
        'status --porcelain': '',
      }), { expectedRevision: REV }),
      /source_revision_unavailable/,
    );
  });

  test('the fixture revision/tree are well-formed git object ids', () => {
    assert.match(I16_TEST_REVISION, /^[a-f0-9]{40,64}$/);
    assert.match(I16_TEST_TREE, /^[a-f0-9]{40,64}$/);
  });

  // Fixture revision is the reviewed current migration head; its last
  // migration file equals disk `I16_MIGRATION_HEAD`.
  test('the fixture revision is a real ancestor whose tree and migration head match git', () => {
    const tree = execFileSync('git', ['rev-parse', `${I16_TEST_REVISION}^{tree}`], {
      encoding: 'utf8',
    }).trim();
    assert.equal(tree, I16_TEST_TREE);
    execFileSync('git', ['merge-base', '--is-ancestor', I16_TEST_REVISION, 'HEAD']);
    const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', I16_TEST_REVISION], {
      encoding: 'utf8',
    });
    const names = listing
      .split('\n')
      .map((line) => line.trim().split('/').pop() ?? '')
      .filter((name) => /^\d{12}_[a-z0-9_]+\.ts$/u.test(name))
      .sort();
    assert.equal(names.at(-1)?.replace(/\.ts$/, ''), I16_MIGRATION_HEAD);
    const live = readdirSync(new URL('../../../migrations/', import.meta.url))
      .filter((name) => /^\d{12}_[a-z0-9_]+\.ts$/u.test(name))
      .sort();
    assert.equal(live.at(-1)?.replace(/\.ts$/, ''), I16_MIGRATION_HEAD);
  });
});

describe('P4A-I16 migration head fail-closed paths', () => {
  test('the production migration head resolves from the full chain', async () => {
    const head = await resolveMigrationHead(async () => (
      productionMigrationNamesFromDisk().map((name) => `migrations/${name}.ts`)
    ));
    assert.equal(head, I16_MIGRATION_HEAD);
  });

  test('missing migrations refuse to run', async () => {
    await assert.rejects(resolveMigrationHead(async () => []), /migration_head_missing/);
  });

  test('a wrong migration head refuses to run', async () => {
    await assert.rejects(
      resolveMigrationHead(async () => [
        'migrations/202608080000_phase4a_attachments.ts',
        'migrations/202608089999_some_other_head.ts',
      ]),
      /migration_head_mismatch/,
    );
  });
});

describe('P4A-I16 config digest fail-closed paths', () => {
  test('missing production config refuses to run', () => {
    assert.throws(() => computeI16ConfigDigest(undefined), /config_digest_missing/);
  });

  test('the digest binds only canonicalized non-secret config facts', () => {
    const { digest, facts } = computeI16ConfigDigest(i16Config());
    assert.equal(digest, sha256HexI16(canonicalizeI16(facts)));
    assert.equal(facts.enabled, true);
    assert.ok(!('endpoint' in facts));
    assert.ok(!('bucket' in facts));
    assert.ok(!('rwSecretRef' in facts));
    assert.ok(!('roSecretRef' in facts));
    assert.ok(!('livePrefix' in facts));
    assert.ok(!('probePrefix' in facts));
  });

  test('a config fact change changes the digest', () => {
    const base = computeI16ConfigDigest(i16Config());
    const changed = computeI16ConfigDigest(i16Config({ grantTtlSeconds: 90 }));
    assert.notEqual(changed.digest, base.digest);
  });
});

describe('P4A-I16 I01 capability fail-closed paths', () => {
  const attestation = {
    schemaVersion: 3,
    nonce: 'i16-nonce-0000000000000000000000000000',
    sourceRevision: REV,
    targetBinding: 'sha256:' + 'd'.repeat(64),
    verdictSource: 'cloudflare-control-api-live-query',
    provider: 'cloudflare-r2',
    accessMode: 'direct-object-api',
    bucketPrivate: true,
    customDomainEnabled: false,
    r2DevEnabled: false,
    managedEncryptionAtRest: 'cloudflare-provider-invariant',
    tlsRequired: true,
    writeCredentialScope: 'bucket-object-read-write',
    readCredentialScope: 'bucket-object-read-only',
    conditionalCreateContractRequired: true,
    providerPreventsUnconditionalOverwrite: false,
    retention: { probeObjectsMaximumAgeSeconds: 86_400, quarantineAutomaticDeletion: false },
  };

  test('a valid control-plane attestation passes', async () => {
    const result = await assertI01CapabilityPresent({
      runAttestor: async () => ({ stdout: JSON.stringify(attestation) }),
      nonce: attestation.nonce,
      sourceRevision: REV,
      targetBinding: attestation.targetBinding,
    });
    assert.equal(result.attested, true);
  });

  test('a failing attestor refuses to run with the missing-capability code', async () => {
    await assert.rejects(
      assertI01CapabilityPresent({
        runAttestor: async () => { throw new Error('control_token_missing'); },
        nonce: attestation.nonce,
        sourceRevision: REV,
        targetBinding: attestation.targetBinding,
      }),
      /i01_capability_missing/,
    );
    await assert.rejects(
      assertI01CapabilityPresent({
        runAttestor: async () => ({ stdout: 'not json' }),
        nonce: attestation.nonce,
        sourceRevision: REV,
        targetBinding: attestation.targetBinding,
      }),
      /i01_capability_missing/,
    );
  });
});
