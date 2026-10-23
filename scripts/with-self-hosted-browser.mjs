#!/usr/bin/env node
/** Disposable production CLI + built web application for real browser acceptance. */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as proxyRequest } from 'node:http';
import { access, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(root, 'packages/server');
const webRoot = resolve(root, 'packages/web/dist');
const cli = resolve(serverRoot, 'dist/src/cli/index.js');
const { Pool } = createRequire(resolve(serverRoot, 'package.json'))('pg');
const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
if (!args.length) throw new Error('usage: with-self-hosted-browser.mjs -- <command> [...args]');
if (!process.env.DISPLAY) throw new Error('Self-hosted browser acceptance requires xvfb.');
await Promise.all([access(cli), access(resolve(webRoot, 'index.html'))]);
const databaseUrl = process.env.KNOWN_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Run this fixture through with-postgres.mjs --isolated-owner.');
const admin = new Pool({ connectionString: databaseUrl, max: 1 });
const database = `browser_${randomUUID().replaceAll('-', '')}`;
const isolated = new URL(databaseUrl); isolated.pathname = `/${database}`;
const username = 'browserowner';
const email = 'browser-owner@example.test';
const password = randomBytes(24).toString('base64url');
const secret = randomBytes(48).toString('base64');
const children = new Set();
let api;
let interrupted = false;
let created = false;
const frontend = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
let apiPort;
let exitCode = 1;
const interrupt = () => {
  interrupted = true;
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  await admin.query(`create database "${database}"`); created = true;
  await new Promise((done, reject) => { frontend.once('error', reject); frontend.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${frontend.address().port}`;
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  apiPort = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: isolated.toString(),
    DATABASE_SSL_MODE: 'disable', HOST: '127.0.0.1', PORT: String(apiPort),
    COLP_SERVER_ORIGIN: origin, COLP_SERVER_SECRET: secret, COLP_INSECURE_HTTP: 'true',
    COLP_MULTI_USER: 'false', COLP_LOG_LEVEL: 'error',
    COLP_ALLOWED_EXTENSION_IDS: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
    TRUSTED_INGRESS: '127.0.0.1/32,::1/128',
    COLP_ACCEPTANCE_ORIGIN: origin, COLP_ACCEPTANCE_USERNAME: username, COLP_ACCEPTANCE_PASSWORD: password,
    COLP_I2_ORIGIN: origin, COLP_I2_EMAIL: email, COLP_I2_PASSWORD: password,
    COLP_AW_ORIGIN: origin, COLP_AW_USER: username, COLP_AW_PASSWORD: password,
    KNOWN_CAPTURE_WEB_ORIGIN: origin, COLP_BROWSER_FIXTURE: '1' };
  await run(process.execPath, [cli, 'migrate'], env, serverRoot);
  await run(process.execPath, [cli, 'create-user', '--username', username, '--email', email], env, serverRoot,
    `${password}\n${password}\n`);
  api = launch(process.execPath, [cli, 'start'], env, serverRoot);
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !interrupted && api.exitCode === null && api.signalCode === null) {
    try { ready = (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error('Disposable production server did not become ready.');
  process.stdout.write('[self-hosted-browser] Production CLI, isolated owner and built web application ready.\n');
  exitCode = await run(args[0], args.slice(1), env, process.cwd(), undefined, true);
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(stop));
  frontend.closeAllConnections();
  await new Promise(done => frontend.close(done));
  try { if (created) await admin.query(`drop database "${database}" with (force)`); }
  finally { await admin.end(); }
}
process.exitCode = interrupted ? 130 : exitCode;

function launch(command, argv, env, cwd, input) {
  if (interrupted) throw new Error('Browser fixture interrupted.');
  const child = spawn(command, argv, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  if (input !== undefined) child.stdin.end(input);
  return child;
}
async function run(command, argv, env, cwd, input, allowFailure = false) {
  const child = launch(command, argv, env, cwd, input);
  const code = await new Promise((done, reject) => {
    child.once('error', reject); child.once('exit', (status, signal) => done(signal ? 130 : status ?? 1));
  });
  if (code && !allowFailure) throw new Error(`Browser fixture setup command failed (${code}).`);
  return code;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => {
      timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function serve(request, response) {
  if (/^\/(?:api\/|collections\/|\.well-known\/|colp\/|health(?:\?|$)|ready(?:\?|$))/u.test(request.url ?? '')) {
    if (!apiPort) { response.writeHead(503).end(); return; }
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: apiPort, method: request.method,
      path: request.url, headers: { ...request.headers, 'x-forwarded-proto': 'http', 'x-forwarded-for': '127.0.0.1' } }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream); return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const documentation = { '/CHANGELOG.md': resolve(serverRoot, 'CHANGELOG.md'), '/INSTALL.md': resolve(root, 'deploy/INSTALL.md') };
  if (documentation[pathname]) {
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(await readFile(documentation[pathname])); return;
  }
  let file = resolve(webRoot, `.${pathname}`);
  if (!file.startsWith(`${webRoot}${sep}`) && file !== webRoot) { response.writeHead(404).end(); return; }
  const exists = await stat(file).then(value => value.isFile(), () => false);
  if (!exists) {
    if (pathname.startsWith('/assets/')) { response.writeHead(404).end(); return; }
    file = resolve(webRoot, 'index.html');
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(await readFile(file));
}
