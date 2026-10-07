/**
 * V4A-03 validator contract suite (plan §4 V4A-03 focused gate: the new
 * validator contract suite). Proves the I16 and P11 INDEPENDENT validators
 * are revision-aware through their REAL public CLIs against the TRACKED
 * artifacts and temp copies:
 *   - retained pass (default mode): the tracked I16 artifact replays from
 *     git at its OWN bound revision (migration head recomputed, tree
 *     binding + ancestry verified; no current-constant veto);
 *   - current mode fails old artifacts with the stable `current_revision_not_head`
 *     code; a dirty checkout fails closed with `current_worktree_dirty`;
 *   - tampered artifacts, missing revisions, wrong ancestry and historical
 *     binding-file drift all fail closed in retained mode;
 *   - the historical P11 artifact's repository-bound digests
 *     (`openapiDigest`, `originBuild.buildHash`) are NOT reproducible from
 *     its bound revision (the 2026-08-10 run digested CRLF-materialized
 *     Windows-checkout files; git stores LF). This is the real defect the
 *     plan requires REPORTING — the validator keeps failing with the precise
 *     digest-recompute diagnostics and the JSON is never rewritten to
 *     accommodate the validator.
 */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { computeDigest as p11ComputeDigest } from '../../../scripts/phase4a-owner-private-validate-evidence.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const i16ArtifactPath = resolve(backendRoot, 'docs/evidence/phase4a-i16-acceptance.json');
const p11ArtifactPath = resolve(backendRoot, 'docs/evidence/phase4a-owner-private.json');
const i16Validator = resolve(backendRoot, 'scripts/phase4a-i16-validate-evidence.mjs');
const p11Validator = resolve(backendRoot, 'scripts/phase4a-owner-private-validate-evidence.mjs');

function runValidator(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tempArtifact(sourcePath, mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'known-v4a03-validator-'));
  const path = join(directory, 'artifact.json');
  const bundle = JSON.parse(readFileSync(sourcePath, 'utf8'));
  writeFileSync(path, `${JSON.stringify(mutate(bundle), null, 2)}\n`, 'utf8');
  return path;
}

/**
 * A commit that exists in this repository but is NOT an ancestor of HEAD.
 *
 * Q1 integration fix: this repository's history is single-branch (every ref
 * is an ancestor of HEAD), so there is nothing to find — manufacture a
 * genuine non-ancestor commit instead: an orphan commit over the CURRENT
 * tree, referenced only by a temporary ref the caller deletes. The working
 * tree and index are never touched.
 */
const SYNTHETIC_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'known-v4a03-test',
  GIT_AUTHOR_EMAIL: 'known-v4a03-test@example.test',
  GIT_COMMITTER_NAME: 'known-v4a03-test',
  GIT_COMMITTER_EMAIL: 'known-v4a03-test@example.test',
} as const;

function nonAncestorRevision(): { readonly revision: string; readonly cleanup: () => void } {
  const tempRef = 'refs/known-v4a03-nonancestor-tmp';
  spawnSync('git', ['update-ref', '-d', tempRef], { cwd: backendRoot, encoding: 'utf8' });
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  // act images have no user.name/email; commit-tree must not inherit the
  // runner identity (root@cursor.(none) fails closed).
  const created = spawnSync(
    'git',
    [
      '-c', `user.name=${SYNTHETIC_GIT_IDENTITY.GIT_AUTHOR_NAME}`,
      '-c', `user.email=${SYNTHETIC_GIT_IDENTITY.GIT_AUTHOR_EMAIL}`,
      'commit-tree',
      tree,
      '-m',
      'known v4a03 synthetic non-ancestor commit',
    ],
    {
      cwd: backendRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...SYNTHETIC_GIT_IDENTITY },
    },
  );
  assert.equal(created.status, 0, created.stderr?.toString() ?? 'commit-tree failed');
  const revision = created.stdout.trim();
  assert.match(revision, /^[a-f0-9]{40}$/, 'commit-tree must produce a full sha');
  const ref = spawnSync('git', ['update-ref', tempRef, revision], { cwd: backendRoot, encoding: 'utf8' });
  assert.equal(ref.status, 0, ref.stderr?.toString() ?? 'update-ref failed');
  return {
    revision,
    cleanup: () => spawnSync('git', ['update-ref', '-d', tempRef], { cwd: backendRoot, encoding: 'utf8' }),
  };
}

