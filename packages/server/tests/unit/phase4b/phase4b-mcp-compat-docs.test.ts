/**
 * T-11: pin architecture / plan-index / audit / env / compose / runbook facts.
 * Markdown and env files are the SUT. Do not grep production TypeScript.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repoRoot = resolve(backendRoot, '..');

function readRepo(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readBackend(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function pin(source: string, token: string, label: string): void {
  assert.match(source, new RegExp(escapeRegExp(token), 'u'), label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const architecture = readBackend('docs/00-architecture-overview.md');
const boundaries = readBackend('docs/01-module-boundaries.md');
const protocol = readBackend('docs/03-api-and-protocol-boundaries.md');
const security = readBackend('docs/05-security-and-operations.md');
const roadmap = readBackend('docs/06-delivery-roadmap.md');
const phaseStatus = readBackend('docs/09-phase-execution-status.md');
const backendReadme = readBackend('docs/README.md');
const readRunbook = readBackend('docs/runbooks/mcp-read-operations.md');
const writeRunbook = readBackend('docs/runbooks/mcp-write-operations.md');
const compatRunbook = readBackend('docs/runbooks/mcp-compat-operations.md');
const backendEnv = readBackend('.env.example');
const docsIndex = readRepo('docs/README.md');
const plansIndex = readRepo('docs/plans/README.md');
const activeIndex = readRepo('docs/plans/active/README.md');
const plan = readRepo('docs/plans/active/cross-module/mcp-client-compatibility-plan.md');
const decisionsIndex = readRepo('docs/decisions/README.md');
const usabilityOpen = readRepo('docs/audits/cross-module/2026-08-27-mcp-usability-audit/open.md');
const usabilityRemediation = readRepo(
  'docs/audits/cross-module/2026-08-27-mcp-usability-audit/remediation.md',
);
const firstTouchOpen = readRepo('docs/audits/cross-module/2026-08-27-mcp-first-touch-audit/open.md');
const firstTouchRemediation = readRepo(
  'docs/audits/cross-module/2026-08-27-mcp-first-touch-audit/remediation.md',
);
const devopsEnv = readRepo('devops/.env.example');
const compose = readRepo('devops/docker-compose.yml');
const remote = readRepo('devops/lib/remote.sh');
const t09Evidence = readBackend('docs/evidence/mcp-client-compatibility-acceptance-2026-08-28.md');

test('backend docs index keeps dual-surface, runbook, and T-09 evidence nav', () => {
  pin(backendReadme, '00-architecture-overview.md', 'architecture nav');
  pin(backendReadme, 'strict/Profile 与 host compatibility 双表面', 'architecture dual-surface blurb');
  pin(backendReadme, 'runbooks/mcp-compat-operations.md', 'compat operations nav');
  pin(backendReadme, 'runbooks/mcp-compat-real-clients.md', 'real-clients nav');
  pin(
    backendReadme,
    'evidence/mcp-client-compatibility-acceptance-2026-08-28.md',
    'T-09 evidence nav',
  );
});

test('architecture overview records dual MCP surfaces and a shared era-neutral facade', () => {
  pin(architecture, 'POST /collections/-/mcp', 'strict path');
  pin(architecture, '2026-07-28', 'strict protocol');
  pin(architecture, 'POST /collections/-/mcp-compat', 'compat path');
  pin(architecture, 'host compatibility', 'host compatibility label');
  pin(architecture, 'era-neutral facade', 'shared facade');
  assert.match(
    architecture,
    /MCP dual surface|compat 11-25|mcp-compat/u,
    'mermaid/context must not remain MCP-Read-only',
  );
  assert.doesNotMatch(
    architecture,
    /call strict handler then strip|调用严格 wire handler 再删字段/iu,
    'must not describe strip-after-strict',
  );
});

test('module boundaries pin adapter→facade direction and host SDK use', () => {
  pin(boundaries, 'mcp-compat-*.ts', 'compat transport adapters');
  pin(boundaries, 'era-neutral facade', 'shared facade');
  pin(boundaries, 'must not depend on Fastify', 'facade not Fastify');
  pin(boundaries, 'SDK wire', 'facade not SDK wire');
  pin(boundaries, '@modelcontextprotocol/server', 'compat server SDK');
  pin(boundaries, '@modelcontextprotocol/node', 'compat node adapter');
  pin(boundaries, 'compat transport only', 'SDK scope');
  pin(boundaries, 'COLP Profile lock', 'profile lock unchanged');
});

test('protocol boundaries pin endpoint, 405, versions, PRM, and profile review', () => {
  pin(protocol, 'POST /collections/-/mcp', 'strict POST');
  pin(protocol, 'POST /collections/-/mcp-compat', 'compat POST');
  pin(protocol, '405', 'method not allowed status');
  pin(protocol, 'text/plain', '405 content type');
  pin(protocol, 'Method not allowed.', '405 body');
  pin(protocol, '["2025-11-25"]', 'supported versions singleton');
  pin(protocol, 'no COLP Profile claim', 'compat is not Profile');
  pin(protocol, 'shared OAuth audience', 'shared audience');
  pin(protocol, 'route absent', 'flag off');
  pin(protocol, 'deploy/compose default on', 'deploy default on');
  pin(protocol, 'offer `2025-06-18`', 'Codex offer');
  pin(protocol, 'selects `2025-11-25`', 'server select');
  pin(protocol, 'https://github.com/WhitenWhiten/colp/blob/main/protocol/docs/05-mcp-profile.md', 'profile doc path');
  pin(protocol, '2026-08-28', 'review date');
  pin(protocol, '已检查、无需改', 'checked no change');
  pin(protocol, 'not Markdown-only', 'well-known is a machine contract');
  pin(protocol, 'phase4b-mcp-compat-discovery.test.ts', 'existing discovery tests');
});

test('security docs pin shared audience, sentinel, admission order, metrics, rollback', () => {
  pin(security, 'shared OAuth audience', 'shared audience');
  pin(security, 'verified-upstream', 'AuthInfo sentinel');
  pin(security, 'Origin → concurrency → OAuth then rate', 'strict admission order');
  pin(security, 'shared limiter', 'shared limiter');
  pin(security, 'mcp.compat.*', 'compat metrics prefix');
  pin(security, 'rollback is flag off only', 'rollback');
});

test('roadmap adds post-4B host compat without rewriting Phase 4B exit facts', () => {
  pin(roadmap, '### Phase 4B：MCP Read', 'historical Phase 4B heading');
  pin(roadmap, '本后端挂载真实 MCP transport/resource routes', 'historical 4B exit');
  pin(roadmap, 'post-4B additive', 'additive track');
  pin(roadmap, 'T-00–T-10', 'source in tree');
  pin(roadmap, 'T-09 handshake-only', 'handshake-only');
  pin(roadmap, 'T-12 rollout is not executed', 'no T-12');
  pin(roadmap, 'KNOWN_FEATURE_MCP_COMPAT', 'flag name');
  pin(roadmap, 'default true', 'flag default');
});

test('phase status keeps Phase 4B Verified and adds a separate host-compat row', () => {
  pin(phaseStatus, '最后更新：2026-08-28', 'status date');
  assert.match(
    phaseStatus,
    /^\| Phase 4B：MCP Read\/Write \| \*\*Verified\*\*/mu,
    'Phase 4B Verified row intact',
  );
  pin(phaseStatus, 'separate increment', '4B pointer to compat');
  assert.match(phaseStatus, /^\| Host MCP compatibility \|/mu, 'separate host-compat row');
  assert.doesNotMatch(
    phaseStatus,
    /^\| Host MCP compatibility \| \*\*Verified\*\*/mu,
    'host compat is not Verified',
  );
  pin(phaseStatus, 'handshake-only', 'handshake-only evidence');
  pin(phaseStatus, 'mcp-client-compatibility-acceptance-2026-08-28.md', 'T-09 evidence link');
  pin(phaseStatus, 'T-12', 'next gate includes rollout');
  pin(phaseStatus, 'Deploy/compose default on', '09 deploy default');
});

