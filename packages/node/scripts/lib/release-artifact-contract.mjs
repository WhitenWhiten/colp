import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function releaseReadiness(manifest, hasLicenseFile) {
  const errors = [];
  const warnings = [];
  if (manifest.private === true) errors.push('private:true intentionally blocks registry publication.');
  if (manifest.private !== undefined && typeof manifest.private !== 'boolean') errors.push('private must be boolean.');
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) errors.push('A package name is required.');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)
    || manifest.version === '0.0.0-development') errors.push('Record an intentional release version.');
  if (typeof manifest.license !== 'string' || manifest.license.trim() === '' || manifest.license === 'UNLICENSED' || !hasLicenseFile) {
    errors.push('Record the owner-approved license and include its LICENSE file.');
  }
  if (!manifest.repository) warnings.push('Add the final standalone repository metadata.');
  if (!manifest.bugs) warnings.push('Add the intended issue-reporting location.');
  return { errors, warnings };
}

export function artifactDigests(bytes) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
}

export function assertAcceptedArtifact(bytes, record) {
  assert.equal(record?.formatVersion, 1, 'Unsupported release record.');
  assert.match(record.sourceRevision, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
  const digest = artifactDigests(bytes);
  assert.equal(record.artifact?.sha256, digest.sha256, 'The tarball differs from the accepted artifact.');
  assert.equal(record.artifact?.integrity, digest.integrity, 'Artifact integrity mismatch.');
  assert.equal(record.npmCheck?.passed, true, 'The exact source must pass npm run check.');
  assert.equal(record.npmCheck?.sourceRevision, record.sourceRevision, 'Source-check revision mismatch.');
  const consumer = record.cleanConsumer;
  assert.equal(consumer?.sha256, digest.sha256, 'Clean consumer tested different bytes.');
  assert.equal(consumer?.packageName, record.packageName);
  assert.equal(consumer?.packageVersion, record.packageVersion);
  assert.equal(consumer?.skipLibCheck, false, 'Strict consumer declaration verification is required.');
  assert.ok(consumer?.entryCount >= 16, 'Consumer did not cover the runtime surface.');
  return digest;
}

export function assertReleaseMatrix(records, artifact) {
  assert.ok(Array.isArray(records), 'Local matrix records are required.');
  for (const platform of ['linux', 'win32', 'darwin']) for (const major of ['22', '24']) {
    const record = records.find(candidate => candidate.platform === platform
      && typeof candidate.node === 'string' && candidate.node.replace(/^v/u, '').split('.')[0] === major);
    assert.ok(record, `Missing local ${platform} / Node ${major} consumer acceptance.`);
    assert.equal(record.sha256, artifact.artifact.sha256, 'Local matrix tested another tarball.');
    assert.equal(record.packageName, artifact.packageName);
    assert.equal(record.packageVersion, artifact.packageVersion);
    assert.equal(record.skipLibCheck, false);
    assert.ok(record.entryCount >= 16);
  }
}
