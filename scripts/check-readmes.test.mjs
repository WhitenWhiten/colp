import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkReadmes } from './check-readmes.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const switcher = '<a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>';

/** One README; `up` reaches the repository root from its folder. */
function readme({ up = '', image = 'hero.en.png', pin = '0.3.0', diagram = 'GET / → the Manifest', install = 'npm install', heading = '## Install', guide = true } = {}) {
  return [`# COLP`, switcher, `<img src="${up}docs/assets/screens/${image}">`, heading, '```bash', `${install} @know-n/colp@${pin}`, '```',
    '```text', diagram, '```', guide ? `See [the guide](${up}deploy/INSTALL.md).` : 'See the guide.', ''].join('\n');
}

function tree(overrides = {}) {
  const files = {
    'packages/node/package.json': JSON.stringify({ version: '0.3.0' }),
    'packages/conformance/package.json': JSON.stringify({ version: '0.1.1' }),
    'README.md': readme(),
    'README.zh-CN.md': readme({ image: 'hero.zh-CN.png', diagram: 'GET / → Manifest' }),
    'README.ja.md': readme(),
    'protocol/README.md': readme({ up: '../' }),
    'protocol/README.zh-CN.md': readme({ up: '../', image: 'hero.zh-CN.png' }),
    'protocol/README.ja.md': readme({ up: '../' }),
    'deploy/INSTALL.md': '# Install\n',
    ...overrides,
  };
  const present = new Set([...Object.keys(files), 'docs/assets/screens/hero.en.png', 'docs/assets/screens/hero.zh-CN.png']);
  return {
    read: (path) => { if (!(path in files)) throw new Error(`unexpected read ${path}`); return files[path]; },
    exists: (path) => present.has(path),
  };
}

test('the repository READMEs agree with each other and the packages', () => {
  assert.deepEqual(checkReadmes({
    read: (path) => readFileSync(join(repository, path), 'utf8'),
    exists: (path) => existsSync(join(repository, path)),
  }), []);
});

test('consistent translations pass, and a text diagram may be translated', () => {
  assert.deepEqual(checkReadmes(tree()), []);
});

test('a pinned install command must name the package version', () => {
  assert.deepEqual(checkReadmes(tree({ 'README.ja.md': readme({ pin: '0.1.1' }) })), [
    'README.ja.md: pins @know-n/colp@0.1.1, but the package is 0.3.0',
    'README.ja.md: commands differ from README.md',
  ]);
});

test('a translation keeps the original commands, sections and links', () => {
  assert.deepEqual(checkReadmes(tree({ 'README.ja.md': readme({ install: 'npm i', heading: '### Install', guide: false }) })), [
    'README.ja.md: commands differ from README.md',
    'README.ja.md: sections differ from README.md',
    'README.ja.md: missing link deploy/INSTALL.md from README.md',
  ]);
});

test('every README links to the other languages', () => {
  assert.deepEqual(checkReadmes(tree({ 'README.ja.md': readme().replace(' · <a href="README.zh-CN.md">简体中文</a>', '') })),
    ['README.ja.md: does not link to README.zh-CN.md']);
});

test('a README shows its own language when a capture exists, and never another language', () => {
  assert.deepEqual(checkReadmes(tree({ 'README.zh-CN.md': readme() })),
    ['README.zh-CN.md: shows docs/assets/screens/hero.en.png, but docs/assets/screens/hero.zh-CN.png exists']);
  assert.deepEqual(checkReadmes(tree({ 'README.ja.md': readme({ image: 'hero.zh-CN.png' }) })),
    ['README.ja.md: docs/assets/screens/hero.zh-CN.png is another language\'s image']);
});

test('local links and images must exist', () => {
  assert.deepEqual(checkReadmes(tree({ 'protocol/README.ja.md': readme({ up: '../', image: 'gone.en.png' }) })),
    ['protocol/README.ja.md: ../docs/assets/screens/gone.en.png does not exist',
      'protocol/README.ja.md: missing link ../docs/assets/screens/hero.png from protocol/README.md',
      'protocol/README.ja.md: links ../docs/assets/screens/gone.png, which protocol/README.md does not']);
});
