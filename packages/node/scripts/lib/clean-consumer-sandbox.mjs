/** Candidate code is never executed by a host Node process. Docker is required;
 * absence or failure is a hard error, with no unsandboxed fallback.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { isolatedProcessEnvironment } from './npm-command.mjs';

const exec = promisify(execFile);
export function cleanConsumerImage() {
  return `node:${process.versions.node}-bookworm-slim`;
}

export function cleanConsumerSandboxArguments(consumer, args, name) {
  assert.ok(isAbsolute(consumer) && !/[,\r\n]/u.test(consumer), 'Invalid sandbox mount path.');
  assert.ok(/^colp-clean-[a-f0-9-]+$/u.test(name), 'Invalid sandbox name.');
  assert.ok(Array.isArray(args) && args.every(arg => typeof arg === 'string'));
  return [
    'run', '--rm', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user=65534:65534',
    '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1',
    '--ipc=none',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777',
    '--mount', `type=bind,source=${consumer},target=/work,readonly`,
    '--workdir=/work', '--env=HOME=/tmp', '--env=NODE_ENV=production',
    '--entrypoint=node', cleanConsumerImage(), '--max-old-space-size=256', ...args,
  ];
}

export async function runCleanConsumerNode(consumer, args, options = {}) {
  const name = `colp-clean-${randomUUID()}`;
  // Docker can inject credential-bearing proxies from ~/.docker/config.json.
  // Give the trusted CLI a new empty config as well as an allowlisted environment.
  const configuration = await mkdtemp(join(tmpdir(), 'colp-docker-config-'));
  const environment = isolatedProcessEnvironment(configuration);
  let failure;
  try {
    await mkdir(join(configuration, 'npm-tmp'), { mode: 0o700 });
    await writeFile(join(configuration, 'config.json'), '{}', { mode: 0o600 });
    return await exec('docker', ['--config', configuration,
      ...cleanConsumerSandboxArguments(consumer, args, name)], {
      cwd: consumer, env: environment,
      timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (cause) {
    failure = cause;
    throw new Error('Isolated clean-tarball verification failed. Docker must be available; no host execution is allowed.', { cause });
  } finally {
    // Killing a Docker client on timeout need not kill its container. Always
    // attempt daemon-side teardown, including when the verification times out.
    try {
      await exec('docker', ['--config', configuration, 'rm', '--force', name], {
        env: environment, timeout: 15_000, maxBuffer: 1024 * 1024,
      });
    } catch (cleanup) {
      if (!/No such container/iu.test(String(cleanup.stderr ?? ''))
        && !(cleanup.code === 'ENOENT' && failure !== undefined)) {
        throw new AggregateError([failure, cleanup].filter(Boolean), 'Clean-consumer container teardown failed.');
      }
    } finally {
      await rm(configuration, { recursive: true, force: true });
    }
  }
}
