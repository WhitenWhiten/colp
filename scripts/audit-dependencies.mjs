#!/usr/bin/env node
// npm's audit POST requests are not retried by fetch-retries. Retry temporary
// registry failures here, while keeping vulnerability findings blocking.
//
// A high/critical advisory with no patched release can be suppressed only by an
// explicit, expiring entry in scripts/audit-advisory-allowlist.json. Suppression
// is deliberately narrow: every high/critical path in npm's `via` closure must
// terminate at an allowlisted advisory for that same package. Moderate/low
// findings are never suppressed, and a critical advisory can never be
// suppressed. A missing or malformed allowlist, or an expired matching entry,
// fails closed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const RETRY_DELAYS_MS = [5_000, 15_000];
const TRANSIENT_NETWORK_ERROR = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNECTIONTIMEOUT|EIDLETIMEOUT|ERESPONSETIMEOUT|ETRANSFERTIMEOUT)\b/u;
const DEFAULT_ALLOWLIST_PATH = fileURLToPath(new URL('./audit-advisory-allowlist.json', import.meta.url));
const ALLOWLIST_KEYS = new Set(['id', 'package', 'reason', 'owner', 'expires']);
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/iu;
const GHSA_IN_URL = /\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})(?:[/?#]|$)/iu;
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const HIGH_OR_CRITICAL = new Set(['high', 'critical']);
const MAX_PATH_DEPTH = 64;

function invalid(message) {
  throw new Error(`invalid dependency-audit advisory allowlist: ${message}`);
}

function parseExpiry(expires, context) {
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(expires)) {
    invalid(`${context} expires must be a real ISO date (YYYY-MM-DD), got ${JSON.stringify(expires)}`);
  }
  const start = new Date(`${expires}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== expires) {
    invalid(`${context} expires must be a real ISO date (YYYY-MM-DD), got ${JSON.stringify(expires)}`);
  }
  // The entry is valid through the last millisecond of its expiry day (UTC).
  return { date: expires, endMs: start.getTime() + 86_400_000 - 1 };
}

export function loadAdvisoryAllowlist(allowlistPath = DEFAULT_ALLOWLIST_PATH) {
  let document;
  try {
    document = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    throw new Error(`unable to load dependency-audit advisory allowlist ${allowlistPath}: ${error.message}`);
  }
  if (!Array.isArray(document)) invalid('the document must be a JSON array of entries');

  const seen = new Set();
  return document.map((entry, index) => {
    const context = `entry ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid(`${context} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWLIST_KEYS.has(key)) invalid(`${context} has an unrecognized key: ${key}`);
    }
    if (typeof entry.id !== 'string' || !GHSA_ID.test(entry.id)) {
      invalid(`${context} id must be a GHSA id, got ${JSON.stringify(entry.id)}`);
    }
    if (typeof entry.package !== 'string' || entry.package.trim() !== entry.package
        || !entry.package || /\s/u.test(entry.package)) {
      invalid(`${context} package must be a non-empty package name`);
    }
    for (const field of ['reason', 'owner']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        invalid(`${context} (${entry.id}) ${field} must be a non-empty string`);
      }
    }
    const { date, endMs } = parseExpiry(entry.expires, `${context} (${entry.id})`);
    const id = entry.id.toUpperCase();
    const key = `${id}\u0000${entry.package}`;
    if (seen.has(key)) invalid(`${context} duplicates ${id} for package ${entry.package}`);
    seen.add(key);
    return { id, package: entry.package, reason: entry.reason, owner: entry.owner, expires: date, endMs };
  });
}

function severityOf(value) {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function advisoryId(advisory) {
  for (const candidate of [advisory.id, advisory.advisoryId]) {
    if (typeof candidate === 'string' && GHSA_ID.test(candidate)) return candidate.toUpperCase();
  }
  return typeof advisory.url === 'string' ? (GHSA_IN_URL.exec(advisory.url)?.[1]?.toUpperCase() ?? null) : null;
}

function auditLevel(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--audit-level') return severityOf(args[index + 1]) ?? 'low';
    if (args[index].startsWith('--audit-level=')) {
      return severityOf(args[index].slice('--audit-level='.length)) ?? 'low';
    }
  }
  return 'low';
}

function reportHasBlockingFindings(report, threshold, suppressed) {
  const minimum = SEVERITY_RANK[threshold] ?? SEVERITY_RANK.low;
  return Object.entries(report.vulnerabilities).some(([name, vulnerability]) => {
    if (suppressed.has(name)) return false;
    // Unknown severities must fail closed rather than slip below the threshold.
    return (SEVERITY_RANK[severityOf(vulnerability?.severity)] ?? SEVERITY_RANK.critical) >= minimum;
  });
}

function allowlistKey(id, packageName) {
  return `${id}\u0000${packageName}`;
}

// Returns the names of high/critical vulnerabilities whose entire high/critical
// `via` closure terminates in allowlisted advisories. Paths that terminate only
// in a moderate/low advisory cannot source a high/critical finding; they are
// left untouched and are still evaluated on their own. Any unresolved package,
// malformed entry, expired entry, critical advisory, or non-allowlisted
// high/critical advisory keeps that vulnerability (and the audit) blocking.
function evaluateSuppressions(report, {
  entries, now, threshold, stderr,
}) {
  const vulnerabilities = report.vulnerabilities;
  const entriesByKey = new Map(entries.map((entry) => [allowlistKey(entry.id, entry.package), entry]));
  const minimum = SEVERITY_RANK[threshold] ?? SEVERITY_RANK.low;
  const suppressed = new Set();
  const expired = new Set();
  const reported = new Set();
  let suppressedCount = 0;

  const note = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    stderr.write(`${message}\n`);
  };

  for (const [rootName, root] of Object.entries(vulnerabilities)) {
    const rootSeverity = severityOf(root?.severity);
    if (!HIGH_OR_CRITICAL.has(rootSeverity)
        || (SEVERITY_RANK[rootSeverity] ?? SEVERITY_RANK.critical) < minimum) {
      continue;
    }
    if (rootSeverity === 'critical') {
      // Critical advisories are never suppressible, even when a matching entry
      // happens to exist.
      note(`critical:${rootName}`, `Critical vulnerability in ${rootName} is never suppressible by the advisory allowlist.`);
      continue;
    }

    let unsafe = false;
    let sawHighPath = false;
    let allHighPathsAllowlisted = true;
    const used = new Map();
    // npm can emit `via` cycles (for example @vitest/coverage-v8 <-> vitest).
    // A back-edge adds no new advisory, so collapse it; every unique terminal
    // advisory reachable from the root is still inspected. Cycles that contain
    // an actual advisory are handled by that advisory's own object.
    const visited = new Set([rootName]);

    const walk = (name, depth) => {
      if (unsafe) return;
      if (depth > MAX_PATH_DEPTH) {
        unsafe = true;
        note(`depth:${rootName}`, `High vulnerability in ${rootName} has a via chain deeper than ${MAX_PATH_DEPTH}; refusing to suppress.`);
        return;
      }
      const vulnerability = vulnerabilities[name];
      if (!vulnerability || typeof vulnerability !== 'object') {
        unsafe = true;
        note(`missing:${rootName}:${name}`, `High vulnerability in ${rootName} references unknown package ${name}; refusing to suppress.`);
        return;
      }
      if (severityOf(vulnerability.severity) === 'critical') {
        unsafe = true;
        note(`critical-node:${rootName}:${name}`, `High vulnerability in ${rootName} depends on critical vulnerability ${name}; refusing to suppress.`);
        return;
      }
      const via = vulnerability.via;
      if (!Array.isArray(via) || via.length === 0) {
        unsafe = true;
        note(`dead-end:${rootName}:${name}`, `High vulnerability in ${rootName} reaches ${name} without an advisory; refusing to suppress.`);
        return;
      }
      for (const edge of via) {
        if (typeof edge === 'string') {
          if (visited.has(edge)) continue;
          visited.add(edge);
          walk(edge, depth + 1);
          if (unsafe) return;
          continue;
        }
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
          unsafe = true;
          note(`malformed:${rootName}:${name}`, `High vulnerability in ${rootName} has a malformed via entry for ${name}; refusing to suppress.`);
          return;
        }
        const severity = severityOf(edge.severity);
        const id = advisoryId(edge);
        // Never guess which package an advisory belongs to: npm reports set
        // `name` (and usually `dependency`) on every advisory object.
        const packageName = [edge.name, edge.dependency]
          .find((candidate) => typeof candidate === 'string' && candidate.trim()) ?? null;
        const label = id ?? '<unknown advisory>';
        if (severity === 'critical') {
          unsafe = true;
          note(`critical-advisory:${label}:${packageName}`, `Critical advisory ${label} for ${packageName ?? name} is never suppressible.`);
          return;
        }
        if (severity === 'high') {
          sawHighPath = true;
          const key = id && packageName ? allowlistKey(id, packageName) : null;
          const entry = key ? entriesByKey.get(key) : undefined;
          if (!entry) {
            allHighPathsAllowlisted = false;
            note(`not-allowlisted:${label}:${packageName}`, `High advisory ${label} for ${packageName ?? '<unknown package>'} is not allowlisted; vulnerability in ${rootName} remains blocking.`);
            continue;
          }
          if (now.getTime() > entry.endMs) {
            allHighPathsAllowlisted = false;
            expired.add(entry);
            note(`expired:${entry.id}:${entry.package}`, `Expired advisory allowlist entry ${entry.id} for ${entry.package} expired ${entry.expires}; refusing to suppress.`);
            continue;
          }
          used.set(allowlistKey(entry.id, entry.package), entry);
          continue;
        }
        if (severity === 'moderate' || severity === 'low' || severity === 'info') {
          // A moderate/low branch cannot be the source of this high/critical
          // finding. It is left untouched and is still evaluated on its own.
          continue;
        }
        unsafe = true;
        note(`unknown-severity:${label}:${packageName}`, `Advisory ${label} for ${packageName ?? name} has no known severity; refusing to suppress ${rootName}.`);
        return;
      }
    };

    walk(rootName, 1);
    if (unsafe || !sawHighPath || !allHighPathsAllowlisted || used.size === 0) continue;
    suppressed.add(rootName);
    suppressedCount += 1;
    for (const entry of used.values()) {
      stderr.write(`Suppressed high vulnerability in ${rootName}: ${entry.id} (${entry.package}) allowlisted until ${entry.expires} (owner: ${entry.owner}; reason: ${entry.reason}).\n`);
    }
  }

  return { suppressed, suppressedCount, expired: expired.size > 0 };
}

export async function auditDependencies(args, {
  run = spawnSync,
  wait = sleep,
  stdout = process.stdout,
  stderr = process.stderr,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  now = new Date(),
} = {}) {
  let entries;
  try {
    entries = loadAdvisoryAllowlist(allowlistPath);
  } catch (error) {
    // A missing or malformed allowlist means no suppression decision can be
    // trusted. Fail before running an audit rather than pass with unknown scope.
    stderr.write(`${error.message}\nDependency audit failed because the advisory allowlist is not usable.\n`);
    return 1;
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    // An unusable clock must not make every expiry check compare false.
    stderr.write('Dependency audit failed because the current time is not a valid Date.\n');
    return 1;
  }

  const threshold = auditLevel(args);
  for (let attempt = 0; ; attempt += 1) {
    stderr.write(`Dependency audit attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}\n`);
    const result = run('npm', [
      'audit', ...args, '--json', '--audit=true', '--fetch-retries=0', '--fetch-timeout=30000',
    ], {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) stderr.write(`${result.error.message}\n`);

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      // Unknown or malformed output must fail, never count as a clean audit.
    }
    if (report?.vulnerabilities && report?.metadata?.vulnerabilities) {
      // Only npm's normal "vulnerabilities found" exit code gets a chance to be
      // cleared by the allowlist. A signal, crash, or unexpected status must
      // keep failing.
      if (typeof result.status !== 'number' || (result.status !== 0 && result.status !== 1)) {
        return result.status ?? 1;
      }
      if (result.status === 0) return 0;
      const evaluation = evaluateSuppressions(report, {
        entries, now, threshold, stderr,
      });
      if (evaluation.expired) return 1;
      if (!reportHasBlockingFindings(report, threshold, evaluation.suppressed)) {
        // Require at least one actual suppression so an unexplained npm exit 1
        // with a vulnerability-shaped but empty/clean report is not swallowed.
        return evaluation.suppressedCount > 0 ? 0 : 1;
      }
      return 1;
    }

    const status = report?.statusCode;
    const transient = status === 408 || status === 429 || (status >= 500 && status < 600)
      || TRANSIENT_NETWORK_ERROR.test([
        result.error?.code, report?.error?.code, report?.message, report?.error?.summary,
      ].join(' '));
    const delay = RETRY_DELAYS_MS[attempt];
    if (!transient || delay === undefined) {
      stderr.write('Dependency audit failed without a valid vulnerability report.\n');
      return result.status || 1;
    }
    stderr.write(`Temporary registry failure; retrying in ${delay / 1000}s.\n`);
    await wait(delay);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await auditDependencies(process.argv.slice(2));
}