test('V4A-03 retained mode (default) replays the tracked I16 artifact from its bound revision', { timeout: 90_000 }, () => {
  const result = runValidator(i16Validator);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /phase4a_i16_validator:pass/u);
  assert.match(result.stdout, /revision_exists/u);
  assert.match(result.stdout, /revision_tree_binding/u);
  assert.match(result.stdout, /revision_ancestry/u);
  assert.match(result.stdout, /migration_head_recomputed/u);

  const explicit = runValidator(i16Validator, ['--mode', 'retained']);
  assert.equal(explicit.status, 0, `${explicit.stdout}${explicit.stderr}`);
});

test('V4A-03 the tracked I16 artifact binds a migration head OLDER than the current constant without a veto', { timeout: 90_000 }, () => {
  const bundle = JSON.parse(readFileSync(i16ArtifactPath, 'utf8'));
  // The historical artifact binds the i15 head while the current fresh-run
  // constant is the p02 head; retained mode must NOT use the constant.
  assert.notEqual(bundle.binding.migrationHead, '202608080500_phase4a_p02_attachment_metadata');
  assert.equal(bundle.binding.migrationHead, '202608080400_phase4a_i15_operations');
  // The bound revision/tree are genuine and ancestral (the retained pass
  // above already proves the recompute; pin the facts here for the record).
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backendRoot, encoding: 'utf8' }).trim();
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', bundle.binding.sourceRevision, head], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  assert.equal(ancestry.status, 0, 'tracked I16 revision must be an ancestor of HEAD');
});

test('V4A-03 retained mode replays the P11 validator on a coherent revision-aware bundle', { timeout: 90_000 }, () => {
  // The public P11 CLI also exposes retained mode; the historical tracked
  // artifact itself is the real drift case (next test), so replay a temp
  // artifact whose digests match its bound revision by construction: bind
  // the artifact to HEAD with digests of the CURRENT tracked files.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backendRoot, encoding: 'utf8' }).trim();
  const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: backendRoot, encoding: 'utf8' }).trim();
  // Q1 integration drift: the temp artifact is re-bound to HEAD, so the
  // migration-head fact must be the head AT HEAD (recomputed from the
  // migrations directory), not the historical constant the tracked artifact
  // carried — retained mode recomputes the head at the bound revision.
  const migrationHead = readdirSync(resolve(backendRoot, 'migrations'))
    .filter((name) => /^\d{12}_[a-z0-9_]+\.ts$/u.test(name))
    .sort()
    .at(-1)!.replace(/\.ts$/, '');
  const bundle = JSON.parse(readFileSync(p11ArtifactPath, 'utf8'));
  const openapi = readFileSync(resolve(backendRoot, 'openapi/product-v1.yaml'), 'utf8');
  const clientContents = ['generated/openapi/product-v1.client.ts', 'generated/openapi/product-v1.routes.json']
    .sort()
    .map((path) => readFileSync(resolve(backendRoot, path), 'utf8'));
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
  const tsconfig = readFileSync(resolve(backendRoot, 'tsconfig.json'), 'utf8');

  function canonicalize(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    if (typeof value === 'object') {
      const entries = Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => JSON.stringify(key) + ':' + canonicalize(nested));
      return '{' + entries.join(',') + '}';
    }
    return JSON.stringify(String(value));
  }
  const buildHash = sha256Hex(canonicalize({
    buildCommand: 'npm run build',
    buildScript: packageJson.scripts?.build ?? '',
    tsconfig,
  }));
  const path = tempArtifact(p11ArtifactPath, (mutated) => {
    const updated = {
      ...mutated,
      binding: {
        ...mutated.binding,
        sourceRevision: head,
        sourceTreeHash: headTree,
        migrationHead,
        openapiDigest: sha256Hex(openapi),
        clientDigest: sha256Hex(clientContents.join('\n')),
        originBuild: { ...mutated.binding.originBuild, buildHash },
      },
    };
    // Re-seal the canonical digest over the updated protocol facts using the
    // INDEPENDENT validator's own digest implementation.
    return { ...updated, canonicalDigest: p11ComputeDigest(updated) };
  });
  const result = runValidator(p11Validator, [path, '--mode', 'retained']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /phase4a_owner_private_validate:pass/u);
  // The P11 CLI reports the check COUNT (not names); the revision checks are
  // pinned by the unit contract (tests/unit/phase4a/phase4a-p11-validator.test.ts).
});

