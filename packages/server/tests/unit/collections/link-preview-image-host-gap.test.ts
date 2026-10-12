import assert from 'node:assert/strict';
import { test } from 'vitest';
import { LinkPreviewWorkerLoop } from '../../../src/infrastructure/collections/link-preview-worker.js';
import type { LinkPreviewClaim, LinkPreviewRepository } from '../../../src/infrastructure/collections/link-preview-postgres.js';
import { createFakeEgress, createMemoryObjectStore, htmlResponse, imageResponse, makePng } from '../../support/link-preview-fixtures.js';

function claims(pages: readonly string[]): LinkPreviewClaim[] {
  return pages.map((normalizedUrl, index) => ({
    urlKey: `key-${index}`, normalizedUrl, site: 'attacker.example',
    objectId: null, digest: null, failures: 0, leaseOwner: 'owner',
  }));
}

function repository(due: LinkPreviewClaim[]): LinkPreviewRepository {
  return {
    enqueue: async () => 0, claimSweep: async () => null, listSweepUrls: async () => ({ urls: [], corrupted: false }),
    completeSweep: async () => {}, releaseSweep: async () => {}, pruneStale: async () => 0, listCollectable: async () => [],
    forgetObject: async () => {}, recordObject: async () => {}, completeFailure: async () => true,
    completeReady: async () => ({ written: true, generic: false }), renewLease: async () => true,
    completeNone: async () => true,
    claimDue: async () => due,
  };
}

test('image candidates on one victim host honor the configured host gap', async () => {
  const png = makePng(400, 210);
  const victim = 'https://victim.example/image.png';
  const pages = ['https://a1.attacker.example/page', 'https://a2.attacker.example/page'];
  const routes = new Map<string, () => Response>([
    [pages[0]!, () => htmlResponse(`<meta property="og:image" content="${victim}">`)],
    [pages[1]!, () => htmlResponse(`<meta property="og:image" content="${victim}">`)],
    [victim, () => imageResponse(png)],
  ]);
  const egress = createFakeEgress(routes);
  const victimStarts: number[] = [];
  const loop = new LinkPreviewWorkerLoop({
    repository: repository(claims(pages)), store: createMemoryObjectStore(),
    logger: { info() {}, warn() {}, error() {} },
    retentionSeconds: 31_536_000, concurrency: 2, perHostGapMs: 300,
    resolve: egress.resolve,
    connect: async (target, init) => {
      if (target.url.href === victim) victimStarts.push(Date.now());
      return egress.connect(target, init);
    },
  });
  await loop.runOnce();
  assert.equal(victimStarts.length, 2);
  assert.ok(victimStarts[1]! - victimStarts[0]! >= 300, `victim fetches ${victimStarts.join(',')}`);
});

test('a redirect hop is gated by the destination host, not the original image host', async () => {
  const png = makePng(400, 210);
  const victim = 'https://victim.example/image.png';
  const jumps = ['https://j1.example/img', 'https://j2.example/img'];
  const pages = ['https://a1.attacker.example/page', 'https://a2.attacker.example/page'];
  const redirect = () => new Response(null, { status: 302, headers: { location: victim } });
  const routes = new Map<string, () => Response>([
    [pages[0]!, () => htmlResponse(`<meta property="og:image" content="${jumps[0]}">`)],
    [pages[1]!, () => htmlResponse(`<meta property="og:image" content="${jumps[1]}">`)],
    [jumps[0]!, redirect],
    [jumps[1]!, redirect],
    [victim, () => imageResponse(png)],
  ]);
  const egress = createFakeEgress(routes);
  const victimStarts: number[] = [];
  const loop = new LinkPreviewWorkerLoop({
    repository: repository(claims(pages)), store: createMemoryObjectStore(),
    logger: { info() {}, warn() {}, error() {} },
    retentionSeconds: 31_536_000, concurrency: 2, perHostGapMs: 300,
    resolve: egress.resolve,
    connect: async (target, init) => {
      if (target.url.href === victim) victimStarts.push(Date.now());
      return egress.connect(target, init);
    },
  });
  await loop.runOnce();
  assert.equal(victimStarts.length, 2);
  assert.ok(victimStarts[1]! - victimStarts[0]! >= 300, `redirected victim fetches ${victimStarts.join(',')}`);
});

test('crossed image hosts finish instead of holding each page host', async () => {
  const png = makePng(400, 210);
  const pages = ['https://a.example/page', 'https://b.example/page'];
  const images = ['https://b.example/cover.png', 'https://a.example/cover.png'];
  const routes = new Map<string, () => Response>([
    [pages[0]!, () => htmlResponse(`<meta property="og:image" content="${images[0]}">`)],
    [pages[1]!, () => htmlResponse(`<meta property="og:image" content="${images[1]}">`)],
    [images[0]!, () => imageResponse(png)],
    [images[1]!, () => imageResponse(png)],
  ]);
  const egress = createFakeEgress(routes);
  const loop = new LinkPreviewWorkerLoop({
    repository: repository(claims(pages)), store: createMemoryObjectStore(),
    logger: { info() {}, warn() {}, error() {} },
    retentionSeconds: 31_536_000, concurrency: 2, perHostGapMs: 0,
    pageTimeoutMs: 1_000, imageTimeoutMs: 1_000, leaseDurationMs: 4_000,
    resolve: egress.resolve, connect: egress.connect,
  });
  const finished = loop.runOnce();
  const outcome = await Promise.race([
    finished.then(() => 'done' as const),
    new Promise<'stuck'>((resolve) => { setTimeout(() => resolve('stuck'), 2_000); }),
  ]);
  assert.equal(outcome, 'done');
  await finished;
});

test('stop aborts a queued host wait and stops lease renewal', async () => {
  const pages = ['https://a.example/one', 'https://a.example/two'];
  const routes = new Map<string, () => Response>(pages.map((page) => [page, () => htmlResponse('')]));
  const egress = createFakeEgress(routes);
  let connects = 0;
  const renewLease = async () => true;
  let renewals = 0;
  const countingRenew = async () => { renewals += 1; return renewLease(); };
  const loop = new LinkPreviewWorkerLoop({
    repository: { ...repository(claims(pages)), renewLease: countingRenew },
    store: createMemoryObjectStore(),
    logger: { info() {}, warn() {}, error() {} },
    retentionSeconds: 31_536_000, concurrency: 2, perHostGapMs: 0,
    pageTimeoutMs: 5_000, imageTimeoutMs: 20, connectTimeoutMs: 20, leaseDurationMs: 5_060,
    resolve: egress.resolve,
    connect: async (target, init) => {
      connects += 1;
      if (connects === 1) {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) { abort(); return; }
          init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return egress.connect(target, init);
    },
  });
  const work = loop.runOnce();
  const started = Date.now();
  while (connects < 1) {
    if (Date.now() - started > 1_000) throw new Error('first connect did not start');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  await loop.stop();
  await work;
  const afterStop = renewals;
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  assert.equal(renewals, afterStop);
});