test('read/write runbooks keep strict-metrics and shared-quota facts', () => {
  pin(readRunbook, 'mcp.read.*', 'strict metrics unchanged');
  pin(readRunbook, 'mcp-compat-operations.md', 'compat link');
  pin(writeRunbook, 'awaiting_approval', 'legacy out-of-band mapping');
  pin(writeRunbook, 'plan binding', 'shared plan binding');
  pin(writeRunbook, 'mcp-compat-operations.md', 'compat link');
});

test('compat runbook adds production gray notes without a support claim', () => {
  pin(compatRunbook, 'off → staging → internal canary → percent', 'production promotion');
  pin(compatRunbook, 'route absent', 'flag off');
  pin(compatRunbook, 'handshake', 'T-09 honesty');
  pin(compatRunbook, 'recommendedClients', 'clients list remains empty');
  assert.doesNotMatch(
    compatRunbook,
    /Codex(?: CLI)? (?:and|&|\/) Claude (?:Code )?are supported|已支持 Codex|supported clients/iu,
    'must not claim clients supported',
  );
});

test('plan indexes keep Proposed/active and correct the supported-version claim', () => {
  pin(plan, 'status: proposed', 'plan frontmatter');
  pin(docsIndex, 'plans/active/cross-module/mcp-client-compatibility-plan.md', 'active path');
  pin(plansIndex, 'active/cross-module/mcp-client-compatibility-plan.md', 'plans index path');
  pin(activeIndex, 'cross-module/mcp-client-compatibility-plan.md', 'active index path');
  pin(docsIndex, '**Proposed**', 'docs index Proposed');
  pin(plansIndex, '**Proposed**', 'plans index Proposed');
  pin(activeIndex, '**Proposed**', 'active index Proposed');
  assert.doesNotMatch(docsIndex, /plans\/completed\/.*mcp-client-compatibility-plan/u, 'not archived');
  assert.doesNotMatch(plansIndex, /仅支持 `2025-06-18` 与 `2025-11-25`/u, 'plans index not dual-support');
  assert.doesNotMatch(
    activeIndex,
    /Codex CLI 0\.150\.1（MCP `2025-06-18`）/u,
    'active index not Codex=06-18',
  );
  assert.doesNotMatch(
    docsIndex,
    /Codex CLI 0\.150\.1（MCP `2025-06-18`）/u,
    'docs index not Codex=06-18',
  );
  for (const [label, source] of [
    ['docs index', docsIndex],
    ['plans index', plansIndex],
    ['active index', activeIndex],
  ] as const) {
    pin(source, '2025-11-25', `${label} names 11-25`);
    pin(source, '2025-06-18', `${label} still mentions Codex offer`);
    pin(source, 'not operational', `${label} offer is not operational support`);
  }
  pin(decisionsIndex, 'legacy-client-compatibility-adr.md', 'T-00 ADR indexed');
});

