import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

const entrypoint = readFileSync(new URL('../../../docker-entrypoint.sh', import.meta.url), 'utf8');

test('upgrading the web volume preserves lazy assets used by open tabs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'colp-web-upgrade-'));
  const source = join(directory, 'image');
  const target = join(directory, 'volume');
  try {
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(target, 'assets'), { recursive: true });
    writeFileSync(join(source, 'assets/new.css'), '.library-desk { display: grid }');
    writeFileSync(join(source, 'index.html'), '<link href="/assets/new.css">');
    writeFileSync(join(source, 'robots.txt'), 'Disallow: /');
    writeFileSync(join(target, 'assets/old.css'), 'old stylesheet');
    writeFileSync(join(target, 'index.html'), 'previous index');
    writeFileSync(join(directory, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    const script = join(directory, 'entrypoint.sh');
    writeFileSync(script, entrypoint.replaceAll('/opt/colp-web', source).replaceAll('/srv/web', target));
    const result = spawnSync('sh', [script, 'echo', 'started'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'started');
    assert.equal(readFileSync(join(target, 'assets/old.css'), 'utf8'), 'old stylesheet');
    assert.equal(readFileSync(join(target, 'assets/new.css'), 'utf8'), '.library-desk { display: grid }');
    assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), '<link href="/assets/new.css">');
    assert.equal(readFileSync(join(target, 'robots.txt'), 'utf8'), 'Disallow: /');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