test('V4A-03 the tracked P11 artifact fails retained with the PRECISE drift diagnostics (real defect, JSON untouched)', { timeout: 90_000 }, () => {
  // The historical P11 artifact's openapiDigest + originBuild.buildHash are
  // sha256 over CRLF-materialized files from the 2026-08-10 Windows checkout;
  // git stores LF, so NO revision reproduces them. Per the plan, this real
  // defect is REPORTED, the failure is kept, and the JSON is never rewritten
  // to accommodate the validator.
  const bundle = JSON.parse(readFileSync(p11ArtifactPath, 'utf8'));
  const before = readFileSync(p11ArtifactPath, 'utf8');
  const result = runValidator(p11Validator, ['--mode', 'retained']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /binding:openapi_digest/u);
  assert.match(result.stderr, /binding:origin_build_hash/u);
  // Fail-closed with the revision checks that DO hold: the failure is the
  // digest drift, not a missing/unknown revision or a constant veto.
  assert.doesNotMatch(result.stderr, /revision_missing|revision_not_ancestor|binding_migration_head/u);
  // The validator is read-only: the artifact bytes are byte-identical.
  assert.equal(readFileSync(p11ArtifactPath, 'utf8'), before);
  assert.equal(bundle.binding.sourceRevision, '3d538cdeb40c14f9fadff502eb61fe2c2d5705a6');
});

test('V4A-03 current mode fails both old tracked artifacts with the stable code', { timeout: 90_000 }, () => {
  const i16 = runValidator(i16Validator, ['--mode', 'current']);
  assert.notEqual(i16.status, 0);
  assert.match(i16.stderr, /current_revision_not_head/u);

  const p11 = runValidator(p11Validator, ['--mode', 'current']);
  assert.notEqual(p11.status, 0);
  assert.match(p11.stderr, /current_revision_not_head/u);
});

test('V4A-03 tampered artifacts fail closed in retained mode', { timeout: 90_000 }, () => {
  const i16Path = tempArtifact(i16ArtifactPath, (bundle) => ({ ...bundle, canonicalDigest: 'f'.repeat(64) }));
  const i16 = runValidator(i16Validator, [i16Path]);
  assert.notEqual(i16.status, 0);
  assert.match(i16.stderr, /canonical_digest/u);

  const p11Path = tempArtifact(p11ArtifactPath, (bundle) => ({
    ...bundle,
    binding: { ...bundle.binding, sourceClean: false },
  }));
  const p11 = runValidator(p11Validator, [p11Path]);
  assert.notEqual(p11.status, 0);
  assert.match(p11.stderr, /binding:source_clean/u);
});

test('V4A-03 a missing bound revision fails closed in retained mode', { timeout: 90_000 }, () => {
  const i16Path = tempArtifact(i16ArtifactPath, (bundle) => ({
    ...bundle,
    binding: { ...bundle.binding, sourceRevision: 'f'.repeat(40) },
  }));
  const i16 = runValidator(i16Validator, [i16Path]);
  assert.notEqual(i16.status, 0);
  assert.match(i16.stderr, /revision_missing/u);

  const p11Path = tempArtifact(p11ArtifactPath, (bundle) => ({
    ...bundle,
    binding: { ...bundle.binding, sourceRevision: 'f'.repeat(40) },
  }));
  const p11 = runValidator(p11Validator, [p11Path]);
  assert.notEqual(p11.status, 0);
  assert.match(p11.stderr, /revision_missing/u);
});

test('V4A-03 a revision that is not an ancestor of HEAD fails closed in retained mode', { timeout: 90_000 }, () => {
  // A commit present in this repository but NOT in HEAD's ancestry (a
  // synthetic orphan commit on a temporary ref — see nonAncestorRevision).
  const { revision, cleanup } = nonAncestorRevision();
  try {
    const tree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], {
      cwd: backendRoot, encoding: 'utf8',
    }).trim();
    const migrations = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], {
      cwd: backendRoot, encoding: 'utf8',
    }).trim();
    const migrationNames = migrations.split('\n')
      .map((line) => line.split('/').pop() ?? '')
      .filter((name) => /^\d{12}_[a-z0-9_]+\.ts$/u.test(name))
      .sort();
    assert.ok(migrationNames.length > 0, 'non-ancestor revision must carry migrations');
    const migrationHead = migrationNames.at(-1).replace(/\.ts$/, '');

    const i16Path = tempArtifact(i16ArtifactPath, (bundle) => ({
      ...bundle,
      binding: { ...bundle.binding, sourceRevision: revision, sourceTreeHash: tree, migrationHead },
    }));
    const i16 = runValidator(i16Validator, [i16Path]);
    assert.notEqual(i16.status, 0);
    assert.match(i16.stderr, /revision_not_ancestor/u);

  const p11Path = tempArtifact(p11ArtifactPath, (bundle) => ({
    ...bundle,
    binding: { ...bundle.binding, sourceRevision: revision, sourceTreeHash: tree, migrationHead },
  }));
  const p11 = runValidator(p11Validator, [p11Path]);
  assert.notEqual(p11.status, 0);
  assert.match(p11.stderr, /revision_not_ancestor/u);
  } finally {
    cleanup();
  }
});

