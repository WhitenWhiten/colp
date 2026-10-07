import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectCandidateTarball, makeConsumerTreeReadable } from '../clean-tarball-consumer.mjs';
import { cleanConsumerImage, cleanConsumerSandboxArguments, runCleanConsumerNode } from '../lib/clean-consumer-sandbox.mjs';
import { isolatedProcessEnvironment, runNpm } from '../lib/npm-command.mjs';

const testRoot = process.env.TMPDIR ?? process.cwd();

function tarEntry(path, body, type = '0') {
  const payload = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(payload.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function tarGzip(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('candidate tarball inspection validates identity and bounds registry dependencies', async () => {
  const manifest = JSON.stringify({
    name: '@know-n/colp',
    version: '0.1.0',
    dependencies: { ajv: '^8.20.0' },
  });
  const info = await inspectCandidateTarball(
    tarGzip([tarEntry('package/package.json', manifest), tarEntry('package/dist/index.js', 'export {};')]),
    '@know-n/colp',
    '0.1.0',
  );
  assert.equal(info.manifest.name, '@know-n/colp');
  assert.equal(info.entries, 2);
  assert.ok(info.expandedBytes >= 1024);

  await assert.rejects(
    inspectCandidateTarball(
      tarGzip([tarEntry('package/package.json', JSON.stringify({
        name: '@know-n/colp', version: '0.1.0', dependencies: { evil: 'https://attacker.invalid/pkg.tgz' },
      }))]),
      '@know-n/colp',
      '0.1.0',
    ),
    /non-registry source/u,
  );
  for (const spec of [
    'foo@https://attacker.invalid/pkg.tgz',
    'github:user/repo',
    'user/repo',
    'gitlab:user/repo',
    'bitbucket:user/repo',
    'gist:user/id',
    '../local',
    './local',
    'npm:@scope/pkg@https://attacker.invalid/pkg.tgz',
  ]) {
    await assert.rejects(
      inspectCandidateTarball(
        tarGzip([tarEntry('package/package.json', JSON.stringify({
          name: '@know-n/colp', version: '0.1.0', dependencies: { evil: spec },
        }))]),
        '@know-n/colp',
        '0.1.0',
      ),
      /non-registry source/u,
      `dependency spec ${spec} must be rejected`,
    );
  }
  await assert.rejects(
    inspectCandidateTarball(
      tarGzip([tarEntry('package/package.json', manifest), tarEntry('package/../escape.js', 'escape')]),
      '@know-n/colp',
      '0.1.0',
    ),
    /invalid package path/u,
  );
  await assert.rejects(
    inspectCandidateTarball(
      tarGzip([tarEntry('package/package.json', manifest), tarEntry('package/link', '', '2')]),
      '@know-n/colp',
      '0.1.0',
    ),
    /link or unsupported/u,
  );
  const missingEndBlocks = gzipSync(Buffer.concat([tarEntry('package/package.json', manifest)]));
  await assert.rejects(
    inspectCandidateTarball(missingEndBlocks, '@know-n/colp', '0.1.0'),
    /end-of-archive/u,
  );
});

test('trusted npm commands retain authentication while artifact installs use an isolated environment', async () => {
  const root = await mkdtemp(join(testRoot, '.colp-npm-environment-'));
  const names = ['npm_execpath', 'COLP_TEST_SECRET'];
  const previous = names.map(name => [name, process.env[name]]);
  try {
    const cli = join(root, 'npm-cli.js');
    await writeFile(cli, 'process.stdout.write(process.env.COLP_TEST_SECRET ?? "absent")');
    process.env.npm_execpath = cli;
    process.env.COLP_TEST_SECRET = 'synthetic-authentication';
    assert.equal((await runNpm(['publish'], root)).stdout, 'synthetic-authentication');
    assert.equal((await runNpm(['install'], root, { env: isolatedProcessEnvironment() })).stdout, 'absent');
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox command has no network, writable checkout, host env, or daemon socket mount', () => {
  const args = cleanConsumerSandboxArguments('/tmp/consumer', ['probe.mjs'], 'colp-clean-1234');
  for (const required of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--pids-limit=64', '--memory=512m']) {
    assert.ok(args.includes(required), required);
  }
  assert.deepEqual(args.filter(arg => arg.startsWith('type=bind,')), ['type=bind,source=/tmp/consumer,target=/work,readonly']);
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.some(arg => arg.includes('docker.sock')));
  assert.throws(() => cleanConsumerSandboxArguments('/tmp/a,b', [], 'colp-clean-1234'));
  const compiler = cleanConsumerSandboxArguments('/tmp/consumer', ['node_modules/typescript/bin/tsc'], 'colp-clean-1234', { compiler: true });
  for (const required of ['--memory=1g', '--memory-swap=1g', '--max-old-space-size=768', '--network=none', '--read-only']) {
    assert.ok(compiler.includes(required), required);
  }
  assert.match(cleanConsumerImage(), /^node@sha256:[a-f0-9]{64}$/u);
  const installer = cleanConsumerSandboxArguments('/tmp/consumer', ['.colp-install.mjs'], 'colp-clean-1234', {
    writable: true,
    npmCache: '/var/cache/npm',
  });
  assert.ok(installer.includes('type=bind,source=/tmp/consumer,target=/work'));
  assert.ok(!installer.some(arg => arg === 'type=bind,source=/tmp/consumer,target=/work,readonly'));
  assert.ok(installer.includes('type=bind,source=/var/cache/npm,target=/npm-cache,readonly'));
  assert.ok(installer.includes('--env=npm_config_cache=/npm-cache'));
});

test('child environment drops synthetic credentials, hooks, and Docker remote settings', () => {
  const names = ['COLP_TEST_SECRET', 'NODE_OPTIONS', 'NODE_PATH', 'DOCKER_HOST', 'HTTPS_PROXY', 'npm_config_registry'];
  const previous = names.map(name => [name, process.env[name]]);
  try {
    for (const name of names) process.env[name] = 'synthetic-test-value';
    const env = isolatedProcessEnvironment('/tmp/clean-home');
    for (const name of names) assert.equal(env[name], undefined);
    assert.equal(env.HOME, '/tmp/clean-home');
    assert.equal(env.TMPDIR, '/tmp/clean-home/npm-tmp');
    assert.equal(env.TMP, env.TMPDIR);
    assert.equal(env.TEMP, env.TMPDIR);
    assert.equal(env.npm_config_userconfig, '/tmp/clean-home/user.npmrc');
    assert.equal(env.npm_config_ignore_scripts, 'true');
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('consumer permission normalization does not follow symlinks', async () => {
  const root = await mkdtemp(join(testRoot, '.colp-permissions-'));
  const external = await mkdtemp(join(testRoot, '.colp-external-'));
  const externalFile = join(external, 'outside.txt');
  const externalDirectory = join(external, 'outside-directory');
  try {
    await mkdir(join(root, 'node_modules'), { mode: 0o700 });
    await writeFile(join(root, 'node_modules', 'entry.js'), 'export {}', { mode: 0o600 });
    await writeFile(externalFile, 'outside', { mode: 0o600 });
    await mkdir(externalDirectory, { mode: 0o700 });
    await writeFile(join(externalDirectory, 'secret'), 'outside directory', { mode: 0o600 });
    await symlink(externalFile, join(root, 'file-link'));
    await symlink(externalDirectory, join(root, 'directory-link'));

    await makeConsumerTreeReadable(root);

    assert.ok([0o700, 0o755].includes((await stat(join(root, 'node_modules'))).mode & 0o777));
    assert.ok([0o600, 0o644].includes((await stat(join(root, 'node_modules', 'entry.js'))).mode & 0o777));
    assert.equal((await lstat(join(root, 'file-link'))).isSymbolicLink(), true);
    assert.equal((await stat(externalFile)).mode & 0o777, 0o600);
    assert.equal((await stat(externalDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(externalDirectory, 'secret'))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('consumer permission normalization rejects shared regular files', async () => {
  const root = await mkdtemp(join(testRoot, '.colp-hardlink-'));
  const external = await mkdtemp(join(testRoot, '.colp-hardlink-external-'));
  const externalFile = join(external, 'shared.txt');
  try {
    await writeFile(externalFile, 'shared', { mode: 0o600 });
    await link(externalFile, join(root, 'shared.txt'));
    await assert.rejects(makeConsumerTreeReadable(root), /shared package file/u);
    assert.equal((await stat(externalFile)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('missing Docker fails closed instead of executing the probe on the host', async () => {
  const root = await mkdtemp(join(testRoot, '.colp-no-docker-'));
  const previousPath = process.env.PATH;
  const previousTmpdir = process.env.TMPDIR;
  try {
    await writeFile(join(root, 'probe.mjs'), 'process.stdout.write("host-executed")');
    // Keep the helper's temporary Docker config inside this test directory and
    // make command lookup deterministic even on machines that have Docker.
    process.env.TMPDIR = root;
    process.env.PATH = join(root, 'empty-bin');
    await assert.rejects(
      runCleanConsumerNode(root, ['probe.mjs']),
      /Isolated clean-tarball verification failed/u,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('actual candidate cannot read host-only fixtures, inherit secrets, write its mount, or use egress',
  { skip: process.env.COLP_TEST_DOCKER_SANDBOX !== '1', timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'colp-sandbox-regression-'));
    const consumer = join(root, 'consumer');
    const secret = join(root, 'host-only.txt');
    const original = process.env.COLP_TEST_SECRET;
    try {
      await mkdir(consumer);
      await writeFile(secret, 'synthetic-host-only-fixture');
      process.env.COLP_TEST_SECRET = 'synthetic-parent-env';
      await writeFile(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
assert.equal(process.env.COLP_TEST_SECRET, undefined);
await assert.rejects(readFile(${JSON.stringify(secret)}));
await assert.rejects(writeFile('/work/forbidden.txt', 'test'));
await assert.rejects(fetch('https://example.com', { signal: AbortSignal.timeout(1000) }));
console.log('isolated');
`);
      const result = await runCleanConsumerNode(consumer, ['probe.mjs']);
      assert.equal(result.stdout.trim(), 'isolated');
      assert.equal(await readFile(secret, 'utf8'), 'synthetic-host-only-fixture');
    } finally {
      if (original === undefined) delete process.env.COLP_TEST_SECRET; else process.env.COLP_TEST_SECRET = original;
      await rm(root, { recursive: true, force: true });
    }
  });
