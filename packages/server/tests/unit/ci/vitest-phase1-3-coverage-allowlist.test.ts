import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const CANONICAL_MUTATION_SUITE = 'tests/integration/collections/canonical-mutation-postgres.integration.test.ts';

/**
 * Pinned allowlist of coverage-collect-only integration suites. Every entry
 * stays out of the shared Phase 1-3 coverage collects until the recorded
 * audit issue is resolved; the expiry forces a dated re-review instead of a
 * silent indefinite exclusion. Adding a suite here (and in
 * scripts/phase13-coverage-test-files.mjs) requires an issue reference and a renewal date.
 */
const COVERAGE_COLLECT_ONLY_ALLOWLIST = Object.freeze([
  {
    file: 'tests/integration/postgres/postgres-foundation.integration.test.ts',
    issue: 'docs/audits/known-backend/2026-08-14-final-audit/fix.md#FIX-L-005',
    expires: '2027-01-31',
  },
] as const);

interface CoverageConfigEntry {
  readonly file: string;
  readonly comment: readonly string[];
}

/**
 * Extracts each integrationExcludes entry together with the comment lines
 * attached directly above it in phase13-coverage-test-files.mjs.
 */
function extractIntegrationExcludes(source: string): CoverageConfigEntry[] {
  const start = source.indexOf('export const integrationExcludes = Object.freeze([');
  assert.ok(start >= 0, 'phase13-coverage-test-files.mjs must declare integrationExcludes');
  const end = source.indexOf(']);', start);
  assert.ok(end > start, 'integrationExcludes must be a closed array literal');
  const body = source.slice(start, end);

  const entries: CoverageConfigEntry[] = [];
  let comment: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const entry = /^'(tests\/[^']+)',$/.exec(line);
    if (entry) {
      entries.push({ file: entry[1]!, comment });
      comment = [];
    } else if (line.startsWith('//')) {
      comment.push(line.slice(2).trim());
    } else if (line.length > 0) {
      comment = [];
    }
  }
  return entries;
}

function parseIssueAndExpiry(comment: readonly string[]): { issue: string; expires: string } {
  const joined = comment.join('\n');
  const issueMatch = /issue:\s*(\S+)/u.exec(joined);
  assert.ok(issueMatch, `coverage-collect-only exclusion must declare issue: <tracking reference>`);
  const expiresMatch = /expires:\s*(\d{4}-\d{2}-\d{2})/u.exec(joined);
  assert.ok(expiresMatch, `coverage-collect-only exclusion must declare expires: YYYY-MM-DD`);
  return { issue: issueMatch[1]!, expires: expiresMatch[1]! };
}

function assertValidExpiry(expires: string): void {
  const parsed = new Date(`${expires}T00:00:00.000Z`);
  assert.ok(
    !Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}$/u.test(expires),
    `expires must be a valid YYYY-MM-DD date, got ${expires}`,
  );
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  assert.ok(
    parsed.getTime() >= todayUtc,
    `coverage-collect-only exclusion expires ${expires} (today is ${new Date(todayUtc).toISOString().slice(0, 10)}); ` +
      'renew the issue or remove the exclusion from the coverage collects',
  );
}

describe('Phase 1-3 coverage collect exclusion allowlist', () => {
  test('the canonical mutation suite participates in the integration coverage collect', () => {
    const source = readFileSync(resolve(backendRoot, 'scripts/phase13-coverage-test-files.mjs'), 'utf8');
    const entries = extractIntegrationExcludes(source);
    const excludedFiles = entries.map((entry) => entry.file);
    assert.ok(
      !excludedFiles.includes(CANONICAL_MUTATION_SUITE),
      `${CANONICAL_MUTATION_SUITE} must not be excluded from the integration coverage collect`,
    );
  });

  test('every coverage-collect-only exclusion is allowlisted with an audit issue and a future expiry', () => {
    const source = readFileSync(resolve(backendRoot, 'scripts/phase13-coverage-test-files.mjs'), 'utf8');
    const entries = extractIntegrationExcludes(source);
    const keyExclusions = entries.filter((entry) => (
      entry.comment.some((line) => line.includes('Coverage-collect-only'))
    ));

    assert.deepEqual(
      keyExclusions.map((entry) => entry.file).sort(),
      [...COVERAGE_COLLECT_ONLY_ALLOWLIST.map((entry) => entry.file)].sort(),
      'coverage-collect-only exclusions must match the pinned allowlist exactly',
    );

    for (const allowlisted of COVERAGE_COLLECT_ONLY_ALLOWLIST) {
      const entry = keyExclusions.find((candidate) => candidate.file === allowlisted.file);
      assert.ok(entry, `allowlisted exclusion ${allowlisted.file} must exist in phase13-coverage-test-files.mjs`);
      const { issue, expires } = parseIssueAndExpiry(entry.comment);
      assert.equal(issue, allowlisted.issue, `${allowlisted.file} issue reference must match the allowlist`);
      assert.equal(expires, allowlisted.expires, `${allowlisted.file} expiry must match the allowlist`);
      assertValidExpiry(expires);

      const trackingDoc = issue.split('#')[0]!;
      assert.ok(
        existsSync(resolve(backendRoot, '..', trackingDoc)),
        `${allowlisted.file} issue tracking document ${trackingDoc} must exist`,
      );
    }
  });

  test('the canonical mutation suite keeps its regular integration owner', () => {
    const shardSource = readFileSync(resolve(backendRoot, 'scripts/integration-shard.mjs'), 'utf8');
    const excludedSectionStart = shardSource.indexOf('excludedFiles = new Set');
    assert.ok(excludedSectionStart >= 0, 'integration-shard.mjs must declare excludedFiles');
    const excludedSectionEnd = shardSource.indexOf(']);', excludedSectionStart);
    assert.ok(excludedSectionEnd > excludedSectionStart, 'excludedFiles must be a closed Set literal');
    const excludedSection = shardSource.slice(excludedSectionStart, excludedSectionEnd);
    assert.ok(
      !excludedSection.includes('canonical-mutation-postgres'),
      'the CI integration shards must keep running the canonical mutation suite',
    );

    const packageJson = JSON.parse(
      readFileSync(resolve(backendRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const integrationInner = packageJson.scripts['test:integration:inner'] ?? '';
    assert.ok(integrationInner.includes('tests/integration'), 'test:integration:inner must target tests/integration');
    assert.ok(
      !integrationInner.includes('canonical-mutation-postgres'),
      'test:integration:inner must keep running the canonical mutation suite',
    );
  });
});