test('V4A-03 historical binding file drift is detected against the bound revision, not the working tree', { timeout: 90_000 }, () => {
  const bundle = JSON.parse(readFileSync(p11ArtifactPath, 'utf8'));
  const currentOpenapi = readFileSync(resolve(backendRoot, 'openapi/product-v1.yaml'), 'utf8');
  // The current working-tree digest differs from the artifact's recorded
  // digest (the real drift: the recorded digests are CRLF-based), yet
  // retained mode replays against the bound revision. Pin the drift fact.
  assert.notEqual(sha256Hex(currentOpenapi), bundle.binding.openapiDigest,
    'current-tree openapi digest must differ from the recorded CRLF digest');

  // A HEAD-bound artifact (all digests matching the bound revision, resealed)
  // with ONE digest replaced fails retained with precisely that digest code.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backendRoot, encoding: 'utf8' }).trim();
  const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: backendRoot, encoding: 'utf8' }).trim();
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
  const tsconfig = readFileSync(resolve(backendRoot, 'tsconfig.json'), 'utf8');
  function canonicalize(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    if (typeof value === 'object') {
      const entries = Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => JSON.stringify(key) + ':' + canonicalize(nested));
      return '{' + entries.join(',') + '}';
    }
    return JSON.stringify(String(value));
  }
  const buildHash = sha256Hex(canonicalize({
    buildCommand: 'npm run build',
    buildScript: packageJson.scripts?.build ?? '',
    tsconfig,
  }));
  const driftedPath = tempArtifact(p11ArtifactPath, (mutated) => {
    const updated = {
      ...mutated,
      binding: {
        ...mutated.binding,
        sourceRevision: head,
        sourceTreeHash: headTree,
        openapiDigest: sha256Hex(currentOpenapi),
        clientDigest: sha256Hex(['generated/openapi/product-v1.client.ts', 'generated/openapi/product-v1.routes.json']
          .sort()
          .map((path) => readFileSync(resolve(backendRoot, path), 'utf8'))
          .join('\n')),
        originBuild: { ...mutated.binding.originBuild, buildHash },
      },
    };
    return {
      ...updated,
      binding: { ...updated.binding, openapiDigest: '0'.repeat(64) },
      canonicalDigest: p11ComputeDigest({ ...updated, binding: { ...updated.binding, openapiDigest: '0'.repeat(64) } }),
    };
  });
  const drifted = runValidator(p11Validator, [driftedPath, '--mode', 'retained']);
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /binding:openapi_digest/u);
});

test('V4A-03 a dirty checkout fails closed ONLY in current mode; retained ignores worktree state', { timeout: 90_000 }, () => {
  const scratch = resolve(backendRoot, 'tests/fixtures/phase4a/.v4a03-dirty-probe');
  writeFileSync(scratch, 'dirty probe\n', 'utf8');
  try {
    const i16Current = runValidator(i16Validator, ['--mode', 'current']);
    assert.notEqual(i16Current.status, 0);
    assert.match(i16Current.stderr, /current_worktree_dirty/u);

    const p11Current = runValidator(p11Validator, ['--mode', 'current']);
    assert.notEqual(p11Current.status, 0);
    assert.match(p11Current.stderr, /current_worktree_dirty/u);

    // Retained mode is bound to git history, so the dirty worktree does NOT
    // veto the historical I16 replay (and never reports the dirty code).
    const i16Retained = runValidator(i16Validator);
    assert.equal(i16Retained.status, 0, `${i16Retained.stdout}${i16Retained.stderr}`);
    assert.doesNotMatch(i16Retained.stderr, /current_worktree_dirty/u);

    const p11Retained = runValidator(p11Validator, ['--mode', 'retained']);
    assert.notEqual(p11Retained.status, 0);
    assert.doesNotMatch(p11Retained.stderr, /current_worktree_dirty/u);
  } finally {
    unlinkSync(scratch);
  }
});

test('V4A-03 invalid mode fails with the stable code on both validators', { timeout: 90_000 }, () => {
  const i16 = runValidator(i16Validator, ['--mode', 'bogus']);
  assert.notEqual(i16.status, 0);
  assert.match(i16.stderr, /invalid_mode:bogus/u);

  const p11 = runValidator(p11Validator, ['--mode', 'bogus']);
  assert.notEqual(p11.status, 0);
  assert.match(`${p11.stdout}${p11.stderr}`, /invalid_mode:bogus/u);
});
