import { describe, expect, it } from 'vitest';
const { artifactDigests, assertAcceptedArtifact, assertReleaseMatrix, releaseReadiness } = await import(
  new URL('../../scripts/lib/release-artifact-contract.mjs', import.meta.url).href
) as {
  artifactDigests(bytes: Uint8Array): { sha256: string; integrity: string };
  assertAcceptedArtifact(bytes: Uint8Array, record: unknown): unknown;
  assertReleaseMatrix(records: unknown[], record: unknown): void;
  releaseReadiness(manifest: unknown, hasLicense: boolean): { errors: string[]; warnings: string[] };
};

function acceptedFixture() {
  const bytes = new TextEncoder().encode('test-only artifact bytes');
  const digest = artifactDigests(bytes);
  const sourceRevision = 'a'.repeat(40);
  const cleanConsumer = { sha256: digest.sha256, packageName: '@know-n/colp',
    packageVersion: '0.1.0', skipLibCheck: false, entryCount: 18, node: 'v22.16.0', platform: 'linux' };
  return { bytes, record: { formatVersion: 1, sourceRevision, packageName: cleanConsumer.packageName,
    packageVersion: cleanConsumer.packageVersion, artifact: digest,
    npmCheck: { passed: true, sourceRevision }, cleanConsumer } };
}

describe('Publish exactly the accepted artifact', () => {
  it('rejects changed bytes or a consumer record for other bytes', () => {
    const { bytes, record } = acceptedFixture();
    expect(() => assertAcceptedArtifact(bytes, record)).not.toThrow();
    expect(() => assertAcceptedArtifact(new TextEncoder().encode('changed'), record)).toThrow();
    expect(() => assertAcceptedArtifact(bytes, { ...record, cleanConsumer: { ...record.cleanConsumer, sha256: 'different' } })).toThrow();
  });
  it('rejects an unverified source or weakened declaration check', () => {
    const { bytes, record } = acceptedFixture();
    expect(() => assertAcceptedArtifact(bytes, { ...record, npmCheck: { passed: false } })).toThrow();
    expect(() => assertAcceptedArtifact(bytes, { ...record, cleanConsumer: { ...record.cleanConsumer, skipLibCheck: true } })).toThrow();
  });
  it('requires the existing local OS/Node matrix for the same bytes', () => {
    const { record } = acceptedFixture();
    const matrix = ['linux', 'win32', 'darwin'].flatMap(platform => ['22', '24'].map(major => ({
      ...record.cleanConsumer, platform, node: `v${major}.0.0`,
    })));
    expect(() => assertReleaseMatrix(matrix, record)).not.toThrow();
    expect(() => assertReleaseMatrix(matrix.slice(1), record)).toThrow('Missing');
    expect(() => assertReleaseMatrix(matrix.map(value => ({ ...value, sha256: 'other' })), record)).toThrow();
  });
  it('distinguishes publication blockers from optional project metadata', () => {
    const ready = releaseReadiness({ name: '@know-n/colp', version: '0.1.0', license: 'MIT' }, true);
    expect(ready.errors).toEqual([]);
    expect(ready.warnings).toHaveLength(2);
    expect(releaseReadiness({ name: '@know-n/colp', private: true, version: '0.0.0-development' }, false).errors.length).toBeGreaterThan(0);
  });
});
