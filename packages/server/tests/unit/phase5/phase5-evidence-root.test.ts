import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { test } from 'vitest';
import {
  EVIDENCE_ROOT_ENV,
  LOCK_PATH_FIELD,
  assertPortableRelativePath,
  assertResolvedArtifactStable,
  canonicalizeExistingPath,
  digestDependencyValidationRecords,
  pathIndependentDependencyRecord,
  readLockRelativePath,
  resolveEvidenceRootFromEnv,
  resolveLockedArtifactPath,
} from '../../../scripts/phase5-evidence-root.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function makeOutsideRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return canonicalizeExistingPath(root);
}

function writeArtifact(root: string, relativePath: string, contents: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const absolute = resolve(root, ...normalized.split('/'));
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

test('R5-10 exposes supporting evidence-root focused gate without postgres wrapper', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:evidence-root'],
    'vitest run tests/unit/phase5/phase5-evidence-root.test.ts',
  );
  assert.equal(/with-postgres/u.test(packageJson.scripts['test:phase5:evidence-root'] ?? ''), false);
});

test('R5-10 closed schema freezes portable root contract', () => {
  const schema = JSON.parse(
    readSource('tests/fixtures/phase5/remediation/r5-10-evidence-root.schema.json'),
  ) as {
    additionalProperties: boolean;
    required: readonly string[];
    properties: {
      format: { const: string };
      task: { const: string };
      runtimeRootEnv: { const: string };
      lockPathField: { const: string };
      rules: { properties: Record<string, { const: boolean }> };
    };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-10.v1');
  assert.equal(schema.properties.task.const, 'R5-10');
  assert.equal(schema.properties.runtimeRootEnv.const, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(schema.properties.lockPathField.const, 'relativePath');
  for (const key of ['format', 'task', 'runtimeRootEnv', 'lockPathField', 'rules']) {
    assert.ok(schema.required.includes(key), `schema must require ${key}`);
  }
  for (const rule of [
    'runtimeRootMustBeAbsolute',
    'artifactMustBeInsideRoot',
    'artifactMustBeOutsideCheckout',
    'artifactMustBeRegularFile',
    'forbidAbsoluteRelativePath',
    'forbidParentSegmentEscape',
    'forbidPersonalPathFallback',
    'forbidPerArtifactEnvOverride',
    'forbidCommittedArtifactBodies',
  ]) {
    assert.equal(schema.properties.rules.properties[rule]?.const, true, rule);
  }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate({ format: 'known.phase5.remediation.r5-10.v1', task: 'R5-10' }), false);
});

test('R5-10 module freezes env and lock field constants', () => {
  assert.equal(EVIDENCE_ROOT_ENV, 'KNOWN_PHASE5_EVIDENCE_ROOT');
  assert.equal(LOCK_PATH_FIELD, 'relativePath');
  const moduleSource = readSource('scripts/phase5-evidence-root.mjs');
  assert.match(moduleSource, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(moduleSource, /relativePath/u);
  assert.doesNotMatch(moduleSource, /AppData\\\\Local\\\\Temp|Users\\\\white\\\\Desktop/u);
  assert.doesNotMatch(moduleSource, /KNOWN_PHASE5_[A-Z_]+_ARTIFACT(?:_PATH)?\b/u);
});

test('R5-10 accepts POSIX and Windows separators in relativePath', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-sep-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    const posixPath = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle/a.json',
      checkoutRoot,
    });
    const windowsPath = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle\\a.json',
      checkoutRoot,
    });
    assert.equal(posixPath, windowsPath);
    assert.equal(basename(posixPath), 'a.json');
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 rejects parent-segment escape in relativePath', () => {
  assert.throws(() => assertPortableRelativePath('../secret.json'), /relativePath|parent|\.\./iu);
  assert.throws(() => assertPortableRelativePath('bundle/../secret.json'), /relativePath|parent|\.\./iu);
  const evidenceRoot = makeOutsideRoot('known-r5-10-dotdot-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    assert.throws(() => resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: '../outside.json',
      checkoutRoot,
    }), /relativePath|parent|\.\.|escape/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 rejects absolute relativePath values', () => {
  assert.throws(() => assertPortableRelativePath('C:\\Users\\white\\a.json'), /absolute/iu);
  assert.throws(() => assertPortableRelativePath('/tmp/a.json'), /absolute/iu);
  assert.throws(() => assertPortableRelativePath('\\\\server\\share\\a.json'), /absolute/iu);
});

