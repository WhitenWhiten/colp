/**
 * End-to-end transport contract for anonymous public Collection Resources.
 *
 * The child process composes the real Phase 4B host projection
 * (`packages/server/src/modules/mcp/collection-resources.ts`) with the real
 * server result wrapper (`createPhase4bMcpResult` in
 * `packages/server/src/modules/mcp/results.ts`), which calls the real
 * `createMcp20260728Result`. The private transport helper
 * `buildDynamicResourceResult` is reproduced only as its four-line SDK schema
 * validation; the projection, cache marker, and result assembly are the
 * shipped implementations.
 *
 * The fixture runs in a dedicated Node child with a source loader that maps
 * `@know-n/colp/*` and repository `.js` specifiers to this checkout's
 * TypeScript sources. That keeps the test runnable from `packages/node`'s own
 * dependency profile (`npm ci` in `packages/node`) even when
 * `packages/server/node_modules` does not exist, as it does not in the node CI
 * test job.
 *
 * This pins the P1 invariant: an anonymous public projection emits
 * `cacheScope: 'public'` with a non-zero TTL plus the trusted caller-independent
 * assertion, and the result factory accepts that host-supplied per-request
 * declaration instead of collapsing it to `-32603`. A scoped/authenticated
 * caller gets a private declaration, and a public TTL without the assertion is
 * still rejected.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const SUPPORT_DIR = resolve(import.meta.dirname, 'support');
const REGISTER_LOADER = resolve(
  SUPPORT_DIR,
  'anonymous-public-resource-transport-register.mjs',
);
const FIXTURE = resolve(SUPPORT_DIR, 'anonymous-public-resource-transport-fixture.mjs');
const NODE_PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLIC_READ_CACHE_TTL_MS = 60_000;

interface CacheObservation {
  readonly cache: {
    readonly ttlMs: number;
    readonly cacheScope: 'public' | 'private';
  };
  readonly callerScope?: 'anonymous';
  readonly callerScopeEnumerable?: boolean;
}

interface ResultObservation {
  readonly resultType: 'complete' | 'input_required';
  readonly ttlMs: number | undefined;
  readonly cacheScope: 'public' | 'private' | undefined;
  readonly hasCallerScope: boolean;
  readonly schemaOk: boolean;
  readonly wireHasCallerScope: boolean;
}

interface TransportReport {
  readonly list: CacheObservation & {
    readonly result: ResultObservation;
    readonly resourceNames: readonly string[];
  };
  readonly read: CacheObservation & {
    readonly result: ResultObservation;
    readonly contentCount: number;
  };
  readonly authenticated: {
    readonly list: CacheObservation;
    readonly read: CacheObservation;
  };
  readonly explicitMarker: ResultObservation;
  readonly unmarkedFactoryError?: string;
  readonly unmarkedWrapperError?: string;
}

let report: TransportReport;

beforeAll(() => {
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', '--import', REGISTER_LOADER, FIXTURE],
    {
      cwd: NODE_PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0) {
    throw new Error([
      `anonymous public Resource transport fixture failed with status ${String(child.status)}`,
      `stdout:\n${child.stdout}`,
      `stderr:\n${child.stderr}`,
    ].join('\n'));
  }
  report = JSON.parse(child.stdout) as TransportReport;
}, 90_000);

function expectPublicAnonymousResult(
  observation: CacheObservation & { readonly result: ResultObservation },
): void {
  expect(observation.cache).toEqual({
    ttlMs: PUBLIC_READ_CACHE_TTL_MS,
    cacheScope: 'public',
  });
  expect(observation.callerScope).toBe('anonymous');
  // The assertion is an internal factory input, never observed cache data.
  expect(observation.callerScopeEnumerable).toBe(false);

  expect(observation.result.resultType).toBe('complete');
  expect(observation.result.ttlMs).toBe(PUBLIC_READ_CACHE_TTL_MS);
  expect(observation.result.cacheScope).toBe('public');
  expect(observation.result.hasCallerScope).toBe(false);
  expect(observation.result.wireHasCallerScope).toBe(false);
  expect(observation.result.schemaOk).toBe(true);
}

describe('anonymous public Resources survive projection -> transport -> factory', () => {
  it('resources/list: anonymous public cache with TTL survives the real transport', () => {
    expectPublicAnonymousResult(report.list);
    expect(report.list.resourceNames).toEqual(['Public Collection']);
  });

  it('resources/read: anonymous public cache with TTL survives the real transport', () => {
    expectPublicAnonymousResult(report.read);
    expect(report.read.contentCount).toBe(1);
  });

  it('authenticated callers stay private and an unmarked public TTL is rejected', () => {
    expect(report.authenticated.list.cache).toEqual({ ttlMs: 0, cacheScope: 'private' });
    expect(report.authenticated.read.cache).toEqual({ ttlMs: 0, cacheScope: 'private' });
    expect(report.authenticated.list.callerScope).toBeUndefined();
    expect(report.authenticated.read.callerScope).toBeUndefined();

    // The explicit marker is accepted, but it never leaks onto the wire.
    expect(report.explicitMarker.ttlMs).toBe(PUBLIC_READ_CACHE_TTL_MS);
    expect(report.explicitMarker.cacheScope).toBe('public');
    expect(report.explicitMarker.hasCallerScope).toBe(false);
    expect(report.explicitMarker.wireHasCallerScope).toBe(false);
    expect(report.explicitMarker.schemaOk).toBe(true);

    // Both the factory and the real server wrapper reject a public TTL that
    // has no caller-independent assertion.
    expect(report.unmarkedFactoryError).toMatch(
      /^TypeError: .*requires the explicit callerScope 'anonymous' assertion\.$/u,
    );
    expect(report.unmarkedWrapperError).toMatch(
      /^TypeError: .*requires the explicit callerScope 'anonymous' assertion\.$/u,
    );
  });
});
