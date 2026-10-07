import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  PHASE4B_MCP_ENDPOINT_PATH,
  PHASE4B_MCP_HARD_LIMITS,
  PHASE4B_MCP_LEGACY_ERROR_CODE_METHOD_NOT_FOUND,
  PHASE4B_MCP_LEGACY_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION,
  PHASE4B_MCP_PROTOCOL_VERSION,
  buildPhase4bModernEnvelope,
  computeMcpEntryReplayDigest,
} from '../../../scripts/evidence/phase4b-mcp-entry-contract.js';
import {
  createPhase4bMcpEntryHost,
  type Phase4bMcpEntryHost,
} from '../../../scripts/evidence/phase4b-mcp-entry-host.js';
import {
  createPhase4bMcpEntryClient,
  type Phase4bMcpEntryClient,
} from '../../../scripts/evidence/phase4b-mcp-entry-client.js';
import {
  loadMcpEntryReplayManifest,
  runMcpEntryControlledFixtureProbe,
} from '../../../scripts/evidence/phase4b-mcp-entry-probe.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const probePath = resolve(backendRoot,
  'scripts/evidence/phase4b-mcp-entry-probe.ts');

function modernBody(method: string, id: number, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { _meta: buildPhase4bModernEnvelope(), ...params },
  });
}

interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