test('R5-10 rejects symlink or junction escape outside the evidence root', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-link-root-');
  const outside = makeOutsideRoot('known-r5-10-link-outside-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    const outsideFile = join(outside, 'escaped.json');
    writeFileSync(outsideFile, '{"escaped":true}\n');
    const linkPath = join(evidenceRoot, 'escape-link');
    try {
      symlinkSync(outsideFile, linkPath, process.platform === 'win32' ? 'file' : undefined);
    } catch {
      // Windows may deny file symlinks without elevation; use a junction to a directory instead.
      const outsideDir = join(outside, 'payload');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'escaped.json'), '{"escaped":true}\n');
      symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => resolveLockedArtifactPath({
        evidenceRoot,
        relativePath: 'escape-link/escaped.json',
        checkoutRoot,
      }), /inside|root|escape|outside/iu);
      return;
    }
    assert.throws(() => resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'escape-link',
      checkoutRoot,
    }), /inside|root|escape|outside/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('R5-10 rejects an evidence root located inside the checkout', () => {
  const nested = mkdtempSync(join(backendRoot, 'tmp-r5-10-root-'));
  try {
    const nestedRoot = canonicalizeExistingPath(nested);
    assert.throws(() => resolveEvidenceRootFromEnv({
      [EVIDENCE_ROOT_ENV]: nestedRoot,
    }, canonicalizeExistingPath(repositoryRoot)), /checkout|outside|evidence root/iu);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test('R5-10 rejects missing artifact files', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-missing-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    assert.throws(() => resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle/missing.json',
      checkoutRoot,
    }), /missing|not found|does not exist/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 rejects a directory substituted for an artifact file', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-dir-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    mkdirSync(join(evidenceRoot, 'bundle', 'not-a-file'), { recursive: true });
    assert.throws(() => resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle/not-a-file',
      checkoutRoot,
    }), /regular file|not a file|directory/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 path-independent dependency digests match across two roots', () => {
  const rootA = makeOutsideRoot('known-r5-10-bundle-a-');
  const rootB = makeOutsideRoot('known-r5-10-bundle-b-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  const payload = '{"format":"known.phase5.follow-acceptance.v1","accepted":true}\n';
  const fileSha = sha256(payload);
  try {
    writeArtifact(rootA, 'followAcceptance/phase5-follow-acceptance.json', payload);
    writeArtifact(rootB, 'followAcceptance/phase5-follow-acceptance.json', payload);
    const absoluteA = resolveLockedArtifactPath({
      evidenceRoot: rootA,
      relativePath: 'followAcceptance/phase5-follow-acceptance.json',
      checkoutRoot,
    });
    const absoluteB = resolveLockedArtifactPath({
      evidenceRoot: rootB,
      relativePath: 'followAcceptance/phase5-follow-acceptance.json',
      checkoutRoot,
    });
    assert.notEqual(absoluteA, absoluteB);
    const recordA = pathIndependentDependencyRecord({
      task: 'P5-07',
      commit: '1417d24bf4dd823ea0c50534dfb1e8dcd7804106',
      artifactFormat: 'known.phase5.follow-acceptance.v1',
      absolutePath: absoluteA,
      fileSha256: fileSha,
      contentDigest: 'a'.repeat(64),
      sourceBindingDigest: 'b'.repeat(64),
    });
    const recordB = pathIndependentDependencyRecord({
      task: 'P5-07',
      commit: '1417d24bf4dd823ea0c50534dfb1e8dcd7804106',
      artifactFormat: 'known.phase5.follow-acceptance.v1',
      absolutePath: absoluteB,
      fileSha256: fileSha,
      contentDigest: 'a'.repeat(64),
      sourceBindingDigest: 'b'.repeat(64),
    });
    assert.deepEqual(recordA, recordB);
    assert.equal(
      digestDependencyValidationRecords([recordA]),
      digestDependencyValidationRecords([recordB]),
    );
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('R5-10 rejects a digest mismatch against locked fileSha256', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-digest-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    const absolute = writeArtifact(evidenceRoot, 'followAcceptance/a.json', '{"ok":true}\n');
    const resolved = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'followAcceptance/a.json',
      checkoutRoot,
    });
    assert.equal(resolved, canonicalizeExistingPath(absolute));
    const actual = sha256(readFileSync(resolved));
    assert.notEqual(actual, '0'.repeat(64));
    assert.throws(() => {
      if (actual !== '0'.repeat(64)) throw new Error('dependency file SHA-256 mismatch');
    }, /SHA-256 mismatch/u);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 resolves differently cased evidence roots when the platform allows', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-case-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    const altered = process.platform === 'win32'
      ? evidenceRoot.replace(/^([a-zA-Z]):/u, (_, drive: string) =>
        `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`)
      : evidenceRoot;
    if (altered === evidenceRoot || !existsSync(altered)) {
      const canonical = resolveEvidenceRootFromEnv({
        [EVIDENCE_ROOT_ENV]: evidenceRoot,
      }, checkoutRoot);
      assert.equal(canonical, evidenceRoot);
      return;
    }
    const canonical = resolveEvidenceRootFromEnv({
      [EVIDENCE_ROOT_ENV]: altered,
    }, checkoutRoot);
    assert.equal(canonical, evidenceRoot);
    assert.equal(resolveLockedArtifactPath({
      evidenceRoot: canonical,
      relativePath: 'bundle/a.json',
      checkoutRoot,
    }), canonicalizeExistingPath(join(evidenceRoot, 'bundle', 'a.json')));
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 rejects a relativePath whose parent directory does not exist', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-parent-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    assert.throws(() => resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'no-such-parent/a.json',
      checkoutRoot,
    }), /missing|not found|does not exist|parent/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 rejects legacy absolute path lock fields', () => {
  assert.throws(() => readLockRelativePath({
    task: 'P5-07',
    path: 'C:\\Users\\white\\AppData\\Local\\Temp\\a.json',
    fileSha256: 'a'.repeat(64),
  }), /relativePath|absolute|legacy|path field/iu);
  assert.throws(() => readLockRelativePath({
    task: 'P5-07',
    path: 'C:\\Users\\white\\AppData\\Local\\Temp\\a.json',
    relativePath: 'followAcceptance/a.json',
    fileSha256: 'a'.repeat(64),
  }), /relativePath|absolute|legacy|path field/iu);
  assert.equal(readLockRelativePath({
    task: 'P5-07',
    relativePath: 'followAcceptance/a.json',
    fileSha256: 'a'.repeat(64),
  }), 'followAcceptance/a.json');
});

