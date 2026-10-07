/**
 * P4A-I16 contract suite: independent evidence validator.
 *
 * The validator is a SEPARATE artifact (`scripts/phase4a-i16-validate-evidence.mjs`)
 * that parses the evidence bundle against the fixed schema, recomputes the
 * canonical digest with its own implementation, verifies the binding facts
 * (commit/tree/migration head/config digest/origin build/R2 control), verifies
 * the full negative-control catalog with zero skips/mocks, and rejects secrets.
 * The runner never validates its own digest — only this independent validator
 * (plus the gate) does.
 *
 * V4A-03: the validator is REVISION-AWARE. The default `retained` mode reads
 * the bound files and the migration head from git AT THE ARTIFACT'S OWN
 * SOURCE REVISION (current migration constants never veto historical
 * artifacts); `current` mode requires the artifact source/tree to equal the
 * current HEAD with a clean worktree.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildI16FixtureEvidence, i16NegativeControls, I16_TEST_REVISION, I16_TEST_TREE } from '../../support/phase4a-i16-test-helpers.js';
import { I16_MIGRATION_HEAD } from '../../../scripts/evidence/phase4a-i16-acceptance.js';

// The validator is plain Node ESM; vitest can import it directly.
const validator = await import('../../../scripts/phase4a-i16-validate-evidence.mjs');

/** Injected git runner for revision-aware contract tests. */
function fakeGit(script) {
  return (args) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(script, key)) {
      const value = script[key];
      if (value instanceof Error) throw value;
      return { stdout: value };
    }
    throw Object.assign(new Error('git_command_failed:' + key), { exitCode: 128 });
  };
}

/** A git script that makes the fixture bundle pass in retained mode. */
function retainedGitScript(migrationListing = 'migrations/202610012200_sync_sequence_logical_digest.ts') {
  return {
    'rev-parse --show-toplevel': '/repo',
    ['ls-tree -r --name-only ' + I16_TEST_REVISION]: migrationListing,
    ['rev-parse --verify ' + I16_TEST_REVISION + '^{commit}']: I16_TEST_REVISION,
    ['rev-parse ' + I16_TEST_REVISION + '^{tree}']: I16_TEST_TREE,
    ['merge-base --is-ancestor ' + I16_TEST_REVISION + ' HEAD']: '',
    'rev-parse HEAD': I16_TEST_REVISION,
    'rev-parse HEAD^{tree}': I16_TEST_TREE,
    'status --porcelain': '',
  };
}

