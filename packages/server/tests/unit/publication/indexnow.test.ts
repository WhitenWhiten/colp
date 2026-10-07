import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import {
  BestEffortIndexNowPublisher,
  INDEXNOW_ENDPOINT,
  INDEXNOW_FAILURE_METRIC,
  INDEXNOW_KEY_LOCATION,
  INDEXNOW_SUCCESS_METRIC,
  buildIndexNowPayload,
  type IndexNowLogger,
  type IndexNowPublisher,
} from '../../../src/infrastructure/outbox/indexnow.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  createPublicationCachePurgeRoutes,
  publicationCachePurgeEnvelopeRegistrations,
  type PublicationCachePurgeProvider,
} from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import { EventEnvelopeRegistry } from '../../../src/infrastructure/outbox/envelope.js';
import type { OutboxHandlerContext } from '../../../src/infrastructure/outbox/router.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef';
const CONFIG_ENV = Object.freeze({
  DATABASE_URL: 'postgres://unused/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

function context(overrides: Partial<Record<string, unknown>> = {}): OutboxHandlerContext {
  const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
  const envelope = registry.validate({
    event_id: 'event-indexnow-1',
    event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
    event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
    aggregate_identity: {
      aggregate_type: 'collection',
      aggregate_id: 'collection-1',
      aggregate_scope: 'collection-1',
    },
    aggregate_revision: 'policy-4',
    commit_ordinal: '7',
    occurred_at: '2026-09-01T00:00:00.000Z',
    payload: {
      collectionId: 'collection-1',
      contentRevision: 'content-7',
      policyRevision: 'policy-4',
      publicationSlug: 'notes/with space',
      sourceEventType: 'collection.updated',
      sourceEventVersion: 1,
      visibility: 'public',
      ...overrides,
    },
  });
  return {
    envelope,
    idempotencyKey: envelope.event_id,
    signal: new AbortController().signal,
  };
}

function routes(provider: PublicationCachePurgeProvider, indexNowPublisher?: IndexNowPublisher) {
  return createPublicationCachePurgeRoutes({
    provider,
    publicationOrigin: 'https://collections.example.test',
    productOrigin: 'https://app.example.test',
    timeoutMs: 100,
    ...(indexNowPublisher === undefined ? {} : { indexNowPublisher }),
  });
}

describe('IndexNow configuration and public-key contract', () => {
  test('defaults off and accepts only literal true/false', () => {
    const disabled = loadConfig(CONFIG_ENV);
    assert.deepEqual(disabled.publication.indexNow, { enabled: false });

    for (const value of ['', '1', 'yes', 'TRUE', 'false ']) {
      assert.throws(
        () => loadConfig({
          ...CONFIG_ENV,
          KNOWN_FEATURE_INDEXNOW: value,
        }),
        /KNOWN_FEATURE_INDEXNOW must be true or false/u,
      );
    }
  });

  test('requires one strict lowercase 32-hex key only when enabled', () => {
    for (const key of [undefined, '', 'ABCDEF0123456789abcdef0123456789', 'abc', `${TEST_KEY}0`]) {
      assert.throws(
        () => loadConfig({
          ...CONFIG_ENV,
          KNOWN_FEATURE_INDEXNOW: 'true',
          ...(key === undefined ? {} : { KNOWN_INDEXNOW_KEY: key }),
        }),
        /KNOWN_INDEXNOW_KEY must be exactly 32 lowercase hexadecimal characters/u,
      );
    }
    assert.deepEqual(loadConfig({
      ...CONFIG_ENV,
      KNOWN_FEATURE_INDEXNOW: 'true',
      KNOWN_INDEXNOW_KEY: TEST_KEY,
    }).publication.indexNow, {
      enabled: true,
      key: TEST_KEY,
      timeoutMs: 5_000,
    });
    assert.throws(
      () => new BestEffortIndexNowPublisher({ key: TEST_KEY, timeoutMs: 5_001 }),
      /timeoutMs must be an integer from 1 through 5000/u,
    );
  });

  test('flag off composes no publisher and cannot call the injected egress seam', async () => {
    let egressCalls = 0;
    const worker = buildWorker(loadConfig({ ...CONFIG_ENV, LOG_LEVEL: 'silent' }), undefined,
      new InMemoryMetrics(), {
        indexNowFetch: async () => {
          egressCalls += 1;
          return new Response(null, { status: 200 });
        },
      });
    assert.equal(worker.indexNowPublisher, undefined);
    assert.equal(egressCalls, 0);
    await worker.stop();
    assert.equal(egressCalls, 0);
  });

  test('keeps the generated public key byte-exact and accepted by backend config', () => {
    const repositoryRoot = join(import.meta.dirname, '../../../..');
    const source = readFileSync(
      join(repositoryRoot, 'Known-Frontend/web/content/agent-public/indexnow.txt'),
      'utf8',
    );
    const generated = readFileSync(
      join(repositoryRoot, 'Known-Frontend/web/public/indexnow.txt'),
      'utf8',
    );
    assert.match(source, /^[0-9a-f]{32}\n$/u);
    assert.equal(generated, source);
    const config = loadConfig({
      ...CONFIG_ENV,
      KNOWN_FEATURE_INDEXNOW: 'true',
      KNOWN_INDEXNOW_KEY: generated.trimEnd(),
    });
    assert.equal(config.publication.indexNow.enabled, true);
  });
});

describe('IndexNow payload and best-effort egress', () => {
  test('builds the exact endpoint payload and JSON request without leaking into logs', async () => {
    assert.deepEqual(buildIndexNowPayload(TEST_KEY, 'notes/with space'), {
      host: 'know-n.com',
      key: TEST_KEY,
      keyLocation: INDEXNOW_KEY_LOCATION,
      urlList: ['https://know-n.com/c/notes%2Fwith%20space'],
    });

    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const logs: Array<{ bindings: object; message: string }> = [];
    const metrics = new InMemoryMetrics();
    const logger: IndexNowLogger = {
      warn(bindings, message) { logs.push({ bindings, message }); },
    };
    const publisher = new BestEffortIndexNowPublisher({
      key: TEST_KEY,
      timeoutMs: 50,
      metrics,
      logger,
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(null, { status: 200 });
      },
    });

    publisher.notifyPublicationSlug('notes/with space');
    await publisher.close();

    assert.equal(calls.length, 1);
    assert.equal(String(calls[0]?.input), INDEXNOW_ENDPOINT);
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(calls[0]?.init?.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), buildIndexNowPayload(TEST_KEY, 'notes/with space'));
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
    assert.equal(metrics.get(INDEXNOW_SUCCESS_METRIC), 1);
    assert.equal(metrics.get(INDEXNOW_FAILURE_METRIC), 0);
    assert.equal(JSON.stringify(logs).includes(TEST_KEY), false);
  });

  test.each([
    ['network', async () => { throw new Error('network down'); }, 'network'],
    ['http', async () => new Response(null, { status: 429 }), 'http'],
    ['timeout', () => new Promise<Response>(() => {}), 'timeout'],
  ] as const)('consumes %s failure once with low-sensitivity telemetry', async (_name, fetch, expectedKind) => {
    const logs: Array<{ bindings: object; message: string }> = [];
    const metrics = new InMemoryMetrics();
    const publisher = new BestEffortIndexNowPublisher({
      key: TEST_KEY,
      timeoutMs: expectedKind === 'timeout' ? 5 : 50,
      metrics,
      logger: { warn(bindings, message) { logs.push({ bindings, message }); } },
      fetch,
    });

    await routes({ async purge() {} }, publisher)[1]!.handle(context({
      visibility: 'private',
      sourceEventType: 'collection.deleted',
    }));
    await publisher.close();

    assert.equal(metrics.get(INDEXNOW_FAILURE_METRIC), 1);
    assert.equal(metrics.get(INDEXNOW_SUCCESS_METRIC), 0);
    assert.equal(logs.length, 1);
    assert.equal((logs[0]?.bindings as { failureKind?: string }).failureKind, expectedKind);
    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes(TEST_KEY), false);
    assert.equal(serialized.includes('notes/with space'), false);
    assert.equal(serialized.includes('urlList'), false);
  });

  test('does not let response-body cancellation block close or leak a late rejection', async () => {
    let rejectCancellation: ((reason: Error) => void) | undefined;
    let markCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', recordUnhandledRejection);
    const publisher = new BestEffortIndexNowPublisher({
      key: TEST_KEY,
      timeoutMs: 50,
      fetch: async () => ({
        ok: true,
        status: 200,
        body: {
          cancel: () => {
            markCancellationStarted?.();
            return new Promise<void>((_resolve, reject) => { rejectCancellation = reject; });
          },
        },
      }) as Response,
    });
    let cancellationRejected = false;

    try {
      publisher.notifyPublicationSlug('notes/with space');
      await cancellationStarted;
      let closeDeadline: ReturnType<typeof setTimeout> | undefined;
      const closeOutcome = await Promise.race([
        publisher.close().then(() => 'closed' as const),
        new Promise<'deadline'>((resolve) => {
          closeDeadline = setTimeout(() => { resolve('deadline'); }, 50);
        }),
      ]);
      clearTimeout(closeDeadline);
      assert.equal(closeOutcome, 'closed');

      cancellationRejected = true;
      rejectCancellation?.(new Error('late response-body cancellation failure'));
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      assert.deepEqual(unhandledRejections, []);
    } finally {
      if (!cancellationRejected) {
        rejectCancellation?.(new Error('test cleanup response-body cancellation failure'));
        await publisher.close();
      }
      process.off('unhandledRejection', recordUnhandledRejection);
    }
  });
});

