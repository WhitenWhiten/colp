/**
 * T-07: frozen `mcp.compat.*` metric grammar, live operations counters,
 * and the compat runbook contract. No `vi.mock` of the SUT.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { Metrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST,
  PHASE4B_MCP_COMPAT_METRIC_PREFIX,
  classifyMcpCompatClientFamily,
  classifyMcpCompatClientFamilyFromBody,
  classifyMcpCompatInitializeOffer,
  classifyMcpCompatMethodFamily,
  createMcpCompatReadinessDocument,
  createPhase4bMcpCompatOperations,
  type Phase4bMcpCompatOperations,
} from '../../../src/modules/mcp/index.js';
import { CODEX_CLIENT } from '../../support/phase4b-mcp-compat-matrix-harness.js';

class RecordingMetrics implements Metrics {
  readonly names: string[] = [];
  private readonly values = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.names.push(name);
    this.values.set(name, (this.values.get(name) ?? 0) + value);
  }

  gauge(name: string, value: number): void {
    this.names.push(name);
    this.values.set(name, value);
  }

  observe(name: string, value: number): void {
    this.names.push(name);
    const samples = this.samples.get(name) ?? [];
    samples.push(value);
    this.samples.set(name, samples);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  observations(name: string): readonly number[] {
    return [...(this.samples.get(name) ?? [])];
  }
}

const FORBIDDEN_METRIC = /(?:uri|collection|node|principal|subject|origin|token|secret|content|argument|request_id|authorization|user.?agent|clientinfo|planid|plan_id|correlation)/iu;

function createOperations(
  overrides: Partial<Parameters<typeof createPhase4bMcpCompatOperations>[0]> = {},
): {
  readonly operations: Phase4bMcpCompatOperations;
  readonly metrics: RecordingMetrics;
} {
  const metrics = new RecordingMetrics();
  const operations = createPhase4bMcpCompatOperations({
    metrics,
    maxConcurrentRequests: 2,
    maxQueuedRequests: 1,
    oauthHealth: async () => ({
      oauth: 'ready',
      signalSource: 'ready',
      projection: 'ready',
    }),
    limiterHealth: async () => 'ready' as const,
    ...overrides,
  });
  return { operations, metrics };
}

function assertSafeNames(names: readonly string[]): void {
  const allowlist = new Set(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST);
  for (const name of names) {
    assert.equal(name.startsWith(`${PHASE4B_MCP_COMPAT_METRIC_PREFIX}.`), true, name);
    assert.equal(allowlist.has(name), true, `not allowlisted: ${name}`);
    assert.doesNotMatch(name, FORBIDDEN_METRIC, name);
    assert.doesNotMatch(name, /^mcp\.read\./u, name);
    assert.doesNotMatch(name, /^mcp\.write\./u, name);
    assert.doesNotMatch(name, /offer\.[^.]+\.revision/u, name);
    assert.doesNotMatch(name, /revision\.[^.]+\.offer/u, name);
  }
}

test('method, offer, and client-family classifiers stay on the frozen allowlists', () => {
  assert.equal(classifyMcpCompatMethodFamily({ method: 'initialize' }), 'handshake');
  assert.equal(classifyMcpCompatMethodFamily({ method: 'notifications/initialized' }), 'handshake');
  assert.equal(classifyMcpCompatMethodFamily({ method: 'tools/list' }), 'catalog');
  assert.equal(classifyMcpCompatMethodFamily({ method: 'resources/list' }), 'catalog');
  assert.equal(classifyMcpCompatMethodFamily({ method: 'resources/templates/list' }), 'catalog');
  assert.equal(classifyMcpCompatMethodFamily({ method: 'resources/read' }), 'read');
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'collections.get' } }),
    'read',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({
      method: 'tools/call',
      params: { name: 'collections.get_snapshot' },
    }),
    'read',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'nodes.get' } }),
    'read',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'nodes.create' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'nodes.update' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'collections.update' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'annotations.create' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'annotations.update' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'changes.plan' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'changes.cancel' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'changes.get' } }),
    'write_plan',
  );
  assert.equal(
    classifyMcpCompatMethodFamily({ method: 'tools/call', params: { name: 'changes.commit' } }),
    'write_commit',
  );
  assert.equal(classifyMcpCompatMethodFamily({ method: 'prompts/list' }), 'other');
  assert.equal(classifyMcpCompatMethodFamily(null), 'other');

  assert.equal(
    classifyMcpCompatInitializeOffer({ method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    '2025-11-25',
  );
  assert.equal(
    classifyMcpCompatInitializeOffer({ method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    '2025-06-18',
  );
  assert.equal(
    classifyMcpCompatInitializeOffer({ method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    'other',
  );
  assert.equal(classifyMcpCompatInitializeOffer({ method: 'tools/list' }), undefined);

  assert.equal(CODEX_CLIENT.name, 'codex_cli');
  assert.equal(classifyMcpCompatClientFamily('codex'), 'codex');
  assert.equal(classifyMcpCompatClientFamily(CODEX_CLIENT.name), 'codex');
  assert.equal(classifyMcpCompatClientFamily('  CODEX_CLI  '), 'codex');
  assert.equal(classifyMcpCompatClientFamily('Claude-Code'), 'claude-code');
  assert.equal(classifyMcpCompatClientFamily('Claude Code'), 'claude-code');
  assert.equal(classifyMcpCompatClientFamily('Cursor'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily('codex-cli'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily('my-codex'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily('codex-cli-evil'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily('codex_cli_evil'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily('codexcli'), 'unknown');
  assert.equal(classifyMcpCompatClientFamily({ name: 'codex' }), 'unknown');
  assert.equal(
    classifyMcpCompatClientFamilyFromBody({
      method: 'initialize',
      params: { clientInfo: CODEX_CLIENT },
    }),
    'codex',
  );
  assert.equal(
    classifyMcpCompatClientFamilyFromBody({
      method: 'initialize',
      params: { clientInfo: { name: 'codex-cli', version: '0' } },
    }),
    'unknown',
  );
});

test('allowlist is a small frozen suffix set and never a cartesian mega-name', () => {
  assert.equal(PHASE4B_MCP_COMPAT_METRIC_PREFIX, 'mcp.compat');
  assert.equal(Object.isFrozen(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST), true);
  assert.ok(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST.length < 80);
  assert.ok(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST.includes('mcp.compat.handshake.offer.2025_06_18'));
  assert.ok(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST.includes('mcp.compat.handshake.revision.2025_11_25'));
  assert.equal(
    PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST.includes('mcp.compat.handshake.revision.2025_06_18'),
    false,
  );
  assertSafeNames(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST);
});

test('finish emits separate low-cardinality counters and never identity labels', () => {
  const { operations, metrics } = createOperations();
  const handle = operations.beginRequest({ controller: new AbortController() });
  handle.finish({
    outcome: 'ok',
    methodFamily: 'catalog',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
  });
  const authHandle = operations.beginRequest({ controller: new AbortController() });
  authHandle.finish({
    outcome: 'auth_required',
    methodFamily: 'read',
    auth: 'bearer',
    era: 'legacy',
    protocolRevision: '2025-11-25',
    rejectCategory: 'auth',
  });
  const modernHandle = operations.beginRequest({ controller: new AbortController() });
  modernHandle.finish({
    outcome: 'rejected',
    methodFamily: 'catalog',
    auth: 'anonymous',
    era: 'modern',
    protocolRevision: 'unsupported',
    rejectCategory: 'unsupported',
  });

  assert.equal(metrics.get('mcp.compat.requests.total'), 3);
  assert.equal(metrics.get('mcp.compat.requests.outcome.ok'), 1);
  assert.equal(metrics.get('mcp.compat.requests.outcome.auth_required'), 1);
  assert.equal(metrics.get('mcp.compat.requests.outcome.rejected'), 1);
  assert.equal(metrics.get('mcp.compat.requests.method.catalog'), 2);
  assert.equal(metrics.get('mcp.compat.requests.method.read'), 1);
  assert.equal(metrics.get('mcp.compat.requests.auth.anonymous'), 2);
  assert.equal(metrics.get('mcp.compat.requests.auth.bearer'), 1);
  assert.equal(metrics.get('mcp.compat.requests.era.legacy'), 2);
  assert.equal(metrics.get('mcp.compat.requests.era.modern'), 1);
  assert.equal(metrics.get('mcp.compat.requests.revision.2025_11_25'), 2);
  assert.equal(metrics.get('mcp.compat.requests.revision.unsupported'), 1);
  assert.equal(metrics.get('mcp.compat.reject.auth'), 1);
  assert.equal(metrics.get('mcp.compat.reject.unsupported'), 1);
  assert.equal(metrics.get('mcp.read.requests.total'), 0);
  assert.equal(metrics.get('mcp.write.inspect.total'), 0);
  assertSafeNames(metrics.names);

  const snapshot = operations.inspect();
  assert.equal(snapshot.counts.activeRequests, 0);
  assert.equal(snapshot.rejectCounts.auth, 1);
  assert.equal(snapshot.rejectCounts.unsupported, 1);
  assert.equal(snapshot.rejectCounts.total, 2);
  const blob = JSON.stringify(snapshot);
  assert.doesNotMatch(blob, FORBIDDEN_METRIC);
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['admitting', 'counts', 'rejectCounts'].sort(),
  );
});

test('handshake records initialize_offer separately from negotiated protocol_revision', () => {
  const { operations, metrics } = createOperations();
  const handle = operations.beginRequest({ controller: new AbortController() });
  handle.finish({
    outcome: 'ok',
    methodFamily: 'handshake',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
    handshake: { offer: '2025-06-18', clientFamily: 'codex' },
  });
  assert.equal(metrics.get('mcp.compat.handshake.offer.2025_06_18'), 1);
  assert.equal(metrics.get('mcp.compat.handshake.offer.2025_11_25'), 0);
  assert.equal(metrics.get('mcp.compat.handshake.revision.2025_11_25'), 1);
  assert.equal(metrics.get('mcp.compat.client.codex'), 1);
  assert.equal(
    metrics.names.some((name) => name.includes('2025_06_18') && name.includes('revision')),
    false,
  );
  assert.equal(
    metrics.names.includes('mcp.compat.handshake.revision.2025_06_18'),
    false,
  );
  assertSafeNames(metrics.names);
});

test('client_family suffix never embeds the raw clientInfo name', () => {
  const { operations, metrics } = createOperations();
  const handle = operations.beginRequest({ controller: new AbortController() });
  handle.finish({
    outcome: 'ok',
    methodFamily: 'handshake',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
    handshake: { offer: '2025-11-25', clientFamily: 'unknown' },
  });
  assert.equal(metrics.get('mcp.compat.client.unknown'), 1);
  assert.equal(metrics.get('mcp.compat.client.claude_code'), 0);
  const blob = metrics.names.join('\n');
  assert.doesNotMatch(blob, /Cursor|claude-code-insiders|codex-cli|codex_cli/u);
  assertSafeNames(metrics.names);
});

test('codex_cli initialize family increments codex and never unknown or a raw-name label', () => {
  const { operations, metrics } = createOperations();
  const handle = operations.beginRequest({ controller: new AbortController() });
  handle.finish({
    outcome: 'ok',
    methodFamily: 'handshake',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
    handshake: {
      offer: '2025-06-18',
      clientFamily: classifyMcpCompatClientFamily(CODEX_CLIENT.name),
    },
  });
  assert.equal(metrics.get('mcp.compat.client.codex'), 1);
  assert.equal(metrics.get('mcp.compat.client.unknown'), 0);
  assert.equal(metrics.names.includes('mcp.compat.client.codex_cli'), false);
  assert.doesNotMatch(metrics.names.join('\n'), /codex_cli/u);
  assertSafeNames(metrics.names);
});

test('drain stops admission, aborts registered work, and does not reopen', async () => {
  const { operations, metrics } = createOperations();
  const controller = new AbortController();
  const handle = operations.beginRequest({ controller });
  assert.equal(handle.registered, true);
  assert.equal(operations.isAdmitting(), true);
  operations.drain();
  assert.equal(controller.signal.aborted, true);
  assert.equal(operations.isAdmitting(), false);
  assert.equal(metrics.get('mcp.compat.drain.total'), 1);
  const readiness = await operations.readiness();
  assert.equal(readiness.status, 'not_ready');
  assert.ok(readiness.reasons.includes('mcp_compat_draining'));
  assert.equal(readiness.admitting, false);

  const next = operations.beginRequest({ controller: new AbortController() });
  assert.equal(operations.isAdmitting(), false);
  assert.equal((await operations.readiness()).status, 'not_ready');
  next.finish({
    outcome: 'cancelled',
    methodFamily: 'other',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
  });
  handle.finish({
    outcome: 'cancelled',
    methodFamily: 'read',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
  });
});

test('registry overflow is bounded and does not create hidden entries', () => {
  const { operations, metrics } = createOperations({
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
  });
  const first = operations.beginRequest({ controller: new AbortController() });
  const overflow = operations.beginRequest({ controller: new AbortController() });
  assert.equal(first.registered, true);
  assert.equal(overflow.registered, false);
  assert.equal(operations.inspect().counts.activeRequests, 1);
  assert.equal(metrics.get('mcp.compat.registry.overflow'), 1);
  overflow.finish({
    outcome: 'rejected',
    methodFamily: 'other',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
    rejectCategory: 'admission',
  });
  first.finish({
    outcome: 'ok',
    methodFamily: 'catalog',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
  });
  first.finish({
    outcome: 'ok',
    methodFamily: 'catalog',
    auth: 'anonymous',
    era: 'legacy',
    protocolRevision: '2025-11-25',
  });
  assert.equal(metrics.get('mcp.compat.requests.total'), 2);
  assert.equal(operations.inspect().counts.activeRequests, 0);
});

test('readiness fails closed without oauth health and stays independent of write backlog', async () => {
  const missing = createOperations({ oauthHealth: undefined });
  const closed = await missing.operations.readiness();
  assert.equal(closed.status, 'not_ready');
  assert.ok(closed.reasons.includes('mcp_compat_dependency_unavailable'));

  const limiter = createOperations({
    limiterHealth: async () => 'unavailable' as const,
  });
  assert.equal((await limiter.operations.readiness()).status, 'not_ready');
  assert.ok((await limiter.operations.readiness()).reasons.includes('mcp_compat_limiter_unavailable'));

  const writeOff = createOperations({ writeEnabled: false, approvalHealth: undefined });
  assert.equal((await writeOff.operations.readiness()).status, 'ready');

  const writeOn = createOperations({
    writeEnabled: true,
    approvalHealth: async () => 'unavailable' as const,
  });
  const approval = await writeOn.operations.readiness();
  assert.equal(approval.status, 'not_ready');
  assert.ok(approval.reasons.includes('mcp_compat_approval_unavailable'));

  const idle = createMcpCompatReadinessDocument();
  assert.equal(idle.status, 'ready');
  assert.equal(idle.admitting, true);
  assert.deepEqual(idle.rejectCounts, {
    total: 0,
    admission: 0,
    rate_limited: 0,
    auth: 0,
    unsupported: 0,
  });
  const keys = JSON.stringify(idle);
  assert.doesNotMatch(keys, FORBIDDEN_METRIC);
});

test('compat runbook pins independent probes, metric prefix, and rollback drills', async () => {
  const [compat, readDoc, writeDoc, index] = await Promise.all([
    readFile(new URL('../../../docs/runbooks/mcp-compat-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/runbooks/mcp-read-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/runbooks/mcp-write-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/README.md', import.meta.url), 'utf8'),
  ]);
  for (const token of [
    'KNOWN_FEATURE_MCP_COMPAT',
    '/collections/-/mcp-compat',
    '2025-11-25',
    '/health',
    '/ready',
    '/ready/features/mcp',
    '/ready/features/mcp-write',
    '/ready/features/mcp-compat',
    'mcp.compat.',
    'initialize_offer',
    'protocol_revision',
    'client_family',
    'closeAllConnections',
    'flag off',
    '404',
    'no data cleanup',
    'shared',
    'handshake',
  ]) {
    assert.match(compat, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  assert.doesNotMatch(compat, /sessionId|session_id|password|apiKey|Grafana JSON/iu);
  assert.match(readDoc, /mcp-compat-operations\.md/u);
  assert.match(writeDoc, /mcp-compat-operations\.md/u);
  assert.match(index, /mcp-compat-operations\.md/u);
  assert.match(index, /mcp-write-operations\.md/u);
});