async function rawExchange(
  host: Phase4bMcpEntryHost,
  init: RequestInit & { readonly method?: string },
): Promise<RawResponse> {
  const response = await fetch(`${host.origin}${PHASE4B_MCP_ENDPOINT_PATH}`, init);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

async function rawPost(
  host: Phase4bMcpEntryHost,
  body: string,
  init: RequestInit = {},
  options: { readonly includeProtocolHeader?: boolean } = {},
): Promise<RawResponse> {
  const includeProtocolHeader = options.includeProtocolHeader ?? true;
  return rawExchange(host, {
    method: 'POST',
    ...init,
    // `...init` must not clobber the JSON content type: merge caller headers
    // into the base headers instead of replacing them.
    headers: {
      'content-type': 'application/json',
      ...(includeProtocolHeader ? { 'mcp-protocol-version': '2026-07-28' } : {}),
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...(init.headers as Record<string, string> | undefined),
    },
    body,
  });
}
async function modernPost(
  host: Phase4bMcpEntryHost,
  method: string,
  id: number,
  params: Record<string, unknown> = {},
  init: RequestInit = {},
): Promise<RawResponse> {
  return rawPost(host, modernBody(method, id, params), {
    ...init,
    headers: { 'mcp-method': method, ...(init.headers as Record<string, string> | undefined) },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function connectClient(host: Phase4bMcpEntryHost): Promise<Phase4bMcpEntryClient> {
  const client = createPhase4bMcpEntryClient({ url: `${host.origin}${PHASE4B_MCP_ENDPOINT_PATH}` });
  await client.connect();
  return client;
}

describe('P4B-R01 real host transport entry over TCP (Fastify + official SDK)', () => {
  let host: Phase4bMcpEntryHost;

  beforeAll(async () => {
    host = await createPhase4bMcpEntryHost();
  });

  afterAll(async () => {
    await host.close();
  });

  test('serves modern POST server/discover over the real TCP origin with the independent official client', async () => {
    const client = await connectClient(host);
    try {
      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(client.getNegotiatedProtocolVersion(), PHASE4B_MCP_PROTOCOL_VERSION);
      const discover = client.getDiscoverResult();
      assert.ok(discover, 'discover result must be present after connect');
      assert.ok(discover.supportedVersions.includes(PHASE4B_MCP_PROTOCOL_VERSION));
      const explicit = await client.discover();
      assert.ok(explicit.supportedVersions.includes(PHASE4B_MCP_PROTOCOL_VERSION));
    } finally {
      await client.close();
    }
  });

  test('reads the fixture resource through the real host', async () => {
    const client = await connectClient(host);
    try {
      const read = await client.request(
        { method: 'resources/read', params: { uri: 'fixture://ping' } },
        undefined,
      ) as { contents?: readonly { uri?: string; text?: string }[] };
      // 2026-07-28 results carry cache metadata (`ttlMs`/`cacheScope`/`_meta`);
      // assert the resource payload, which is the host-owned contract.
      assert.equal(read.contents?.[0]?.uri, 'fixture://ping');
      assert.equal(read.contents?.[0]?.text, 'pong');
    } finally {
      await client.close();
    }
  });

  test('upgrades subscriptions/listen POST to an SSE stream and delivers the ack', async () => {
    const client = await connectClient(host);
    try {
      const subscription = await withTimeout(
        client.listen({}),
        5000,
        'listen ack timed out',
      );
      assert.ok(subscription.honoredFilter, 'ack must be delivered');
      await subscription.close();
      await withTimeout(subscription.closed, 5000, 'listen close timed out');
      const record = host.stats.requests.find((entry) => entry.method === 'subscriptions/listen');
      assert.ok(record, 'listen must be recorded');
      assert.match(record.responseContentType ?? '', /text\/event-stream/u);
    } finally {
      await client.close();
    }
  });

  test('raw POST server/discover carries version/meta/header facts on the record', async () => {
    const response = await rawPost(host, modernBody('server/discover', 1), {
      headers: { 'mcp-method': 'server/discover' },
    });
    assert.equal(response.status, 200);
    assert.match(response.contentType, /application\/json/u);
    const payload = JSON.parse(response.text) as {
      result?: { supportedVersions?: readonly string[] };
    };
    assert.ok(payload.result?.supportedVersions?.includes(PHASE4B_MCP_PROTOCOL_VERSION));
    const record = host.stats.requests.at(-1);
    assert.equal(record?.httpMethod, 'POST');
    assert.equal(record?.method, 'server/discover');
    assert.equal(record?.headerMethod, 'server/discover');
    assert.equal(record?.envelopeProtocolVersion, PHASE4B_MCP_PROTOCOL_VERSION);
    assert.equal(record?.responseStatus, 200);
  });

  test.each([
    { verb: 'GET', status: 405 },
    { verb: 'DELETE', status: 405 },
  ] as const)('rejects the legacy $verb with 405 (Legacy-negative)', async ({ verb, status }) => {
    const response = await rawExchange(host, { method: verb });
    assert.equal(response.status, status);
  });

  test('rejects a legacy initialize POST without a modern envelope (Legacy-negative)', async () => {
    const response = await rawPost(host, JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1.0.0' },
      },
    }), {}, { includeProtocolHeader: false });
    assert.equal(response.status, 400);
    const payload = JSON.parse(response.text) as {
      error?: { code?: number; data?: { supported?: readonly string[] } };
    };
    assert.equal(payload.error?.code, PHASE4B_MCP_LEGACY_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION);
    assert.ok(payload.error?.data?.supported?.includes(PHASE4B_MCP_PROTOCOL_VERSION));
  });

  test('drops a legacy notifications/initialized POST with 202 (Legacy-negative)', async () => {
    const response = await rawPost(host, JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }));
    assert.equal(response.status, 202);
    assert.equal(response.text, '');
  });

  test.each(['mcp-session-id', 'last-event-id'] as const)(
    'rejects the legacy %s header with unsupported_protocol_version (Legacy-negative)',
    async (header) => {
      const response = await rawPost(host, modernBody('server/discover', 11), {
        headers: { [header]: 'legacy-value' },
      });
      assert.equal(response.status, 400);
      const payload = JSON.parse(response.text) as { error?: { code?: number; message?: string } };
      assert.equal(payload.error?.code, PHASE4B_MCP_LEGACY_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION);
      assert.match(payload.error?.message ?? '', new RegExp(header, 'iu'));
    },
  );

  test.each([
    'resources/subscribe',
    'resources/unsubscribe',
    'ping',
    'logging/setLevel',
    'initialize',
  ] as const)('rejects the deleted legacy method %s with method-not-found (Legacy-negative)', async (method) => {
    const response = await modernPost(host, method, 12);
    assert.equal(response.status, 404);
    const payload = JSON.parse(response.text) as { error?: { code?: number } };
    assert.equal(payload.error?.code, PHASE4B_MCP_LEGACY_ERROR_CODE_METHOD_NOT_FOUND);
  });

  test('enforces the frozen body byte limit with 413', async () => {
    const response = await rawPost(host, 'x'.repeat(PHASE4B_MCP_HARD_LIMITS.maxBodyBytes + 1));
    assert.equal(response.status, 413);
  });

  test('enforces the frozen header count and header length limits with 431', async () => {
    const manyHeaders: Record<string, string> = {};
    for (let index = 0; index < PHASE4B_MCP_HARD_LIMITS.maxHeaderCount + 4; index += 1) {
      manyHeaders[`x-mcp-probe-${index}`] = 'value';
    }
    const countResponse = await modernPost(host, 'server/discover', 20, {}, {
      headers: manyHeaders,
    });
    assert.equal(countResponse.status, 431);

    const longResponse = await modernPost(host, 'server/discover', 21, {}, {
      headers: { 'x-mcp-probe-long': 'v'.repeat(PHASE4B_MCP_HARD_LIMITS.maxHeaderValueBytes + 1) },
    });
    assert.equal(longResponse.status, 431);
  });

  test('injects faults and records aborted exchanges', async () => {
    const isolated = await createPhase4bMcpEntryHost();
    try {
      isolated.injectFault({ kind: 'fail', status: 503, body: '{"error":"injected"}' });
      const failed = await modernPost(isolated, 'server/discover', 30);
      assert.equal(failed.status, 503);
      assert.match(failed.text, /injected/u);
      assert.equal(isolated.stats.injectedFaults, 1);

      isolated.injectFault({ kind: 'malformed-json' });
      const malformed = await modernPost(isolated, 'server/discover', 31);
      assert.equal(malformed.status, 200);
      assert.match(malformed.contentType, /application\/json/u);
      assert.throws(() => JSON.parse(malformed.text));

      isolated.injectFault({ kind: 'hold' });
      const controller = new AbortController();
      const held = modernPost(isolated, 'server/discover', 32, {}, {
        signal: controller.signal,
      });
      await waitForCondition(
        () => isolated.stats.requests.at(-1)?.held === true,
        { timeoutMs: 2_000, description: 'the controlled MCP request to enter its hold fault' },
      );
      controller.abort();
      await assert.rejects(() => held);
      // The server records `aborted` asynchronously once the socket close is
      // observed; poll briefly so the assertion is not racing the wire.
      await waitForCondition(
        () => isolated.stats.requests.at(-1)?.aborted === true,
        { timeoutMs: 2_000, description: 'the MCP entry host to record the aborted socket' },
      );
      assert.equal(isolated.stats.requests.at(-1)?.aborted, true);
      assert.equal(isolated.stats.requests.at(-1)?.held, true);
    } finally {
      await isolated.close();
    }
  });

  test('bounded FIFO dispatch keeps a slow consumer from unbounded concurrency', async () => {
    const isolated = await createPhase4bMcpEntryHost({ maxConcurrent: 1, maxQueue: 2 });
    try {
      isolated.injectFault({ kind: 'hold' });
      const heldController = new AbortController();
      const held = modernPost(isolated, 'server/discover', 40, {}, {
        signal: heldController.signal,
      });
      // The hold fault is consumed by whichever request arrives first, and
      // undici may establish the second fetch's connection before the first.
      // Wait until the server has confirmed that THIS request holds the slot
      // before issuing the second one: otherwise the abort below could target
      // a merely queued request while the un-aborted one occupies the slot
      // forever, hanging the test on a client-side connection-order race.
      await waitForCondition(
        () => isolated.stats.requests[0]?.held === true,
        { timeoutMs: 2_000, description: 'the first MCP request to occupy the dispatch slot' },
      );
      assert.equal(isolated.stats.requests[0]?.held, true, 'held request must occupy the dispatch slot');
      const second = modernPost(isolated, 'server/discover', 41);
      await waitForCondition(
        () => isolated.stats.requests[1]?.queued === true,
        { timeoutMs: 2_000, description: 'the second MCP request to enter the bounded queue' },
      );
      assert.equal(isolated.stats.requests[1]?.queued, true, 'second request must queue behind the held slot');
      assert.equal(isolated.stats.inFlight, 1, 'concurrency must stay bounded at maxConcurrent');
      heldController.abort();
      await assert.rejects(() => held);
      const secondResult = await withTimeout(second, 5000, 'queued request did not dispatch after slot release');
      assert.equal(secondResult.status, 200);
    } finally {
      await isolated.close();
    }
  });

  test('queue overflow fails closed with 503', async () => {
    const isolated = await createPhase4bMcpEntryHost({ maxConcurrent: 1, maxQueue: 2 });
    try {
      const controllers: AbortController[] = [];
      for (let index = 0; index < 3; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        isolated.injectFault({ kind: 'hold' });
        void modernPost(isolated, 'server/discover', 50 + index, {}, {
          signal: controller.signal,
        }).catch(() => undefined);
      }
      await waitForCondition(
        () => isolated.stats.requests.length >= 3 && isolated.stats.inFlight === 1,
        { timeoutMs: 2_000, description: 'the MCP dispatch slot and queue to fill' },
      );
      const overflow = await modernPost(isolated, 'server/discover', 53);
      assert.equal(overflow.status, 503);
      for (const controller of controllers) controller.abort();
    } finally {
      await isolated.close();
    }
  });

  test('shuts down and restarts the host', async () => {
    const isolated = await createPhase4bMcpEntryHost();
    try {
      const before = await modernPost(isolated, 'server/discover', 60);
      assert.equal(before.status, 200);
      await isolated.close();
      await assert.rejects(() => rawPost(isolated, modernBody('server/discover', 61)));
      await isolated.restart();
      const after = await modernPost(isolated, 'server/discover', 62);
      assert.equal(after.status, 200);
      assert.ok(isolated.stats.generation >= 1);
    } finally {
      await isolated.close();
    }
  });
});

