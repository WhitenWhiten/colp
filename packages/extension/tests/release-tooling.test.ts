import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

function check(version: string, options: {
  tag?: string; numeric?: string; display?: string; changelog?: string; packageOnly?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'colp-extension-release-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const script of ['release-version.mjs', 'check-release-tag.mjs', 'package.mjs']) {
      copyFileSync(resolve(import.meta.dirname, '../scripts', script), join(root, 'scripts', script));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, 'manifest.base.json'), JSON.stringify({
      version: options.numeric ?? version.replace('-rc.', '.'),
      ...(options.display === undefined ? {} : { version_name: options.display }),
    }));
    writeFileSync(join(root, 'CHANGELOG.md'), options.changelog
      ?? `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-10-24\n\nRelease notes.\n\n## [0.0.1]\n\nOlder notes.\n`);
    return spawnSync(process.execPath, options.packageOnly
      ? [join(root, 'scripts/package.mjs')]
      : [join(root, 'scripts/check-release-tag.mjs'), options.tag ?? `extension-v${version}`],
    { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  { version: '0.1.0', display: undefined },
  { version: '0.1.0-rc.1', display: '0.1.0-rc.1' },
  { version: '0.1.0-rc.65534', display: '0.1.0-rc.65534' },
])('extracts only the matching release section for $version', ({ version, display }) => {
  const result = check(version, { display });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`## [${version}] - 2026-10-24\n\nRelease notes.\n`);
});

test('rejects a tag that differs from the package version', () => {
  const result = check('0.1.0-rc.1', { tag: 'extension-v0.1.0-rc.2' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('package.json is 0.1.0-rc.1, tag is 0.1.0-rc.2');
});

test.each([undefined, '0.1.0-rc.2'])('rejects a missing or stale RC display version: %s', display => {
  const result = check('0.1.0-rc.1', { display });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('display version must match');
});

test.each(['0.1.2', '0.1.0', '0.1.0.2', '0.1.0-rc.1'])('rejects an incorrect numeric manifest version: %s', numeric => {
  const result = check('0.1.0-rc.1', { numeric, display: '0.1.0-rc.1' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('expected 0.1.0.1');
});

test.each(['0.1.0-rc.0', '0.1.0-rc.01', '0.1.0-rc.65535', '0.1.0-beta.1', '01.1.0', '65536.1.0', '0.0.0'])('rejects unsupported release version %s', version => {
  const result = check(version, { display: version });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('version must be X.Y.Z or X.Y.Z-rc.N');
});

test('accepts a final release numeric revision that upgrades every RC', () => {
  const result = check('0.1.0', { numeric: '0.1.0.65535', display: '0.1.0' });
  expect(result.status, result.stderr).toBe(0);
});

test.each(['## [Unreleased]\n', '## [0.1.0]\n\n## [0.1.0]\n'])('rejects missing or duplicate release notes', changelog => {
  const result = check('0.1.0', { changelog });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('needs exactly one ## [0.1.0] section');
});

test('packaging rejects a stale RC display version before building', () => {
  const result = check('0.1.0-rc.1', { display: '0.1.0-rc.2', packageOnly: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('display version must match');
});
