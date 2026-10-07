/**
 * V4A-02 secret-scan fixture classification test (plan §4 V4A-02): pins the
 * precise, local, auditable fixture-annotation contract implemented in
 * scripts/scan-secrets.mjs. Only a single synthetic literal named by a
 * same-line, immediately-adjacent `secret-scan: allow '<literal>'` comment is
 * exempted. Unannotated literals, drifted/duplicated/over-wide annotations,
 * multiple literals on one line, real AWS/R2 credential shapes, production
 * directories, CRLF files, case variants and generated-looking output all
 * keep failing; the six phase4a marker locations pass the repo scan.
 *
 * The fixture content is assembled at runtime (keys, values and the annotation
 * keyword are injected through helpers) so the scanner's own repo scan never
 * sees a real credential-shaped assignment or a real annotation inside this
 * test file's string literals.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const scannerPath = resolve(backendRoot, 'scripts/scan-secrets.mjs');

// Assembled at runtime so this test file never contains the annotation
// keyword literally (a raw annotation inside a string would look like a
// drifted annotation to the scanner's own repo scan).
const allowMarker = 'secret-scan: allow';

// Real-shaped credentials assembled in pieces so no single source line of
// this test file contains a full real credential shape (which must never be
// exemptable, not even in this test file).
const awsSecretAccessKey = 'wJalrXUtnFEMI' + '/K7MDENG' + '/bPxRfiCY' + 'EXAMPLEKEY';
const r2SecretAccessKey = '0123456789abcdef' + '0123456789abcdef' + '0123456789abcdef' + '0123456789abcdef';
const awsAccessKeyId = 'AKIA' + 'IOSFODNN7EXAMPLE';

function fixtureLine(key: string, value: string, rest = ''): string {
  return `${key} = '${value}'${rest}\n`;
}

function twoAssignments(
  keyA: string, valueA: string, keyB: string, valueB: string, annotationValue: string,
): string {
  return `${keyA} = '${valueA}', ${keyB} = '${valueB}' // ${allowMarker} '${annotationValue}'\n`;
}

function runScanner(root: string) {
  return spawnSync(process.execPath, [scannerPath, '--root', root], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
}

function withFixtureDir(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'phase4a-secret-scan-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('V4A-02 repo scan classifies the six phase4a synthetic marker locations', () => {
  const result = runScanner(backendRoot);
  assert.equal(result.status, 0, result.stderr);
  for (const location of [
    'scripts/evidence/phase4a-r02-controls.ts:99',
    'scripts/evidence/phase4a-r02-controls.ts:103',
    'tests/unit/phase4a/phase4a-r02-oversize-control.test.ts:131',
    'tests/unit/phase4a/phase4a-r02-oversize-control.test.ts:132',
    'tests/unit/phase4a/phase4a-r02-provider-failure-control.test.ts:97',
    'tests/unit/phase4a/phase4a-r02-provider-failure-control.test.ts:98',
  ]) {
    assert.ok(!result.stderr.includes(location), `location must be classified: ${location}`);
  }
  assert.doesNotMatch(result.stderr, /secret-scan annotation/, 'no drifted or malformed annotations allowed');
  assert.match(result.stdout, /secret scan: ok/);
});

test('V4A-02 unannotated synthetic markers still fail', () => {
  withFixtureDir({
    'probe.txt': fixtureLine('password', 'r02-fault-write-secret-marker-0001'),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /probe\.txt:1/);
  });
});

test('V4A-02 drifted annotation (annotation on another line) exempts nothing', () => {
  withFixtureDir({
    'drift.txt': `// ${allowMarker} 'marker-drift-0001'\n${fixtureLine('password', 'marker-drift-0001')}`,
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /drift\.txt:2/);
  });
});

test('V4A-02 over-wide annotations exempt nothing', () => {
  withFixtureDir({
    'bare.txt': fixtureLine('password', 'marker-bare-0001', ` // ${allowMarker}`),
    'wrong-literal.txt': fixtureLine('password', 'marker-wrong-0001', ` // ${allowMarker} 'marker-other-0001'`),
    'duplicated.txt': fixtureLine('password', 'marker-dup-0001', ` // ${allowMarker} 'marker-dup-0001' // ${allowMarker} 'marker-dup-0001'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /bare\.txt:1/);
    assert.match(result.stderr, /wrong-literal\.txt:1/);
    assert.match(result.stderr, /duplicated\.txt:1/);
  });
});

test('V4A-02 same-line multiple literals: only the adjacent named literal is exempted', () => {
  withFixtureDir({
    'adjacent.txt': twoAssignments('password', 'marker-a-0001', 'api_key', 'marker-b-0001', 'marker-b-0001'),
    'non-adjacent.txt': twoAssignments('password', 'marker-y-0001', 'api_key', 'marker-z-0001', 'marker-y-0001'),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /adjacent\.txt:1/, 'non-named literal on the same line must stay reported');
    assert.match(result.stderr, /non-adjacent\.txt:1/, 'non-adjacent annotation must exempt nothing');
  });
});

test('V4A-02 case-variant annotation does not exempt', () => {
  withFixtureDir({
    'probe.txt': fixtureLine('password', 'r02-fault-write-secret-marker-0001', ` // ${allowMarker} 'R02-FAULT-WRITE-SECRET-MARKER-0001'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /probe\.txt:1/);
  });
});

test('V4A-02 real AWS/R2 credential shapes fail even with a valid annotation', () => {
  withFixtureDir({
    'aws-secret.txt': fixtureLine('secret_access_key', awsSecretAccessKey, ` // ${allowMarker} '` + awsSecretAccessKey + `'`),
    'aws-access-key-id.txt': fixtureLine('access_key_id', awsAccessKeyId, ` // ${allowMarker} '` + awsAccessKeyId + `'`),
    'r2-secret.txt': fixtureLine('secret_access_key', r2SecretAccessKey, ` // ${allowMarker} '` + r2SecretAccessKey + `'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /aws-secret\.txt:1/);
    assert.match(result.stderr, /aws-access-key-id\.txt:1/);
    assert.match(result.stderr, /r2-secret\.txt:1/);
  });
});

test('V4A-02 production-directory secrets fail even with an annotation', () => {
  withFixtureDir({
    'src/modules/auth/credentials.ts': fixtureLine('secretAccessKey', awsSecretAccessKey, ` // ${allowMarker} '` + awsSecretAccessKey + `'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /src\/modules\/auth\/credentials\.ts:1/);
  });
});

test('V4A-02 CRLF files: annotated synthetic passes, unannotated fails', () => {
  withFixtureDir({
    'annotated-crlf.txt': fixtureLine('password', 'marker-crlf-0001', ` // ${allowMarker} 'marker-crlf-0001'`).replace('\n', '\r\n'),
    'unannotated-crlf.txt': fixtureLine('api_key', 'marker-crlf-0002').replace('\n', '\r\n'),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /(^|\n)annotated-crlf\.txt/, 'annotated CRLF line must pass');
    assert.match(result.stderr, /unannotated-crlf\.txt:1/);
  });
});

test('V4A-02 copied annotations are not honored', () => {
  withFixtureDir({
    'probe.txt': fixtureLine('password', 'marker-copy-0001', ` // ${allowMarker} 'marker-copy-0001'`)
      + fixtureLine('api_key', 'marker-copy-0002', ` // ${allowMarker} 'marker-copy-0001'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /probe\.txt:2/, 'copied annotation must not exempt a different literal');
  });
});

test('V4A-02 generated-looking output is still scanned', () => {
  withFixtureDir({
    'generated-output/probe.txt': `// Code generated by tool. DO NOT EDIT.\n${fixtureLine('password', 'marker-generated-0001')}`,
  }, (dir) => {
    const result = runScanner(dir);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /probe\.txt:2/);
  });
});

test('V4A-02 valid adjacent annotation exempts exactly one synthetic literal', () => {
  withFixtureDir({
    'ok.txt': fixtureLine('password', 'marker-ok-0001', ` // ${allowMarker} 'marker-ok-0001'`),
    'ok-double-quote.txt': fixtureLine('api_key', 'marker-ok-0002', ` // ${allowMarker} "marker-ok-0002"`),
    'ok-block.txt': fixtureLine('password', 'synthetic-block-marker-0003-abcdefghij', ` /* ${allowMarker} 'synthetic-block-marker-0003-abcdefghij' */`),
    'ok-hash.txt': fixtureLine('password', 'marker-ok-0004', ` # ${allowMarker} 'marker-ok-0004'`),
    'ok-high-entropy.txt': fixtureLine('SECRET_VALUE', 'synthetic-marker-value-0001-abcdefghijklmnopqrst', ` // ${allowMarker} 'synthetic-marker-value-0001-abcdefghijklmnopqrst'`),
  }, (dir) => {
    const result = runScanner(dir);
    assert.equal(result.status, 0, result.stderr);
  });
});
