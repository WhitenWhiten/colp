import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  assertDaemonInspection,
  assertDockerVersionInspection,
  assertImageInspection,
  assertRuntimeInspection,
  buildClamScanCommand,
  buildContainerArgs,
  createActiveContainerCleanup,
  eicarTestBytes,
  parseClamavVersion,
  parseScannerCli,
  scannerEnvironment,
} from '../../../scripts/phase4a-clamav-docker-scanner.mjs';

const IMAGE = 'registry.example/known-clamav@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('P4A-I01 rootless Docker ClamAV scanner harness', () => {
  test('freezes the dedicated supervisor trust boundary', async () => {
    const runbook = await readFile(resolve('docs/evidence/phase4a-clamav-docker-runbook.md'), 'utf8');
    assert.match(runbook, /dedicated non-login `known-scanner-supervisor` OS user/u);
    assert.match(runbook, /API and general Worker service accounts must not share its UID, groups, login session, socket ACL/u);
    assert.match(runbook, /owns no database, OIDC, email, publication, Cloudflare control-plane, registry, or R2 write credential/u);
    assert.match(runbook, /do not grant a shell, arbitrary Node script, Docker CLI, or general command access/u);
  });

  test('requires an exact image digest for every daemon operation', () => {
    assert.deepEqual(parseScannerCli(['--version', '--image', IMAGE]), { mode: 'version', image: IMAGE });
    assert.deepEqual(parseScannerCli(['--inspect', '--image', IMAGE]), { mode: 'inspect', image: IMAGE });
    assert.deepEqual(parseScannerCli([
      '--scenario', 'clean', '--fixture', 'host-name-does-not-enter-container.txt', '--image', IMAGE,
    ]), { mode: 'scenario', scenario: 'clean', fixture: 'host-name-does-not-enter-container.txt', image: IMAGE });
    assert.throws(() => parseScannerCli(['--inspect']), /scanner_image_digest_required/);
    assert.throws(() => parseScannerCli(['--version', '--image', 'clamav:latest']), /scanner_image_digest_required/);
    assert.throws(() => parseScannerCli(['--scenario', 'clean', '--fixture', 'x', '--image', IMAGE, '--extra']),
      /invalid_scanner_arguments/);
  });

  test('builds a fixed isolation argv without shell interpolation or user-derived container paths', () => {
    const args = buildContainerArgs({
      image: IMAGE,
      containerName: 'known-clamav-018f6f7a8f2a7a3da123123456789abc',
      inputPath: 'C:\\temporary\\attacker-name;touch-pwned.bin',
      signaturePath: undefined,
      command: ['clamscan', '--no-summary', '--infected', '/scan/input.bin'],
    });
    assert.deepEqual(args.slice(0, 2), ['run', '--name']);
    for (const required of [
      '--pull', 'never', '--log-driver', 'none',
      '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '1024m',
      '--memory-swap', '1024m', '--cpus', '1', '--ipc', 'none',
    ]) assert.ok(args.includes(required));
    assert.ok(args.some((part) => part.includes('dst=/scan/input.bin')));
    assert.ok(args.some((part) => part.includes('readonly')));
    assert.ok(args.includes('--entrypoint'));
    assert.ok(args.includes('clamscan'));
    assert.equal(args.filter((part) => part === IMAGE).length, 1);
    assert.equal(args.at(-1), '/scan/input.bin');
    assert.doesNotMatch(args.join('\n'), /--privileged|--device|docker\.sock|--pid=host|--network=host/u);
    assert.doesNotMatch(args.join('\n'), /dst=[^,]*attacker-name/u);
    assert.ok(buildClamScanCommand().includes('--max-ratio=20'));
  });

  test('accepts only a local rootless daemon and an exact non-root image', () => {
    assert.doesNotThrow(() => assertDockerVersionInspection({
      Client: { Version: '29.1.0' }, Server: { Version: '29.1.0', Os: 'linux' },
    }));
    assert.throws(() => assertDockerVersionInspection({
      Client: { Version: '29.1.0' }, Server: { Version: '29.1.0', Os: 'windows' },
    }), /docker_linux_daemon_required/);
    assert.doesNotThrow(() => assertDaemonInspection({
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'], CgroupVersion: '2',
    }, 'unix:///run/user/1000/docker.sock'));
    assert.throws(() => assertDaemonInspection({
      SecurityOptions: ['name=seccomp,profile=unconfined', 'name=rootless'], CgroupVersion: '2',
    }, 'unix:///run/user/1000/docker.sock'), /docker_security_profile_required/);
    assert.throws(() => assertDaemonInspection({ SecurityOptions: ['name=seccomp'], CgroupVersion: '2' }, 'unix:///var/run/docker.sock'),
      /docker_rootless_required/);
    assert.throws(() => assertDaemonInspection({
      SecurityOptions: ['name=rootless', 'name=seccomp,profile=builtin'], CgroupVersion: '2',
    }, 'tcp://127.0.0.1:2375'),
      /docker_local_unix_socket_required/);
    assert.doesNotThrow(() => assertImageInspection({
      RepoDigests: [IMAGE], Created: '2026-07-26T00:00:00Z', Config: {
        User: '1000:1000', Labels: {
          'org.known.clamav.engine-version': 'ClamAV 1.4.3',
          'org.known.clamav.signature-version': '27809',
          'org.known.clamav.signature-built-at': '2026-07-25T04:31:20.000Z',
        },
      },
    }, IMAGE, Date.parse('2026-07-26T00:00:00Z')));
    assert.throws(() => assertImageInspection({ RepoDigests: [], Config: { User: '1000:1000' } }, IMAGE),
      /scanner_image_digest_mismatch/);
    assert.throws(() => assertImageInspection({ RepoDigests: [IMAGE], Config: { User: '0' } }, IMAGE),
      /scanner_image_non_root_required/);
  });

  test('verifies actual Docker HostConfig and fixed input mount', () => {
    const inspection = {
      Config: { User: '1000:1000', Env: [], Entrypoint: ['clamscan'], Cmd: ['--version'] },
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        PidsLimit: 64, Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1000000000,
        IpcMode: 'none', Privileged: false, Devices: [], PidMode: '', UtsMode: '', CgroupnsMode: 'private',
        LogConfig: { Type: 'none' },
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700' },
      },
      Mounts: [{ Destination: '/scan/input.bin', RW: false, Type: 'bind' }],
    };
    assert.doesNotThrow(() => assertRuntimeInspection(inspection));
    assert.throws(() => assertRuntimeInspection({
      ...inspection, HostConfig: { ...inspection.HostConfig, NetworkMode: 'host' },
    }), /scanner_runtime_profile_mismatch/);
    assert.throws(() => assertRuntimeInspection({
      ...inspection, HostConfig: { ...inspection.HostConfig, UsernsMode: 'host' },
    }), /scanner_runtime_profile_mismatch/);
    assert.throws(() => assertRuntimeInspection({
      ...inspection, HostConfig: { ...inspection.HostConfig, CgroupnsMode: '' },
    }), /scanner_runtime_profile_mismatch/);
    assert.throws(() => assertRuntimeInspection({
      ...inspection,
      Mounts: [
        ...inspection.Mounts,
        { Source: '/run/user/1000/docker.sock', Destination: '/scan/innocent-name', RW: false, Type: 'bind' },
      ],
    }), /scanner_runtime_profile_mismatch/);
    assert.throws(() => assertRuntimeInspection({
      ...inspection,
      HostConfig: { ...inspection.HostConfig, DeviceRequests: [{ Driver: 'nvidia', Count: -1 }] },
    }), /scanner_runtime_profile_mismatch/);
    assert.throws(() => assertRuntimeInspection({
      ...inspection,
      Mounts: [
        ...inspection.Mounts,
        { Source: '/run/secrets/token', Destination: '/run/token', RW: false, Type: 'bind' },
      ],
    }), /scanner_runtime_profile_mismatch/);
  });

  test('cleans only tracked exact random containers when the process is aborted', async () => {
    const active = new Set([
      'known-clamav-018f6f7a8f2a7a3da123123456789abc',
      'known-clamav-018f6f7a8f2a7a3da123123456789abd',
    ]);
    const cleaned: string[] = [];
    const cleanup = createActiveContainerCleanup(active, async (name) => {
      cleaned.push(name);
      active.delete(name);
    });
    await cleanup();
    assert.deepEqual(cleaned.sort(), [
      'known-clamav-018f6f7a8f2a7a3da123123456789abc',
      'known-clamav-018f6f7a8f2a7a3da123123456789abd',
    ]);
    assert.equal(active.size, 0);
  });

  test('parses engine and signature evidence and generates EICAR only in memory', () => {
    assert.deepEqual(parseClamavVersion('ClamAV 1.4.3/27809/Fri Jul 25 04:31:20 2026'), {
      engineVersion: 'ClamAV 1.4.3', signatureVersion: 27809, signatureBuiltAt: '2026-07-25T04:31:20.000Z',
    });
    assert.deepEqual(parseClamavVersion('ClamAV 1.4.3/28085/Fri Aug  7 06:24:10 2026'), {
      engineVersion: 'ClamAV 1.4.3', signatureVersion: 28085, signatureBuiltAt: '2026-08-07T06:24:10.000Z',
    });
    assert.throws(() => parseClamavVersion('ClamAV 1.5.0/27809/Fri Jul 25 04:31:20 2026'),
      /scanner_engine_version_unsupported/);
    assert.equal(eicarTestBytes().byteLength, 68);
    assert.equal(eicarTestBytes().toString('ascii').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'), true);
  });

  test('passes Docker only a minimal non-secret environment', () => {
    const environment = scannerEnvironment({
      PATH: '/usr/bin', HOME: '/home/known', XDG_RUNTIME_DIR: '/run/user/1000',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock', P4A_R2_SECRET_ACCESS_KEY: 'must-not-pass',
    });
    assert.deepEqual(environment, {
      PATH: '/usr/bin', HOME: '/home/known', XDG_RUNTIME_DIR: '/run/user/1000',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    });
    assert.throws(() => scannerEnvironment({ DOCKER_HOST: 'tcp://docker.example:2376' }),
      /docker_local_unix_socket_required/);
  });
});