describe('IndexNow publication-cache-purge hook', () => {
  test('keeps route count and submits every visibility only after purge success', async () => {
    const submitted: string[] = [];
    const publisher: IndexNowPublisher = {
      notifyPublicationSlug(slug) { submitted.push(slug); },
      async close() {},
    };
    const order: string[] = [];
    const configured = routes({ async purge() { order.push('purge'); } }, {
      notifyPublicationSlug(slug) { order.push('indexnow'); publisher.notifyPublicationSlug(slug); },
      close: () => publisher.close(),
    });
    assert.equal(configured.length, 2);

    const events = [
      { visibility: 'public' },
      { visibility: 'unlisted' },
      { visibility: 'private' },
      { visibility: 'protected' },
      { visibility: 'private', sourceEventType: 'collection.deleted' },
    ] as const;
    for (const event of events) {
      await configured[1]!.handle(context(event));
    }
    assert.deepEqual(submitted, Array(events.length).fill('notes/with space'));
    assert.deepEqual(order.slice(0, 2), ['purge', 'indexnow']);
  });

  test('does not submit when the purge provider fails', async () => {
    let submissions = 0;
    const publisher: IndexNowPublisher = {
      notifyPublicationSlug() { submissions += 1; },
      async close() {},
    };
    await assert.rejects(
      routes({ async purge() { throw new Error('purge failed'); } }, publisher)[1]!.handle(context()),
    );
    assert.equal(submissions, 0);
  });

  test('returns purge success without waiting for IndexNow egress and consumes its late failure', async () => {
    let rejectFetch: ((reason: Error) => void) | undefined;
    const publisher = new BestEffortIndexNowPublisher({
      key: TEST_KEY,
      timeoutMs: 50,
      fetch: () => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }),
    });
    const handled = routes({ async purge() {} }, publisher)[1]!.handle(context());
    await handled;
    rejectFetch?.(new Error('late failure'));
    await publisher.close();
  });
});
