import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkServerIdentity, connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const exec = promisify(execFile);
const deploy = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = 'COLP TLS handshake fixture';

async function docker(args) {
  return exec('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
}

function request(port, hostname, authority, ca, identity = hostname) {
  return new Promise((resolveResponse, reject) => {
    // Docker forwards the TCP connection to loopback. Verify the certificate
    // against the configured public identity, including the IPv6 case.
    const socket = connect({
      host: '127.0.0.1', port, ca, rejectUnauthorized: true,
      servername: isIP(hostname) ? '' : hostname,
      checkServerIdentity: (_, certificate) => {
        if (isIP(identity)) {
          // Match IP subjectAltNames directly, without DNS/IDNA conversion.
          if (!new X509Certificate(certificate.raw).checkIP(identity)) {
            return new Error(`The TLS certificate does not match IP ${identity}`);
          }
          return undefined;
        }
        return checkServerIdentity(identity, certificate);
      },
    });
    let response = '';
    socket.setTimeout(3_000, () => socket.destroy(new Error('TLS request timed out')));
    socket.on('secureConnect', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolveResponse(response));
  });
}

const cases = [
  { name: 'IPv4 without SNI', origin: 'https://127.0.0.1:18443', hostname: '127.0.0.1', authority: '127.0.0.1:18443' },
  { name: 'IPv6 without SNI', origin: 'https://[::1]:24443', hostname: '::1', authority: '[::1]:24443' },
  { name: 'DNS hostname with SNI', origin: 'https://colp.example.test', hostname: 'colp.example.test', authority: 'colp.example.test' },
];

for (const scenario of cases) {
  test(`production Compose serves trusted HTTPS for ${scenario.name}`, { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'colp-tls-handshake-'));
    const project = `colp-tls-${randomUUID().slice(0, 8)}`;
    const container = `${project}-caddy`;
    const listenPort = new URL(scenario.origin).port || '443';
    const override = join(directory, 'override.json');
    const env = join(directory, '.env');
    const web = join(directory, 'web');
    await mkdir(web);
    await writeFile(join(web, 'index.html'), marker);
    // Only the TLS ingress starts. No server image, database, npm install,
    // browser, global CA trust or existing deployment is needed by this test.
    await writeFile(env, [
      `COLP_SERVER_ORIGIN=${scenario.origin}`,
      'POSTGRES_PASSWORD=tls-test-unused',
      `COLP_SERVER_SECRET=${'x'.repeat(48)}`,
    ].join('\n'));
    await writeFile(override, JSON.stringify({ services: {
      'caddy-tls-internal': { volumes: [`${web}:/srv/web:ro`] },
    } }));
    const composeArgs = ['compose', '--profile', 'tls-internal', '--project-directory', deploy, '--env-file', env,
      '-p', project, '-f', join(deploy, 'compose.yaml'), '-f', override];
    const compose = (args) => docker([...composeArgs, ...args]);
    try {
      await compose(['run', '--no-deps', '--detach', '--name', container,
        '--publish', `127.0.0.1::${listenPort}`, 'caddy-tls-internal']);
      const port = Number((await docker(['port', container, `${listenPort}/tcp`])).stdout.trim().split(':').at(-1));
      assert.ok(Number.isInteger(port) && port > 0);
      const deadline = Date.now() + 20_000;
      let failure;
      let trustedCA;
      // Both the CA and the leaf certificate are generated asynchronously
      // on first boot. Retry the verified request rather than bypassing TLS.
      while (Date.now() < deadline) {
        try {
          const ca = (await docker(['exec', container, 'cat', '/data/caddy/pki/authorities/local/root.crt'])).stdout;
          const response = await request(port, scenario.hostname, scenario.authority, ca);
          assert.match(response, /^HTTP\/1\.1 200 /u);
          assert.ok(response.endsWith(marker));
          trustedCA = ca;
          break;
        } catch (error) {
          failure = error;
          await delay(200);
        }
      }
      if (!trustedCA) throw failure ?? new Error('Caddy did not serve a verified TLS response');
      await assert.rejects(request(port, scenario.hostname, scenario.authority, []), /certificate|issuer/iu);
      await assert.rejects(request(port, scenario.hostname, scenario.authority, trustedCA, '192.0.2.99'),
        /certificate does not match IP/iu);
    } catch (error) {
      const logs = await docker(['logs', container]).catch(() => ({ stdout: '', stderr: '' }));
      throw new Error(`${error.message}\n${logs.stdout}${logs.stderr}`, { cause: error });
    } finally {
      try {
        // Remove the explicitly named one-off before tearing down the
        // project. Keep the TLS profile active so down also removes its volumes.
        try {
          const exists = await docker(['container', 'inspect', container]).then(() => true, () => false);
          if (exists) {
            await docker(['stop', '--time', '3', container]);
            await docker(['rm', container]);
          }
        } finally {
          await compose(['down', '--volumes', '--remove-orphans']);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    const label = `label=com.docker.compose.project=${project}`;
    for (const args of [
      ['ps', '--all', '--quiet', '--filter', label],
      ['volume', 'ls', '--quiet', '--filter', label],
      ['network', 'ls', '--quiet', '--filter', label],
    ]) {
      assert.equal((await docker(args)).stdout.trim(), '', 'TLS test resources must be removed');
    }
  });
}