test('T-09 evidence stays handshake-only and is only linked', () => {
  pin(t09Evidence, 'MCP_COMPAT_RECOMMENDED_CLIENTS', 'evidence still names the empty list');
  pin(t09Evidence, '[]', 'recommendedClients empty in evidence');
  pin(phaseStatus, 'mcp-client-compatibility-acceptance-2026-08-28.md', '09 links evidence');
  pin(firstTouchOpen, 'mcp-client-compatibility-acceptance-2026-08-28.md', 'audit links evidence');
});

test('usability audit keeps P1–P5 checked and only notes host-compat docs', () => {
  pin(usabilityOpen, '- [x] MCP-U-01', 'P1 remains checked');
  pin(usabilityOpen, '- [x] MCP-U-12', 'P5 CIMD remains checked');
  pin(usabilityOpen, '2026-08-28', 'dated note');
  pin(usabilityOpen, 'host compat docs', 'docs exist note');
  pin(usabilityRemediation, '2026-08-28', 'remediation dated note');
  assert.doesNotMatch(usabilityOpen, /client-support matrix complete/iu, 'not a support matrix');
});

test('MCP2-11 stays open with honest handshake-only 2026-08-28 notes', () => {
  assert.match(firstTouchOpen, /^- \[ \] MCP2-11/mu, 'MCP2-11 checkbox remains open');
  assert.doesNotMatch(firstTouchOpen, /^- \[x\] MCP2-11/mu, 'MCP2-11 must not be checked');
  pin(firstTouchOpen, '2026-08-28', 'dated handshake note');
  pin(firstTouchOpen, 'Codex CLI 0.150.1', 'Codex handshake');
  pin(firstTouchOpen, 'Claude Code 2.1.250', 'Claude handshake');
  pin(firstTouchOpen, '/mcp-compat', 'compat path');
  pin(firstTouchOpen, 'Not tested', 'remaining cells');
  pin(firstTouchOpen, 'recommendedClients', 'empty list named');
  pin(firstTouchOpen, '[]', 'empty list');
  pin(firstTouchRemediation, '2026-08-28', 'remediation dated note');
  pin(firstTouchRemediation, 'OPEN', 'item remains OPEN');
  assert.doesNotMatch(firstTouchOpen, /Hermes.*tested|OpenClaw.*tested/iu, 'Hermes/OpenClaw not tested');
  assert.doesNotMatch(firstTouchOpen, /full Codex\/Claude support/iu, 'not full support');
});

test('.env.example documents deploy-on and keeps the backend template off until read is on', () => {
  pin(backendEnv, 'KNOWN_FEATURE_MCP_COMPAT=false', 'backend template stays off');
  pin(backendEnv, 'Deploy/compose default is on', 'deploy default on');
  pin(backendEnv, 'unique flag', 'unique flag');
  pin(backendEnv, '2025-11-25', 'supported version');
  pin(backendEnv, '2025-06-18', 'Codex offer');
  pin(backendEnv, 'not operational support', 'offer is not support');
  pin(backendEnv, 'no session/Redis', 'no session config');
  pin(backendEnv, 'rollback = flag off', 'rollback');
  pin(backendEnv, 'not a license to set MCP_PROTOCOL_MODE=legacy', 'not legacy mode');
  pin(
    backendEnv,
    'Legacy MCP 2025-11-25 configuration (MCP_PROTOCOL_MODE, MCP_PROTOCOL_VERSION,',
    'strict fail-closed comments remain',
  );
});

test('devops env, compose, and prod generator default the unique flag on and pass it through', () => {
  pin(devopsEnv, 'KNOWN_FEATURE_MCP_COMPAT=true', 'devops env default');
  pin(compose, 'KNOWN_FEATURE_MCP_READ: "${KNOWN_FEATURE_MCP_READ:-true}"', 'read compose passthrough');
  pin(compose, 'KNOWN_FEATURE_MCP_COMPAT: "${KNOWN_FEATURE_MCP_COMPAT:-true}"', 'compat compose passthrough');
  pin(remote, 'KNOWN_FEATURE_MCP_READ=true', 'prod generator read on');
  pin(remote, 'KNOWN_FEATURE_MCP_COMPAT=true', 'prod generator compat on');
  assert.doesNotMatch(compose, /MCP_SESSION_/u, 'compose adds no session keys');
  assert.doesNotMatch(remote, /MCP_SESSION_/u, 'remote adds no session keys');
});
