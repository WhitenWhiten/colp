import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const nodeJobs = ['static', 'test', 'publisher-coverage', 'security-coverage',
  'sync-core-coverage', 'package', 'dependency-audit', 'conformance'];
const extensionJobs = ['extension', 'extension-browser', 'self-hosted-browser',
  'extension-coverage', 'extension-mv3', 'extension-sync-real-stack',
  'extension-kns-09-release', 'extension-kns-09-e2e'];
const webJobs = ['web', 'web-browser', 'web-acceptance', 'extension-browser', 'self-hosted-browser'];
const serverJobs = ['server', 'server-integration', 'server-capabilities', 'web-acceptance', ...extensionJobs];

export const CI_JOBS = [...new Set([...nodeJobs, ...serverJobs, ...webJobs])];

/** Apps install a pinned SDK, not packages/node/src. Cross-package test imports
 * and generated contracts are listed explicitly alongside the package scopes. */
export function jobsForPaths(paths) {
  const jobs = new Set();
  const add = (names) => names.forEach(name => jobs.add(name));
  for (const path of paths) {
    if (path === '.github/workflows/colp-ci.yml' || path.startsWith('scripts/')
      || path.startsWith('packages/server/vendor/')
      || path.startsWith('docs/automation/design/schemas/')
      || path.startsWith('docs/automation/design/api/')
      || path === 'docs/automation/contract-adjustments.json') return [...CI_JOBS];

    // These Markdown files are inputs/outputs of the protocol drift checks.
    if (/^protocol\/(?:SPECIFICATION\.md|docs\/.*\.md)$/u.test(path)
      || path === 'packages/node/docs/TRACEABILITY.md'
      || path.startsWith('packages/node/fixtures/protocol/docs/')) {
      add(['static']);
      continue;
    }
    if ((/\.(?:md|mdx|rst)$/iu.test(path) && !/(?:^|\/)(?:src|tests?|fixtures|e2e)\//u.test(path))
      || path.startsWith('docs/') || path.startsWith('reports/')
      || path.startsWith('.github/ISSUE_TEMPLATE/')
      || ['LICENSE', '.github/CODEOWNERS'].includes(path)) continue;

    if (path.startsWith('protocol/')) {
      // Shared schemas/policies and repository fixtures also feed app tests.
      add(CI_JOBS);
    } else if (path.startsWith('packages/node/')) {
      add(nodeJobs);
      if (path.startsWith('packages/node/tests/fixtures/automation/')) add(['server']);
    } else if (path.startsWith('packages/conformance/')) {
      // Sync resilience is imported by the extension and server integration suites.
      add(['conformance', 'server-integration', ...extensionJobs]);
    } else if (path.startsWith('packages/server/')) {
      add(serverJobs);
      if (/^packages\/server\/(?:openapi|generated)\//u.test(path)) add(['web']);
      if (/\/package(?:-lock)?\.json$/u.test(path)) add(['static']);
      if (path === 'packages/server/src/generated/browser-folder-roles.ts') add(['static']);
    } else if (path.startsWith('packages/web/')) {
      add(webJobs);
      if (path.startsWith('packages/web/src/pages/automations/')) add(['server-integration']);
      if (/\/package(?:-lock)?\.json$/u.test(path)) add(['static']);
      if (path === 'packages/web/src/generated/browser-folder-roles.ts') add(['static']);
    } else if (path.startsWith('packages/extension/')) {
      add(extensionJobs);
      // Product Sync Center imports the real extension store/workers and this harness.
      if (path.startsWith('packages/extension/src/') || path.startsWith('packages/extension/scripts/')
        || path === 'packages/extension/tests/health-server-integration-harness.ts'
        || /\/package(?:-lock)?\.json$/u.test(path)) add(['server-integration']);
      if (path === 'packages/extension/src/sync-failure-class.ts'
        || path === 'packages/extension/popup.css') add(['web']);
      // Both web browser commands use this shared xvfb launcher.
      if (path === 'packages/extension/scripts/with-xvfb.mjs') add(['web-browser', 'web-acceptance']);
      if (/\/package(?:-lock)?\.json$/u.test(path)) add(['static']);
      if (path === 'packages/extension/src/generated/browser-folder-roles.ts') add(['static']);
    } else if (path.startsWith('formal/sync/')) {
      add(['extension']); // Builds the Lean exporter and runs model-derived vectors.
    } else if (path.startsWith('deploy/')) {
      add(['server', 'self-hosted-browser', 'web-acceptance']);
    } else if (path === '.github/workflows/colp-server-image.yml') {
      add(['server']);
    } else if (path === '.github/workflows/colp-extension-release.yml') {
      add(['extension', 'extension-kns-09-release']);
    } else {
      // New build/config locations must not silently lose their CI coverage.
      return [...CI_JOBS];
    }
  }
  return CI_JOBS.filter(job => jobs.has(job));
}

const packageMetadata = /^packages\/(?:node|server(?:\/runtime)?|web|extension|conformance)\/package(-lock)?\.json$/u;
const versionToken = /^[0-9]+(?:\.[0-9]+){2,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Only known release fields are ignored; dependencies, permissions, scripts,
 * generated SDK/protocol versions, additions and deletions remain meaningful. */
export function isReleaseOnly(path, before, after) {
  if (before === null || after === null) return false;
  if (path === 'packages/server/src/version.ts') {
    const serverVersion = /^  server: '([0-9A-Za-z.+-]+)',$/mu;
    return versionToken.test(before.match(serverVersion)?.[1]) && versionToken.test(after.match(serverVersion)?.[1])
      && before.replace(serverVersion, '') === after.replace(serverVersion, '');
  }
  if (!packageMetadata.test(path) && path !== 'packages/extension/manifest.base.json') return false;
  try {
    const previous = JSON.parse(before);
    const current = JSON.parse(after);
    for (const value of [previous, current]) {
      if (!versionToken.test(value.version)) return false;
      delete value.version;
      if (path.endsWith('package-lock.json') && value.packages?.['']) {
        if (!versionToken.test(value.packages[''].version)) return false;
        delete value.packages[''].version;
      }
      if (path === 'packages/extension/manifest.base.json') {
        if (!versionToken.test(value.version_name)) return false;
        delete value.version_name;
      }
    }
    return isDeepStrictEqual(previous, current);
  } catch {
    return false;
  }
}

export function selectCiJobs({ repository, eventName, event }) {
  const full = reason => ({ jobs: [...CI_JOBS], reason });
  if (eventName === 'workflow_dispatch') return full('Manual full verification');
  let base;
  let head;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else if (eventName === 'push') {
    base = event.before;
    head = event.after;
  }
  const sha = /^[0-9a-f]{40}$/u;
  if (!sha.test(base ?? '') || !sha.test(head ?? '') || /^0+$/u.test(base) || /^0+$/u.test(head)) {
    return full('No comparable event commits; using full verification');
  }
  const git = args => execFileSync('git', args, {
    cwd: repository, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    if (eventName === 'pull_request') base = git(['merge-base', base, head]).trim();
    // Disable rename detection so both the old and new paths select their owners.
    const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean);
    const readAt = (ref, path) => {
      try { return git(['show', `${ref}:${path}`]); } catch { return null; }
    };
    const meaningful = paths.filter(path => {
      if (!packageMetadata.test(path) && path !== 'packages/extension/manifest.base.json'
        && path !== 'packages/server/src/version.ts') return true;
      return !isReleaseOnly(path, readAt(base, path), readAt(head, path));
    });
    const jobs = jobsForPaths(meaningful);
    return { jobs, reason: jobs.length ? 'Jobs selected from changed files' : 'Documentation / release metadata only' };
  } catch {
    // A force push can remove the old commit. Missing history must run more, not less.
    return full('Could not compare event commits; using full verification');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const localRange = process.argv.slice(2);
  const eventName = localRange.length === 2 ? 'push' : process.env.GITHUB_EVENT_NAME;
  const event = localRange.length === 2
    ? { before: localRange[0], after: localRange[1] }
    : JSON.parse(process.env.GITHUB_EVENT_PATH ? readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8') : '{}');
  const result = selectCiJobs({ repository, eventName, event });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `jobs=${JSON.stringify(result.jobs)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### CI scope\n\n${result.reason}\n\nSelected ${result.jobs.length}/${CI_JOBS.length} jobs: ${result.jobs.join(', ') || 'none (ci-gate only)'}.\n`);
  }
}
