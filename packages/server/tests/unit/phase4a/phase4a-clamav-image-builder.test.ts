import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  buildClamavImage,
  buildDockerArgv,
  parseBuildArguments,
  parseClamavBuildEvidence,
  resolveUniqueRepoDigest,
  validateBaseImage,
} from '../../../scripts/build-phase4a-clamav-image.mjs';

const BASE = `clamav/clamav@sha256:${'a'.repeat(64)}`;
const LOCAL = 'known-clamav:local-validation';
const PUSH = 'registry.example/known-clamav:rollout-20260726';
const VERSION = 'ClamAV 1.4.3/27809/Fri Jul 25 04:31:20 2026';

describe('P4A-I01 ClamAV image build pipeline', () => {
  test('defines a numeric non-root offline scanner runtime with no credential material', async () => {
    const dockerfile = await readFile(resolve('deploy/clamav/Dockerfile'), 'utf8');
    assert.match(dockerfile, /^ARG CLAMAV_BASE_IMAGE$/mu);
    assert.match(dockerfile, /^RUN freshclam --verbose$/mu);
    assert.match(dockerfile, /^USER 1000:1000$/mu);
    assert.match(dockerfile, /^ENTRYPOINT \["clamscan"\]$/mu);
    assert.match(dockerfile, /^CMD \["--version"\]$/mu);
    assert.doesNotMatch(dockerfile, /(?:secret|token|password|credential|docker\.sock)/iu);
  });
  test('requires an exact official base digest and explicit output tag', () => {
    assert.deepEqual(parseBuildArguments(['--base-image', BASE, '--tag', LOCAL]), {
      baseImage: BASE, tag: LOCAL, push: false,
    });
    assert.throws(() => validateBaseImage('clamav/clamav:1.4'), /clamav_base_digest_required/);
    assert.throws(() => validateBaseImage('clamav/clamav:latest'), /clamav_base_digest_required/);
    assert.throws(() => validateBaseImage(`example/clamav@sha256:${'a'.repeat(64)}`), /clamav_base_repository_invalid/);
    assert.throws(() => parseBuildArguments(['--base-image', BASE]), /image_tag_required/);
    assert.throws(() => parseBuildArguments(['--base-image', BASE, '--tag', LOCAL, '--secret', 'x']), /image_builder_argument_unknown/);
  });

  test('uses Docker argv without a shell and defaults to no external push', () => {
    const plan = buildDockerArgv({ baseImage: BASE, tag: LOCAL, push: false }, 'known-clamav-build-deadbeef');
    assert.ok(plan.every((step) => step.file === 'docker' && Array.isArray(step.args)));
    assert.ok(plan.every((step) => step.shell === false));
    assert.ok(plan.some((step) => step.args.includes('--target') && step.args.includes('signatures')));
    assert.equal(plan.some((step) => step.args.includes('push')), false);
    assert.equal(JSON.stringify(plan).includes('sh -c'), false);
    assert.equal(JSON.stringify(plan).includes('cmd /c'), false);
  });

  test('derives labels from actual temporary-image output and cross-checks the final image', async () => {
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = [];
    const executor = async (file: string, args: string[], options: { shell?: boolean } = {}) => {
      calls.push({ file, args, ...options });
      if (args[0] === 'run' && args.includes('--version')) return { stdout: `${VERSION}\n`, stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}`, RepoDigests: [], Config: {
          User: '1000:1000', Env: [], Entrypoint: ['clamscan'], Cmd: ['--version'], Labels: {
            'org.known.clamav.engine-version': 'ClamAV 1.4.3',
            'org.known.clamav.signature-version': '27809',
            'org.known.clamav.signature-built-at': '2026-07-25T04:31:20.000Z',
          },
        }}]), stderr: '' };
      }
      if (args[0] === 'history') return { stdout: '{"CreatedBy":"LABEL org.known.clamav.engine-version"}\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const result = await buildClamavImage(['--base-image', BASE, '--tag', LOCAL], {
      executor, randomId: () => 'deadbeef', now: () => Date.parse('2026-07-26T00:00:00Z'),
    });
    assert.deepEqual(result, { imageId: `sha256:${'b'.repeat(64)}` });
    assert.equal(calls.filter(({ args }) => args[0] === 'run' && args.includes('--version')).length, 2);
    const finalBuild = calls.find(({ args }) => args[0] === 'build'
      && args.some((part) => part.endsWith('-candidate')));
    assert.ok(finalBuild?.args.includes('org.known.clamav.engine-version=ClamAV 1.4.3'));
    assert.ok(finalBuild?.args.includes('org.known.clamav.signature-version=27809'));
    assert.ok(finalBuild?.args.includes('org.known.clamav.signature-built-at=2026-07-25T04:31:20.000Z'));
    assert.equal(calls.filter(({ args }) => args[0] === 'history').length, 1);
    const publishLocalTag = calls.find(({ args }) => args[0] === 'tag');
    assert.equal(publishLocalTag?.args.at(-1), LOCAL);
    assert.ok(calls.every(({ shell }) => shell === false));
  });

  test('validates ClamAV 1.4.x and signature freshness within 48 hours', () => {
    assert.deepEqual(parseClamavBuildEvidence(VERSION, Date.parse('2026-07-26T00:00:00Z')), {
      engineVersion: 'ClamAV 1.4.3', signatureVersion: 27809,
      signatureBuiltAt: '2026-07-25T04:31:20.000Z',
    });
    assert.throws(() => parseClamavBuildEvidence('ClamAV 1.5.0/27809/Fri Jul 25 04:31:20 2026', Date.now()),
      /clamav_engine_version_unsupported/);
    assert.throws(() => parseClamavBuildEvidence('ClamAV 1.4.3/27809/Mon Jul 20 00:00:00 2026', Date.parse('2026-07-26T00:00:00Z')),
      /clamav_signatures_stale/);
  });

  test('pushes only with an explicit flag and requires exactly one matching immutable RepoDigest', () => {
    assert.equal(parseBuildArguments(['--base-image', BASE, '--tag', PUSH, '--push']).push, true);
    assert.throws(() => parseBuildArguments(['--base-image', BASE, '--tag', LOCAL, '--push']),
      /image_push_registry_required/);
    assert.equal(resolveUniqueRepoDigest(PUSH, [`registry.example/known-clamav@sha256:${'c'.repeat(64)}`]),
      `registry.example/known-clamav@sha256:${'c'.repeat(64)}`);
    assert.throws(() => resolveUniqueRepoDigest(PUSH, []), /image_repo_digest_missing/);
    assert.throws(() => resolveUniqueRepoDigest(PUSH, [
      `registry.example/known-clamav@sha256:${'c'.repeat(64)}`,
      `registry.example/known-clamav@sha256:${'d'.repeat(64)}`,
    ]), /image_repo_digest_not_unique/);
  });

  test('publishes only after verification and returns the pushed repository digest', async () => {
    const calls: string[][] = [];
    const digest = `registry.example/known-clamav@sha256:${'c'.repeat(64)}`;
    const executor = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args.includes('--version')) return { stdout: `${VERSION}\n`, stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}`, RepoDigests: [digest], Config: {
          User: '1000:1000', Env: [], Entrypoint: ['clamscan'], Cmd: ['--version'], Labels: {
            'org.known.clamav.engine-version': 'ClamAV 1.4.3',
            'org.known.clamav.signature-version': '27809',
            'org.known.clamav.signature-built-at': '2026-07-25T04:31:20.000Z',
          },
        }}]), stderr: '' };
      }
      if (args[0] === 'history') return { stdout: '{"CreatedBy":"verified build"}\n', stderr: '' };
      return { stdout: '', stderr: '', code: 0 };
    };
    const result = await buildClamavImage(['--base-image', BASE, '--tag', PUSH, '--push'], {
      executor, randomId: () => 'deadbeef', now: () => Date.parse('2026-07-26T00:00:00Z'),
    });
    assert.deepEqual(result, { imageId: `sha256:${'b'.repeat(64)}`, repoDigest: digest });
    const pushIndex = calls.findIndex((args) => args[0] === 'push');
    const tagIndex = calls.findIndex((args) => args[0] === 'tag');
    const historyIndex = calls.findIndex((args) => args[0] === 'history');
    assert.ok(historyIndex >= 0 && tagIndex > historyIndex && pushIndex > tagIndex);
    assert.equal(calls.filter((args) => args[0] === 'push').length, 1);
  });

  test('rejects secret-bearing input and cleans only its random temporary tags after failure', async () => {
    const calls: string[][] = [];
    const executor = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'build') throw new Error('raw docker failure with secret-marker');
      return { stdout: '', stderr: '' };
    };
    await assert.rejects(() => buildClamavImage(['--base-image', BASE, '--tag', LOCAL], {
      executor, randomId: () => 'deadbeef', environment: { P4A_R2_SECRET_ACCESS_KEY: 'secret-marker' },
    }), /image_build_failed/);
    const cleanup = calls.filter((entry) => entry[0] === 'image' && entry[1] === 'rm');
    assert.ok(cleanup.length > 0);
    assert.ok(cleanup.every((entry) => entry.every((part) => !part.includes(LOCAL))));
    assert.ok(cleanup.every((entry) => entry.some((part) => part.startsWith('known-clamav-build-deadbeef'))));
    const containerCleanup = calls.filter((entry) => entry[0] === 'container' && entry[1] === 'rm');
    assert.equal(containerCleanup.length, 2);
    assert.ok(containerCleanup.every((entry) => entry.some((part) => part.startsWith('known-clamav-build-deadbeef'))));
  });

  test('fails closed on a command timeout, aborts it, and still attempts exact cleanup', async () => {
    const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
    const executor = async (_file: string, args: string[], options: { signal?: AbortSignal } = {}) => {
      calls.push({ args, signal: options.signal });
      if (args[0] === 'build') await new Promise<void>(() => undefined);
      return { stdout: '', stderr: '', code: 0 };
    };
    await assert.rejects(() => buildClamavImage(['--base-image', BASE, '--tag', LOCAL], {
      executor, randomId: () => 'deadbeef', commandTimeoutMs: 5,
    }), /image_build_timeout/);
    assert.equal(calls[0]?.signal?.aborted, true);
    assert.equal(calls.filter(({ args }) => args[0] === 'container' && args[1] === 'rm').length, 2);
    assert.equal(calls.filter(({ args }) => args[0] === 'image' && args[1] === 'rm').length, 2);
  });
});