describe('P4B-R01 controlled-fixture probe', () => {
  test('probe evidence matches the frozen replay manifest and is replayable', async () => {
    const manifest = loadMcpEntryReplayManifest();
    const first = await runMcpEntryControlledFixtureProbe();
    const second = await runMcpEntryControlledFixtureProbe();
    assert.equal(first.replayDigest, second.replayDigest);
    assert.deepEqual(first.scenarios, second.scenarios);
    assert.equal(
      first.replayDigest,
      computeMcpEntryReplayDigest({
        schemaVersion: manifest.schemaVersion,
        frozen: first.frozen,
        scenarios: first.scenarios,
      }),
    );
    assert.equal(first.replayDigest, manifest.recordedOutcomes.digest);
    assert.equal(first.negativeControls.length, manifest.negativeControls.length);
    for (const control of manifest.negativeControls) {
      assert.ok(first.negativeControls.includes(control));
    }
    assert.equal(first.redactionVerified, true);
  });

  test('probe CLI fixture mode exits zero and writes redaction-safe machine-readable evidence', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-phase4b-mcp-entry-'));
    try {
      const outPath = join(evidenceRoot, 'mcp-entry-gate-evidence.json');
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', probePath, '--mode', 'fixture', '--out', outPath],
        { cwd: backendRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, output);
      assert.match(output, /known\.phase4b\.mcp-entry-controlled-fixture-probe/u);
      const written = readFileSync(outPath, 'utf8');
      const evidence = JSON.parse(written) as {
        readonly replayDigest?: string;
        readonly redactionVerified?: boolean;
        readonly scenarios?: readonly { readonly id?: string }[];
      };
      assert.equal(typeof evidence.replayDigest, 'string');
      assert.equal(evidence.redactionVerified, true);
      assert.ok((evidence.scenarios?.length ?? 0) >= 20);
      for (const marker of [
        'known-phase4b-legacy-session-marker',
        'postgresql://',
        'Bearer ',
        '-----BEGIN',
      ]) {
        assert.doesNotMatch(written, new RegExp(escapeRegExp(marker), 'iu'), marker);
      }
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }, 150000);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
