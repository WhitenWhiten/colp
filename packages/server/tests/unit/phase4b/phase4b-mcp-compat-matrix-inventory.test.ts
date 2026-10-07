/**
 * T-08 auditability: every plan §9.1 / §9.2 / §9.3 bullet maps to a real
 * `phase4b-mcp-compat-*.test.ts` file + test title. §9.4 public docs / real
 * binaries stay out of scope with an explicit skip reason.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const phase4bDir = here;
const harnessPath = resolve(here, '../../support/phase4b-mcp-compat-matrix-harness.ts');
const claimGatePath = resolve(here, '../../../src/modules/mcp/read-profile-claim-gate.ts');

interface CoveredBullet {
  readonly id: string;
  readonly section: '9.1' | '9.2' | '9.3' | '9.4';
  readonly bullet: string;
  readonly file: string;
  readonly title: string;
}

interface SkippedBullet {
  readonly id: string;
  readonly section: '9.4';
  readonly bullet: string;
  readonly skipReason: string;
}

const COVERED: readonly CoveredBullet[] = Object.freeze([
  {
    id: '9.1-initialize-11-25',
    section: '9.1',
    bullet: 'initialize offer 2025-11-25 succeeds with body+header 2025-11-25; subsequent header/semantics are 11-25',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'direct 2025-11-25 initialize then initialized, tools/list, and read stay 2025-11-25',
  },
  {
    id: '9.1-codex-06-18-offer',
    section: '9.1',
    bullet: 'Codex-shaped initialize offer 2025-06-18; server selects 2025-11-25; initialized/tools/read succeed; discovery/supported stay 11-25',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'Codex-shaped initialize offer 2025-06-18 is selected as 2025-11-25; operational 11-25 and discovery stay singleton',
  },
  {
    id: '9.1-fixed-06-18',
    section: '9.1',
    bullet: 'fixed 06-18 client disconnects after 11-25; wrongly continuing with 06-18 operational header fails tools/read',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'fixed 2025-06-18 client would disconnect after 11-25; wrongly continuing with 06-18 operational header fails tools/read',
  },
  {
    id: '9.1-older-unknown-offers',
    section: '9.1',
    bullet: 'initialize offers 2025-03-26 / 2024-11-05 / 2024-10-07 / unknown never negotiate those versions; old headers cannot call tools/read',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'initialize offers 2025-03-26 / 2024-11-05 / 2024-10-07 / unknown never negotiate those versions; old operational headers cannot call tools/read',
  },
  {
    id: '9.1-modern-envelope',
    section: '9.1',
    bullet: '07-28 envelope on compat is rejected, not routed as legacy',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: '07-28 modern envelope on compat is rejected and not dispatched as legacy',
  },
  {
    id: '9.1-initialize-on-strict',
    section: '9.1',
    bullet: 'initialize on strict stays existing unsupported',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'initialize on strict /collections/-/mcp stays unsupported',
  },
  {
    id: '9.1-bad-bodies',
    section: '9.1',
    bullet: 'compat missing/wrong content-type, empty/malformed/oversized body, batch: fixed 4xx, no crash',
    file: 'phase4b-mcp-compat-lifecycle.test.ts',
    title: 'bad content-type, empty, malformed, oversized, and batch bodies are fixed 4xx without crash',
  },
  {
    id: '9.1-get-delete-405',
    section: '9.1',
    bullet: 'compat GET/DELETE: 405 + Allow POST + text/plain, no JSON-RPC',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'compat GET and DELETE are 405 text/plain Method not allowed. with Allow POST and no JSON-RPC',
  },
  {
    id: '9.1-session-id',
    section: '9.1',
    bullet: 'initialize does not emit Session ID; forged header does not change stateless identity',
    file: 'phase4b-mcp-compat-matrix.test.ts',
    title: 'initialize does not emit Mcp-Session-Id; a forged session header does not create session identity',
  },
  {
    id: '9.1-disconnect-shutdown',
    section: '9.1',
    bullet: 'client disconnect / shutdown: abort, resource release, no hanging session map',
    file: 'phase4b-mcp-compat-lifecycle.test.ts',
    title: 'client disconnect aborts an in-flight tools/call',
  },
  {
    id: '9.1-shutdown-drain',
    section: '9.1',
    bullet: 'Fastify close stops admission, drains in-flight, leaves no session map',
    file: 'phase4b-mcp-compat-lifecycle.test.ts',
    title: 'Fastify close stops new admission, drains hijacked in-flight, and leaves no session map',
  },
  {
    id: '9.2-resources-list-read',
    section: '9.2',
    bullet: 'tools/resources list, pagination, templates, read, unknown URI',
    file: 'phase4b-mcp-compat-resources.test.ts',
    title: 'resources/list paginates through the signed projection cursor once per request',
  },
  {
    id: '9.2-resource-templates',
    section: '9.2',
    bullet: 'resources/templates/list reuses identity templates',
    file: 'phase4b-mcp-compat-resources.test.ts',
    title: 'resources/templates/list reuses identity templates and omits 07-28 fields',
  },
  {
    id: '9.2-resources-unknown',
    section: '9.2',
    bullet: 'unknown and invalid URIs return a stable error',
    file: 'phase4b-mcp-compat-resources.test.ts',
    title: 'unknown and invalid URIs return a stable error without crashing or leaking internals',
  },
  {
    id: '9.2-visibility',
    section: '9.2',
    bullet: 'anonymous public/unlisted/private/protected vs authorized views',
    file: 'phase4b-mcp-compat-resource-privacy.test.ts',
    title: 'anonymous public vs OAuth owner/member/outsider list the same URIs as the projection',
  },
  {
    id: '9.2-read-tools',
    section: '9.2',
    bullet: 'two read tools schema/result parity',
    file: 'phase4b-mcp-compat-read-tools.test.ts',
    title: 'compat tools/call collections.get matches facade structured content without 07-28 keys',
  },
  {
    id: '9.2-write-tools',
    section: '9.2',
    bullet: 'four write tools, low-risk create, plan/commit mapping',
    file: 'phase4b-mcp-compat-write-tools.test.ts',
    title: 'low-risk nodes.create confirmApply completes without awaiting_approval or 07-28 envelope keys',
  },
  {
    id: '9.2-write-approval',
    section: '9.2',
    bullet: 'plan state machine, approve/reject/expire/revoke, idempotency, cross-binding negative',
    file: 'phase4b-mcp-compat-write-approval.test.ts',
    title: 'reject, expire, and revoked credential fail closed with a stable rejected result',
  },
  {
    id: '9.2-era-fields',
    section: '9.2',
    bullet: 'legacy payload omits 07-28-only fields; strict payload keeps them',
    file: 'phase4b-mcp-compat-resources.test.ts',
    title: 'strict resources/list still includes 07-28 resultType, cache, and item _meta',
  },
  {
    id: '9.2-undeclared-prompts-subscribe',
    section: '9.2',
    bullet: 'does not claim prompts/subscriptions; calling them returns a stable method error',
    file: 'phase4b-mcp-compat-resources.test.ts',
    title: 'compat does not claim prompts or resource subscriptions',
  },
  {
    id: '9.2-undeclared-logging-sampling-roots-tasks',
    section: '9.2',
    bullet: 'does not claim logging/sampling/roots/tasks',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'undeclared logging, sampling, roots, and tasks methods return a stable method error',
  },
  {
    id: '9.3-origin-host',
    section: '9.3',
    bullet: 'Origin/Host allowlist',
    file: 'phase4b-mcp-compat-admission-http.test.ts',
    title: 'Origin allowlist rejects attackers and allows missing Origin like strict',
  },
  {
    id: '9.3-host',
    section: '9.3',
    bullet: 'strict/compat Host allowlist',
    file: 'phase4b-mcp-compat-admission-host.test.ts',
    title: 'strict and compat share one Host allowlist for exact, case, port, and attacker values',
  },
  {
    id: '9.3-oauth-missing',
    section: '9.3',
    bullet: 'OAuth missing/invalid bearer',
    file: 'phase4b-mcp-compat-admission-http.test.ts',
    title: 'invalid bearer on a method that would 401 on strict matches the RFC 6750 challenge',
  },
  {
    id: '9.3-oauth-closed',
    section: '9.3',
    bullet: 'OAuth expired/revoked/wrong issuer/audience/missing scope fail closed',
    file: 'phase4b-mcp-compat-admission-oauth.test.ts',
    title: 'expired, revoked, wrong audience, wrong issuer, and missing scope fail closed',
  },
  {
    id: '9.3-oauth-wrong-client',
    section: '9.3',
    bullet: 'wrong/missing OAuth client',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'wrong or missing OAuth client_id fails closed on compat',
  },
  {
    id: '9.3-security-epoch',
    section: '9.3',
    bullet: 'security epoch mismatch',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'security epoch mismatch fails closed on compat and does not retarget strict',
  },
  {
    id: '9.3-shared-rate',
    section: '9.3',
    bullet: 'strict/compat switching cannot bypass request/commit rate',
    file: 'phase4b-mcp-compat-admission-oauth.test.ts',
    title: 'exhausting quota on strict rate-limits compat POST and vice versa',
  },
  {
    id: '9.3-shared-concurrency',
    section: '9.3',
    bullet: 'strict/compat switching cannot bypass concurrency',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'strict/compat share one connection budget so switching endpoints cannot bypass concurrency',
  },
  {
    id: '9.3-token-taint',
    section: '9.3',
    bullet: 'raw token taint across logs/metrics/context/response',
    file: 'phase4b-mcp-compat-admission-oauth.test.ts',
    title: 'canary bearer never appears in admission context, logs, metrics, or response',
  },
  {
    id: '9.3-metrics-allowlist',
    section: '9.3',
    bullet: 'logs/metrics label allowlist and high-cardinality negative',
    file: 'phase4b-mcp-compat-operations.test.ts',
    title: 'allowlist is a small frozen suffix set and never a cartesian mega-name',
  },
  {
    id: '9.3-db-leak',
    section: '9.3',
    bullet: 'DB exception does not leak internals',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'DB exception on resources/list does not leak internals or retarget',
  },
  {
    id: '9.4-well-known',
    section: '9.4',
    bullet: '/.well-known/mcp old fields unchanged; new fields match config',
    file: 'phase4b-mcp-compat-discovery.test.ts',
    title: 'flag on adds frozen well-known endpoints without changing top-level strict fields',
  },
  {
    id: '9.3-jwks',
    section: '9.3',
    bullet: 'JWKS dependency failure',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'JWKS fetch failure fails closed without leaking internals or retargeting',
  },
  {
    id: '9.3-redis',
    section: '9.3',
    bullet: 'Redis/limiter dependency failure',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'Redis limiter unavailability is 503 on compat and does not retarget or replay writes',
  },
  {
    id: '9.3-approval-dep',
    section: '9.3',
    bullet: 'approval store dependency failure',
    file: 'phase4b-mcp-compat-readiness.test.ts',
    title: 'write-on approval store fault 503s compat and leaves strict read green',
  },
  {
    id: '9.3-sdk-exception',
    section: '9.3',
    bullet: 'SDK exception mapping',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'SDK exception mapping hides internals and does not retarget the other endpoint',
  },
  {
    id: '9.3-overflow',
    section: '9.3',
    bullet: 'output overflow',
    file: 'phase4b-mcp-compat-read-tools.test.ts',
    title: 'over-budget tool output and abort map to stable errors without leaking internals',
  },
  {
    id: '9.3-timeout',
    section: '9.3',
    bullet: 'timeout mapping',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'request timeout aborts in-flight compat work without retargeting strict',
  },
  {
    id: '9.3-no-retarget',
    section: '9.3',
    bullet: '401/403/5xx/timeout must not retarget the other endpoint',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: '401, 403, 5xx, and timeout on compat do not automatically fall back to strict',
  },
  {
    id: '9.3-flag-off',
    section: '9.3',
    bullet: 'flag off / canary rollback 404',
    file: 'phase4b-mcp-compat-faults.test.ts',
    title: 'canary rollback (flag off) 404s compat surfaces and leaves strict registered',
  },
  {
    id: '9.3-read-flag-off',
    section: '9.3',
    bullet: 'KNOWN_FEATURE_MCP_READ=false + compat on fails closed at config',
    file: 'phase4b-mcp-compat-config.test.ts',
    title: 'compat on with read off or absent fails closed at loadConfig',
  },
  {
    id: '9.3-illegal-config',
    section: '9.3',
    bullet: 'illegal flag values and forbidden legacy env fail closed',
    file: 'phase4b-mcp-compat-config.test.ts',
    title: 'invalid MCP compat flag values fail closed like the read flag',
  },
  {
    id: '9.4-wrapper-pin',
    section: '9.4',
    bullet: 'real-client wrapper refuses non-pinned Codex/Claude versions',
    file: 'phase4b-mcp-compat-real-clients.test.ts',
    title: 'wrapper refuses Codex and Claude versions that are not the T-09 pins',
  },
]);

const OUT_OF_SCOPE: readonly SkippedBullet[] = Object.freeze([
  {
    id: '9.4-mcp-md-llms',
    section: '9.4',
    bullet: 'mcp.md and llms source/generated endpoint/version/config consistent',
    skipReason: 'T-10 public docs; T-08 must not edit mcp.md / llms.md / public/',
  },
  {
    id: '9.4-codex-claude-binaries',
    section: '9.4',
    bullet: 'Codex CLI 0.150.1 and Claude Code 2.1.250 fixed-binary E2E',
    skipReason: 'T-09 real binaries; 2026-08-28 evidence records handshake pass and full-checklist fail; curl/SDK/wrapper pin tests are not a substitute; recommendedClients stays empty',
  },
  {
    id: '9.4-real-approval-operator',
    section: '9.4',
    bullet: 'real-client approval must be operator-confirmed on a desensitized fixture account',
    skipReason: 'T-09 real-client E2E; T-08 must not fake operator approval',
  },
]);

const REQUIRED_IDS = Object.freeze([
  '9.1-initialize-11-25',
  '9.1-codex-06-18-offer',
  '9.1-fixed-06-18',
  '9.1-older-unknown-offers',
  '9.1-modern-envelope',
  '9.1-initialize-on-strict',
  '9.1-bad-bodies',
  '9.1-get-delete-405',
  '9.1-session-id',
  '9.1-disconnect-shutdown',
  '9.2-resources-list-read',
  '9.2-visibility',
  '9.2-read-tools',
  '9.2-write-tools',
  '9.2-write-approval',
  '9.2-era-fields',
  '9.2-undeclared-prompts-subscribe',
  '9.2-undeclared-logging-sampling-roots-tasks',
  '9.3-origin-host',
  '9.3-oauth-closed',
  '9.3-oauth-wrong-client',
  '9.3-security-epoch',
  '9.3-shared-rate',
  '9.3-shared-concurrency',
  '9.3-token-taint',
  '9.3-metrics-allowlist',
  '9.3-jwks',
  '9.3-timeout',
  '9.3-no-retarget',
  '9.3-flag-off',
  '9.3-read-flag-off',
]);

function hasTestTitle(source: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\btest\\('${escaped}'`, 'u').test(source);
}

test('every §9.1 / §9.2 / §9.3 bullet maps to an existing test file and title', () => {
  const coveredIds = new Set(COVERED.map((entry) => entry.id));
  for (const id of REQUIRED_IDS) {
    assert.equal(coveredIds.has(id), true, `required bullet ${id} must be inventoried`);
  }
  const files = new Map<string, string>();
  for (const entry of COVERED) {
    let source = files.get(entry.file);
    if (source === undefined) {
      source = readFileSync(resolve(phase4bDir, entry.file), 'utf8');
      files.set(entry.file, source);
    }
    assert.equal(
      hasTestTitle(source, entry.title),
      true,
      `${entry.id} missing test('${entry.title}') in ${entry.file}`,
    );
  }
});

test('§9.4 mcp.md and real binaries are inventoried as out of scope with skip reasons', () => {
  assert.equal(OUT_OF_SCOPE.length >= 3, true);
  for (const entry of OUT_OF_SCOPE) {
    assert.match(entry.skipReason, /T-09|T-10/u);
    assert.doesNotMatch(entry.skipReason, /covered by T-0[0-8]/u);
  }
  const ids = OUT_OF_SCOPE.map((entry) => entry.id).sort();
  assert.deepEqual(ids, [
    '9.4-codex-claude-binaries',
    '9.4-mcp-md-llms',
    '9.4-real-approval-operator',
  ]);
});

test('fixed client harness speaks raw inject JSON-RPC and does not import the SDK client', () => {
  const source = readFileSync(harnessPath, 'utf8');
  assert.match(source, /injectCompatLegacyPost/u);
  assert.match(source, /MCP-Protocol-Version|mcp-protocol-version/u);
  assert.doesNotMatch(source, /from ['"]@modelcontextprotocol\/client['"]/u);
  assert.doesNotMatch(source, /require\(['"]@modelcontextprotocol\/client['"]\)/u);
  assert.doesNotMatch(source, /\bnew\s+Client\s*\(/u);
});

test('compat path is not a Product OpenAPI route and COLP SDK lock omits @modelcontextprotocol/node', () => {
  for (const route of PRODUCT_ROUTE_MANIFEST) {
    assert.equal(route.path.includes('mcp-compat'), false, route.path);
    assert.equal(route.path.includes('/collections/-/mcp'), false, route.path);
  }
  const claimGate = readFileSync(claimGatePath, 'utf8');
  assert.match(claimGate, /MCP_20260728_SDK_LOCK/u);
  assert.doesNotMatch(claimGate, /@modelcontextprotocol\/node/u);
});

test('on-disk phase4b-mcp-compat-*.test.ts files are the unit matrix glob', () => {
  const names = readdirSync(phase4bDir)
    .filter((name) => /^phase4b-mcp-compat-.*\.test\.ts$/u.test(name))
    .sort();
  assert.ok(names.includes('phase4b-mcp-compat-matrix.test.ts'));
  assert.ok(names.includes('phase4b-mcp-compat-matrix-inventory.test.ts'));
  assert.ok(names.includes('phase4b-mcp-compat-faults.test.ts'));
  assert.equal(names.some((name) => name.includes('e2e') || name.includes('codex-binary')), false);
});