describe('P4A-I16 independent evidence validator', () => {
  test('a valid bundle passes with the full check list', () => {
    const bundle = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundle(bundle);
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 5, 'schema/digest/binding/catalog/secret checks all ran');
    assert.deepEqual(result.errors, []);
  });

  test('the validator recomputes the canonical digest independently', () => {
    const bundle = buildI16FixtureEvidence();
    const expected = validator.computeDigest(bundle);
    assert.equal(expected, bundle.canonicalDigest);
    assert.match(expected, /^[a-f0-9]{64}$/);
  });

  test('a tampered canonical digest is rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const tampered = { ...bundle, canonicalDigest: 'f'.repeat(64) };
    const result = validator.validateEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /digest/i.test(error)));
  });

  test('a changed protocol fact is detected through the digest', () => {
    const bundle = buildI16FixtureEvidence();
    const tampered = {
      ...bundle,
      scenario: { ...bundle.scenario, cleanup: { ...bundle.scenario.cleanup, activePreserved: false } },
    };
    const result = validator.validateEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /digest/i.test(error)));
  });

  test('a forbidden mock/skip source in a control is rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const controls = bundle.negativeControls.map((control, index) => (
      index === 0 ? { ...control, verificationSource: 'mock' } : control
    ));
    const result = validator.validateEvidenceBundle({ ...bundle, negativeControls: controls });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /forbidden_source/i.test(error)));
  });

  test('a missing negative control is rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundle({
      ...bundle,
      negativeControls: bundle.negativeControls.slice(1),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /missing/i.test(error)));
  });

  test('a failed control verdict is rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const controls = bundle.negativeControls.map((control, index) => (
      index === 0 ? { ...control, verdict: 'fail' } : control
    ));
    const result = validator.validateEvidenceBundle({ ...bundle, negativeControls: controls });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /verdict|failed/i.test(error)));
  });

  test('a suite-attributed but unexecuted control is rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const controls = bundle.negativeControls.map((control, index) => (
      index === 0 ? { ...control, executed: false } : control
    ));
    const result = validator.validateEvidenceBundle({ ...bundle, negativeControls: controls });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /not_executed/i.test(error)));
  });

  test('binding facts are verified: dirty tree, wrong revision', () => {
    const bundle = buildI16FixtureEvidence();
    const dirty = validator.validateEvidenceBundle({ ...bundle, binding: { ...bundle.binding, sourceClean: false } });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.errors.some((error) => /source/i.test(error)));

    const wrongRevision = validator.validateEvidenceBundle(bundle, {
      expectedRevision: 'c'.repeat(40),
    });
    assert.equal(wrongRevision.ok, false);
    assert.ok(wrongRevision.errors.some((error) => /revision/i.test(error)));
  });

  test('retained mode replays a historical artifact bound to an OLDER migration head (no current-constant veto)', () => {
    // The artifact binds migration head `..._i15_operations` (an older head
    // than the current `I16_MIGRATION_HEAD` constant). Retained mode must
    // accept it: the migration head is recomputed from git at the artifact's
    // OWN bound revision, never compared against the current constant. (The
    // fixture BUILDER enforces the runner-side fresh-run constant, so the
    // binding is overridden after construction; the I16 canonical digest
    // binds protocol facts only, not the migration head.)
    const fixture = buildI16FixtureEvidence();
    const bundle = {
      ...fixture,
      binding: { ...fixture.binding, migrationHead: '202608080400_phase4a_i15_operations' },
    };
    const git = fakeGit(retainedGitScript('migrations/202608080400_phase4a_i15_operations.ts'));
    const result = validator.validateEvidenceBundleRevisionAware(bundle, { git });
    assert.equal(result.ok, true, result.errors.join(' | '));
    assert.ok(result.checks.includes('migration_head_recomputed'));
    assert.ok(result.checks.includes('revision_ancestry'));
    assert.ok(result.checks.includes('revision_tree_binding'));
  });

  test('retained mode rejects a migration head that does not match the bound revision', () => {
    const bundle = buildI16FixtureEvidence();
    const git = fakeGit(retainedGitScript('migrations/202608089999_some_other_head.ts'));
    const result = validator.validateEvidenceBundleRevisionAware(bundle, { git });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.startsWith('migration_head_mismatch:')));
  });

  test('retained mode fails closed on a missing revision', () => {
    const bundle = buildI16FixtureEvidence();
    const git = fakeGit({
      ...retainedGitScript(),
      ['rev-parse --verify ' + I16_TEST_REVISION + '^{commit}']: new Error('git exploded'),
    });
    const result = validator.validateEvidenceBundleRevisionAware(bundle, { git });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('revision_missing'));
  });

  test('retained mode fails closed on a tree/revision mismatch and on wrong ancestry', () => {
    const bundle = buildI16FixtureEvidence();
    const treeMismatch = fakeGit({
      ...retainedGitScript(),
      ['rev-parse ' + I16_TEST_REVISION + '^{tree}']: 'c'.repeat(40),
    });
    const treeResult = validator.validateEvidenceBundleRevisionAware(bundle, { git: treeMismatch });
    assert.equal(treeResult.ok, false);
    assert.ok(treeResult.errors.includes('revision_tree_mismatch'));

    const notAncestor = fakeGit({
      ...retainedGitScript(),
      ['merge-base --is-ancestor ' + I16_TEST_REVISION + ' HEAD']: Object.assign(new Error('not ancestor'), { exitCode: 1 }),
    });
    const ancestryResult = validator.validateEvidenceBundleRevisionAware(bundle, { git: notAncestor });
    assert.equal(ancestryResult.ok, false);
    assert.ok(ancestryResult.errors.includes('revision_not_ancestor'));
  });

  test('current mode requires the artifact to equal HEAD and a clean worktree', () => {
    const bundle = buildI16FixtureEvidence();
    const oldRevision = validator.validateEvidenceBundleRevisionAware(bundle, { mode: 'current', git: fakeGit({
      ...retainedGitScript(),
      'rev-parse HEAD': 'c'.repeat(40),
    }) });
    assert.equal(oldRevision.ok, false);
    assert.ok(oldRevision.errors.includes('current_revision_not_head'));

    const dirtyTree = validator.validateEvidenceBundleRevisionAware(bundle, { mode: 'current', git: fakeGit({
      ...retainedGitScript(),
      'status --porcelain': ' M src/foo.ts\n',
    }) });
    assert.equal(dirtyTree.ok, false);
    assert.ok(dirtyTree.errors.includes('current_worktree_dirty'));

    const treeMismatch = validator.validateEvidenceBundleRevisionAware(bundle, { mode: 'current', git: fakeGit({
      ...retainedGitScript(),
      'rev-parse HEAD^{tree}': 'd'.repeat(40),
    }) });
    assert.equal(treeMismatch.ok, false);
    assert.ok(treeMismatch.errors.includes('current_tree_not_head'));
  });

  test('current mode passes a hypothetical artifact bound to the current HEAD', () => {
    const bundle = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundleRevisionAware(bundle, {
      mode: 'current',
      git: fakeGit(retainedGitScript(`migrations/${I16_MIGRATION_HEAD}.ts`)),
    });
    assert.equal(result.ok, true, result.errors.join(' | '));
    assert.ok(result.checks.includes('current_revision_is_head'));
    assert.ok(result.checks.includes('current_worktree_clean'));
  });

  test('invalid mode fails with the stable code', () => {
    const bundle = buildI16FixtureEvidence();
    const result = validator.validateEvidenceBundleRevisionAware(bundle, { mode: 'bogus' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['invalid_mode:bogus']);
  });

  test('retained mode still enforces the pure checks (tamper cannot pass)', () => {
    const bundle = buildI16FixtureEvidence();
    const tampered = { ...bundle, canonicalDigest: 'f'.repeat(64) };
    const result = validator.validateEvidenceBundleRevisionAware(tampered, { git: fakeGit(retainedGitScript()) });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /digest/i.test(error)));
  });

  test('secrets in the bundle are rejected', () => {
    const bundle = buildI16FixtureEvidence();
    const secretBundle = {
      ...bundle,
      negativeControls: bundle.negativeControls.map((control, index) => (
        index === 0 ? { ...control, outcome: 'i16-leaked-credential-value' } : control
      )),
    };
    const result = validator.validateEvidenceBundle(secretBundle, {
      forbiddenValues: ['i16-leaked-credential-value'],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /secret|sensitive/i.test(error)));
  });

  test('the validator pins the tracked artifact default path and shares the runner constants', () => {
    assert.equal(validator.I16_DEFAULT_EVIDENCE_OUTPUT, 'docs/evidence/phase4a-i16-acceptance.json');
    // The current fresh-run migration head stays pinned as a shared constant,
    // but it is INFORMATIONAL ONLY — the validator recomputes the migration
    // head from git at the artifact's bound revision and never vetoes with it.
    assert.equal(validator.I16_MIGRATION_HEAD, I16_MIGRATION_HEAD);
    assert.equal(validator.I16_EVIDENCE_SCHEMA_VERSION, 1);
    assert.ok(validator.I16_NEGATIVE_CONTROL_IDS.length >= 20);
    assert.ok(validator.I16_FORBIDDEN_SOURCES.includes('mock'));
    // The fixture negative-control list is exactly the catalog the validator requires.
    const ids = i16NegativeControls().map((control) => control.control);
    for (const id of ids) assert.ok(validator.I16_NEGATIVE_CONTROL_IDS.includes(id));
  });
});