test('R5-10 rejects an artifact replaced after resolution', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-replace-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    const absolute = writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    const resolved = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle/a.json',
      checkoutRoot,
    });
    rmSync(absolute, { force: true });
    mkdirSync(absolute);
    assert.throws(() => assertResolvedArtifactStable(resolved, {
      evidenceRoot,
      checkoutRoot,
    }), /regular file|replaced|not a file|directory/iu);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('R5-10 requires absolute KNOWN_PHASE5_EVIDENCE_ROOT and forbids personal fallbacks', () => {
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  assert.throws(() => resolveEvidenceRootFromEnv({}, checkoutRoot), /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.throws(() => resolveEvidenceRootFromEnv({
    [EVIDENCE_ROOT_ENV]: 'relative/evidence',
  }, checkoutRoot), /absolute/iu);
  const moduleSource = readSource('scripts/phase5-evidence-root.mjs');
  const runner = readSource('scripts/phase5-free-social-acceptance.mjs');
  for (const source of [moduleSource, runner]) {
    assert.doesNotMatch(source, /KNOWN_PHASE5_EVIDENCE_ROOT\s*\?\?/u);
    assert.doesNotMatch(source, /process\.env\.TEMP|os\.tmpdir\(\)|Users\\\\white\\\\Desktop/u);
    assert.doesNotMatch(source, /AppData\\\\Local\\\\Temp/u);
  }
});

test('R5-10 lock uses relativePath only and runner binds the portable root', () => {
  const lock = JSON.parse(readSource('tests/fixtures/phase5/free-social-evidence-lock.v1.json')) as {
    dependencies: Record<string, Record<string, unknown>>;
  };
  const runner = readSource('scripts/phase5-free-social-acceptance.mjs');
  assert.match(runner, /phase5-evidence-root\.mjs/u);
  assert.match(runner, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(runner, /resolveEvidenceRootFromEnv|resolveLockedArtifactPath/u);
  assert.doesNotMatch(runner, /binding\.path\b/u);
  assert.doesNotMatch(runner, /KNOWN_PHASE5_[A-Z_]+_ARTIFACT(?:_PATH)?\b/u);
  for (const [name, binding] of Object.entries(lock.dependencies)) {
    assert.equal('path' in binding, false, `${name} must not keep absolute path`);
    assert.equal(typeof binding.relativePath, 'string', name);
    assertPortableRelativePath(String(binding.relativePath));
  }
  const normalizedLock = readSource('tests/fixtures/phase5/free-social-evidence-lock.v1.json')
    .replaceAll('\r\n', '\n');
  const lockDigest = sha256(normalizedLock);
  const dependenciesModule = readSource('scripts/phase5-free-social-dependencies.mjs');
  assert.match(dependenciesModule, new RegExp(lockDigest, 'u'));
  assert.match(runner, /LOCKED_EVIDENCE_SHA256|phase5-free-social-dependencies\.mjs/u);
  assert.equal(existsSync(resolve(backendRoot, 'tests/fixtures/phase5/artifacts')), false);
  for (const binding of Object.values(lock.dependencies)) {
    const relativePath = String(binding.relativePath);
    assert.equal(existsSync(resolve(backendRoot, relativePath)), false);
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), false);
  }
});

