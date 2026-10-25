import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkSdkPins, SDK_CONSUMERS } from './check-sdk-pins.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = 'file:../server/vendor/know-n-colp-0.3.0-rc.1.tgz';

function tree({ pins = {}, locks = {}, nodeVersion = '0.3.0-rc.1', files = ['packages/server/vendor/know-n-colp-0.3.0-rc.1.tgz'] } = {}) {
  const json = { 'packages/node/package.json': { version: nodeVersion } };
  for (const root of SDK_CONSUMERS) {
    const spec = pins[root] ?? (root === 'packages/server' ? 'file:vendor/know-n-colp-0.3.0-rc.1.tgz' : vendored);
    json[`${root}/package.json`] = { dependencies: { '@know-n/colp': spec } };
    json[`${root}/package-lock.json`] = { packages: { 'node_modules/@know-n/colp': locks[root]
      ?? { version: '0.3.0-rc.1', resolved: spec, integrity: 'sha512-same' } } };
  }
  return { read: (path) => json[path], exists: (path) => files.includes(path) };
}

test('the three consumers pass when they lock one current vendored build', () => {
  assert.deepEqual(checkSdkPins(tree()), []);
});

test('a consumer on another release, a stale tarball or a different integrity fails', () => {
  assert.match(checkSdkPins(tree({ pins: { 'packages/web': '0.1.2' },
    locks: { 'packages/web': { version: '0.1.2', resolved: 'https://registry.npmjs.org/x', integrity: 'sha512-old' } } })).join('\n'),
  /pins differ[\s\S]*integrity differs/u);
  assert.match(checkSdkPins(tree({ nodeVersion: '0.3.0-rc.2' })).join('\n'), /not the current packages\/node build 0\.3\.0-rc\.2/u);
  assert.match(checkSdkPins(tree({ locks: { 'packages/extension':
    { version: '0.3.0-rc.1', resolved: vendored, integrity: 'sha512-other' } } })).join('\n'), /integrity differs/u);
  assert.match(checkSdkPins(tree({ files: [] })).join('\n'), /does not exist/u);
});

test('the repository consumers share one @know-n/colp build', () => {
  assert.deepEqual(checkSdkPins({
    read: (path) => JSON.parse(readFileSync(join(repository, path), 'utf8')),
    exists: (path) => existsSync(join(repository, path)),
  }), []);
});

test('published consumers must pin the current source version exactly', () => {
  const published = (version, nodeVersion = '0.3.0') => tree({ nodeVersion,
    pins: Object.fromEntries(SDK_CONSUMERS.map(root => [root, version])),
    locks: Object.fromEntries(SDK_CONSUMERS.map(root => [root, {
      version, resolved: `https://registry.npmjs.org/@know-n/colp/-/colp-${version}.tgz`, integrity: 'sha512-same',
    }])),
  });
  assert.deepEqual(checkSdkPins(published('0.3.0')), []);
  assert.match(checkSdkPins(published('0.2.1')).join('\n'), /not the current packages\/node version 0\.3\.0/u);
  assert.match(checkSdkPins(published('^0.3.0')).join('\n'), /not the current packages\/node version/u);
});
