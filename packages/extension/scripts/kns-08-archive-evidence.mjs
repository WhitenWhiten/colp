/**
 * Archive KNS-08 Playwright artifacts under test-results/known-extension-first-run-sync/<commit>/.
 * Redacts URL/title/token/full user id before copy. Failures keep the minimal replay fixture.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(packageRoot, '../..');
const suite = process.argv[2] === 'trash-restore' ? 'trash-restore' : 'first-run-sync';
const browser = process.env.KNS_08_BROWSER ?? 'chromium';
if (!['chromium', 'msedge'].includes(browser)) throw new Error(`Unsupported KNS_08_BROWSER: ${browser}`);

const commit = await gitCommit();
const dest = resolve(workspace, 'test-results/known-extension-first-run-sync', commit,
  ...(browser === 'msedge' ? ['msedge'] : []), suite);
await mkdir(dest, { recursive: true });
const testResults = resolve(packageRoot, 'test-results');
if (await exists(testResults)) await copyRedacted(testResults, join(dest, 'playwright'));
const replay = resolve(packageRoot, 'test-results/kns-08-replay');
if (await exists(replay)) await copyRedacted(replay, join(dest, 'replay'));
const config = JSON.parse(await readFile(resolve(packageRoot, 'dist/production/generated-config.json'), 'utf8')
  .catch(() => '{"environment":"unknown"}'));
await writeFile(join(dest, 'runtime-summary.json'), `${JSON.stringify({
  schemaVersion: 1, suite, commit, browser, environment: config.environment ?? null,
  browserSelection: { KNS_08_BROWSER: browser,
    customEdgeExecutable: Boolean(process.env.KNS_08_EDGE_EXECUTABLE) },
  commands: [
    'npm run build -- --config config/e2e-fixture.json',
    'node ../server/scripts/with-postgres.mjs -- node scripts/with-xvfb.mjs npx playwright test '
    + (suite === 'trash-restore' ? 'e2e/mv3-trash-restore.spec.ts'
      : 'e2e/mv3-first-run-sync.spec.ts e2e/mv3-first-run-remediation.spec.ts'),
    'node scripts/verify-release-artifact.mjs dist/production',
    'node scripts/verify-bookmark-privacy-artifacts.mjs test-results',
  ],
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite, commit, dest: relative(workspace, dest) })}\n`);

async function gitCommit() {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace });
    return result.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function copyRedacted(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) { await copyRedacted(from, to); continue; }
    if (/\.(png|jpg|jpeg|webp|zip)$/iu.test(entry.name)) { await cp(from, to); continue; }
    const raw = await readFile(from);
    const text = redact(raw.toString('utf8'));
    await writeFile(to, text);
  }
}

function redact(text) {
  return text
    .replace(/https?:\/\/[^\s"'\\<>]+/giu, '[redacted-url]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted-jwt]')
    .replace(/__Host-known_session=[^;\s]+/gu, '__Host-known_session=[redacted]')
    .replace(/p3-27-extension@example\.test/gu, '[redacted-email]')
    .replace(/p3-27-extension-password-e3/gu, '[redacted-secret]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '[redacted-uuid]');
}