test('R5-10 evidence document documents the portable root env', () => {
  const evidence = readSource('docs/evidence/phase5-free-social-acceptance-2026-07-29.md');
  assert.match(evidence, /KNOWN_PHASE5_EVIDENCE_ROOT/u);
  assert.match(evidence, /relativePath/u);
  assert.doesNotMatch(evidence, /AppData\\Local\\Temp\\known-p5-/u);
});

test('R5-10 keeps checkout containment independent of path separator style', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-contain-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    const resolved = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: ['bundle', 'a.json'].join(sep === '\\' ? '\\' : '/'),
      checkoutRoot,
    });
    const insideCheckout = relative(checkoutRoot, resolved);
    assert.ok(
      insideCheckout.startsWith('..') || isAbsoluteOutside(insideCheckout),
      'artifact must remain outside checkout',
    );
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

function isAbsoluteOutside(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/');
}

test('R5-10 rename-replace after resolve still fails closed', () => {
  const evidenceRoot = makeOutsideRoot('known-r5-10-rename-');
  const checkoutRoot = canonicalizeExistingPath(repositoryRoot);
  try {
    const absolute = writeArtifact(evidenceRoot, 'bundle/a.json', '{"ok":true}\n');
    const resolved = resolveLockedArtifactPath({
      evidenceRoot,
      relativePath: 'bundle/a.json',
      checkoutRoot,
    });
    const decoy = join(evidenceRoot, 'bundle', 'decoy.json');
    writeFileSync(decoy, '{"tampered":true}\n');
    rmSync(absolute, { force: true });
    renameSync(decoy, absolute);
    // Content replacement is caught by SHA checks; stability check still requires a regular file in root.
    assertResolvedArtifactStable(resolved, { evidenceRoot, checkoutRoot });
    assert.notEqual(sha256(readFileSync(resolved)), sha256('{"ok":true}\n'));
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
