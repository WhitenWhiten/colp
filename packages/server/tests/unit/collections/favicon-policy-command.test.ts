/**
 * FO-01 favicon policy/source pure-function and application command tests.
 * The HTTP surface is covered by the Postgres integration suite; this file
 * pins the pure policy/parsing/projection logic and the receipt-ordered
 * command behavior (replay before If-Match, CAS, no-op, reused).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type {
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import { loadFaviconPolicyAdmissionConfig } from '../../../src/bootstrap/config-social.js';
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  FaviconPolicyCommandError,
  faviconPolicyEtag,
  faviconPolicyFingerprint,
  getMyFaviconPolicy,
  parseFaviconPolicyEtag,
  parseFaviconPolicyPatch,
  toFaviconPolicyDto,
  updateMyFaviconPolicy,
  virtualFaviconPolicy,
  type FaviconPolicyReadPort,
  type FaviconPolicyRow,
  type FaviconPolicyWritePort,
} from '../../../src/modules/collections/index.js';
import {
  iconSourceEtag,
  parseIconSourceEtag,
  projectIconSource,
  type BookmarkIconSourceReadPort,
  type BookmarkIconSourceRow,
  type GetBookmarkFaviconSourcePorts,
  type IconSourceView,
  type LockedNodeRow,
} from '../../../src/modules/collections/index.js';
import { CollectionPreconditionError } from '../../../src/modules/collections/index.js';

const ACCOUNT = 'account-fo01-unit';
const NODE_REVISION = 'unit-node-res-1';

function policyRow(overrides: Partial<FaviconPolicyRow> = {}): FaviconPolicyRow {
  return {
    accountId: ACCOUNT,
    newDefault: 'capture',
    providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
    fillMissing: false,
    forceAllOnline: false,
    revision: 2n,
    updatedAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  };
}

describe('favicon policy pure functions', () => {
  test('parseFaviconPolicyPatch accepts any non-empty subset of the FO-03 fields', () => {
    assert.deepEqual(parseFaviconPolicyPatch({ newDefault: 'capture' }), { newDefault: 'capture' });
    assert.deepEqual(parseFaviconPolicyPatch({ newDefault: 'none' }), { newDefault: 'none' });
    assert.deepEqual(parseFaviconPolicyPatch({ newDefault: 'online' }), { newDefault: 'online' });
    assert.deepEqual(parseFaviconPolicyPatch({ fillMissing: true }), { fillMissing: true });
    assert.deepEqual(parseFaviconPolicyPatch({ forceAllOnline: false }), { forceAllOnline: false });
    assert.deepEqual(
      parseFaviconPolicyPatch({ newDefault: 'online', providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
        fillMissing: true, forceAllOnline: false }),
      { newDefault: 'online', providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE, fillMissing: true, forceAllOnline: false },
    );
    for (const value of [
      {},
      { newDefault: null },
      { newDefault: 'Capture' },
      { fillMissing: 1 },
      { fillMissing: null },
      { forceAllOnline: 'true' },
      { providerTemplate: 'http://favicone.com/{hostname}' },
      { providerTemplate: 'https://favicone.com/no-marker' },
      { providerTemplate: 'https://favicone.com/{hostname}/{hostname}' },
      { providerTemplate: 'https://user:pass@favicone.com/{hostname}' },
      { providerTemplate: 42 },
      { newDefault: 'capture', unknown: 1 },
      { unknown: 1 },
      null,
      'capture',
      [1],
    ]) {
      assert.throws(() => parseFaviconPolicyPatch(value), FaviconPolicyCommandError, JSON.stringify(value));
    }
  });

  test('faviconPolicyEtag round-trips and rejects foreign forms', () => {
    assert.equal(faviconPolicyEtag(1n), '"favicon-policy:1"');
    assert.equal(faviconPolicyEtag(12n), '"favicon-policy:12"');
    assert.equal(parseFaviconPolicyEtag('"favicon-policy:1"'), 1n);
    assert.equal(parseFaviconPolicyEtag('"favicon-policy:0002"'), null);
    assert.equal(parseFaviconPolicyEtag('W/"favicon-policy:1"'), null);
    assert.equal(parseFaviconPolicyEtag('"other:1"'), null);
    assert.equal(parseFaviconPolicyEtag('*'), null);
    assert.equal(parseFaviconPolicyEtag('"favicon-policy:"'), null);
  });

  test('faviconPolicyFingerprint distinguishes patches and is stable', () => {
    assert.equal(faviconPolicyFingerprint({ newDefault: 'capture' }),
      faviconPolicyFingerprint({ newDefault: 'capture' }));
    assert.notEqual(faviconPolicyFingerprint({ newDefault: 'capture' }),
      faviconPolicyFingerprint({ newDefault: 'none' }));
  });

  test('virtualFaviconPolicy exposes non-consumable defaults with revision 1', () => {
    const at = new Date('2026-09-13T00:00:00.000Z');
    const virtual = virtualFaviconPolicy(ACCOUNT, at);
    assert.deepEqual(virtual, {
      accountId: ACCOUNT,
      newDefault: 'capture',
      providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
      fillMissing: false,
      forceAllOnline: false,
      revision: 1n,
      updatedAt: at,
    });
  });

  test('toFaviconPolicyDto renders contract shape', () => {
    const dto = toFaviconPolicyDto(policyRow({ revision: 3n, newDefault: 'none' }));
    assert.deepEqual(dto, {
      revision: '3',
      newDefault: 'none',
      providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
      fillMissing: false,
      forceAllOnline: false,
      updatedAt: '2026-09-14T00:00:00.000Z',
    });
  });

  test('getMyFaviconPolicy returns the stored row or the virtual default', async () => {
    const stored = await getMyFaviconPolicy({ policies: { findByAccountId: async () => policyRow() } },
      { principalId: ACCOUNT, virtualUpdatedAt: new Date('2026-01-01T00:00:00.000Z') });
    assert.equal(stored.revision, 2n);
    const virtual = await getMyFaviconPolicy(
      { policies: { findByAccountId: async () => null } },
      { principalId: ACCOUNT, virtualUpdatedAt: new Date('2026-01-01T00:00:00.000Z') });
    assert.equal(virtual.revision, 1n);
    assert.equal(virtual.updatedAt.getTime(), new Date('2026-01-01T00:00:00.000Z').getTime());
  });
});

describe('favicon icon source pure functions', () => {
  test('iconSourceEtag fences node revision and source revision; parsing is strict', () => {
    const etag = iconSourceEtag(NODE_REVISION, 1n);
    assert.equal(etag, `"favicon-source:${NODE_REVISION}:1"`);
    assert.deepEqual(parseIconSourceEtag(etag), { nodeResourceRevision: NODE_REVISION, sourceRevision: 1n });
    assert.equal(parseIconSourceEtag('"favicon-source:has:colon:2"'), null);
    assert.equal(parseIconSourceEtag('"favicon-source::1"'), null);
    assert.equal(parseIconSourceEtag(`"favicon-source:${NODE_REVISION}:0"`), null);
    assert.equal(parseIconSourceEtag('W/"x"'), null);
    assert.equal(parseIconSourceEtag('*'), null);
  });

  test('projectIconSource resolves effective mode per contract precedence', async () => {
    const node = lockedNode(NODE_REVISION);
    const noRows: GetBookmarkFaviconSourcePorts = {
      sources: noneSources(),
      policies: nonePolicies(),
      bookmarkIcons: { findByNodeId: async () => null },
      collections: shareLockPort(),
      nodes: nodePort(node),
      accessPolicy: allowPort(),
    };
    const inherit = await projectIconSource(noRows, node, ACCOUNT, 'sub-fo01-owner', undefined);
    assert.deepEqual(pick(inherit), {
      revision: '1', policyRevision: '1', sourceMode: 'inherit', effectiveMode: 'capture',
      iconUrl: null, iconVersion: null, status: 'missing', restorable: false,
    });

    const none = await projectIconSource(
      { ...noRows, sources: rowSources({ sourceMode: 'none', revision: 5n }) },
      node, ACCOUNT, 'sub-fo01-owner', undefined);
    assert.equal(none.effectiveMode, 'none');
    assert.equal(none.sourceMode, 'none');

    const bindings = {
      ...noRows,
      bookmarkIcons: { findByNodeId: async () => ({
        nodeId: node.id, collectionId: node.collectionId, objectId: '123e4567-e89b-42d3-a456-426614174001',
        contentType: 'image/png', byteSize: 10, digestSha256: Buffer.alloc(32, 1),
        createdAt: new Date(), updatedAt: new Date(),
      }) },
    };
    const legacyUpload = await projectIconSource(bindings, node, ACCOUNT, 'sub-fo01-owner', 'https://app.example.test');
    assert.equal(legacyUpload.sourceMode, 'inherit');
    assert.equal(legacyUpload.effectiveMode, 'uploaded');
    assert.equal(legacyUpload.status, 'ready');
    assert.equal(legacyUpload.iconUrl,
      'https://app.example.test/api/v1/favicon/123e4567-e89b-42d3-a456-426614174001');

    const uploaded = await projectIconSource(
      { ...bindings, sources: rowSources({ sourceMode: 'uploaded', revision: 2n }) },
      node, ACCOUNT, 'sub-fo01-owner', undefined);
    assert.equal(uploaded.sourceMode, 'uploaded');
    assert.equal(uploaded.effectiveMode, 'uploaded');

    const nonePolicy = await projectIconSource(
      { ...noRows, policies: { findByAccountId: async () => policyRow({ newDefault: 'none', revision: 4n }) } },
      node, ACCOUNT, 'sub-fo01-owner', undefined);
    assert.equal(nonePolicy.effectiveMode, 'none');
    assert.equal(nonePolicy.policyRevision, 4n);
  });
});

describe('loadFaviconPolicyAdmissionConfig (KNOWN_FEATURE_FAVICON_POLICY)', () => {
  test('defaults to disabled with frozen contract values and accepts only true/false strings', () => {
    const defaults = loadFaviconPolicyAdmissionConfig({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.timeoutMs, 2_000);
    assert.equal(defaults.fetchTimeoutMs, 10_000);
    assert.equal(defaults.fetchMaxBytes, 65_536);
    assert.equal(defaults.fetchMaxRedirects, 3);
    assert.equal(defaults.jobBatchSize, 100);
    assert.equal(defaults.jobMaxAttempts, 5);
    assert.equal(defaults.historyRetentionSeconds, 31_536_000);
    assert.equal(defaults.jobConcurrency, 2);
    assert.deepEqual([...defaults.retryBackoffSeconds], [1, 2, 4, 8, 16]);
    // FO-05: flag-off boots without a cursor key (routes are 404); flag-on
    // REQUIRES FAVICON_CURSOR_HMAC_KEY (base64url 32-byte).
    assert.equal(
      loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: 'true',
        FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 7).toString('base64url') }).enabled,
      true,
    );
    assert.equal(loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: 'false' }).enabled, false);
    assert.equal(
      loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: ' TRUE ',
        FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 7).toString('base64url') }).enabled,
      true,
    );
    assert.throws(
      () => loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: 'true' }),
      /FAVICON_CURSOR_HMAC_KEY is required when KNOWN_FEATURE_FAVICON_POLICY=true/,
    );
    for (const bad of ['1', 'yes', '', 'Truee']) {
      assert.throws(() => loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: bad }),
        /KNOWN_FEATURE_FAVICON_POLICY must be true or false/);
    }
    assert.equal(loadFaviconPolicyAdmissionConfig({ FAVICON_POLICY_TIMEOUT_MS: '5000' }).timeoutMs, 5_000);
    assert.throws(() => loadFaviconPolicyAdmissionConfig({ FAVICON_POLICY_TIMEOUT_MS: '0' }),
      /FAVICON_POLICY_TIMEOUT_MS/);
  });

  test('FO-05 FAVICON_CURSOR_HMAC_KEY is a strict base64url 32-byte secret', () => {
    const valid = Buffer.alloc(32, 13).toString('base64url');
    assert.equal(valid.length, 43);
    assert.equal(
      loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: 'true',
        FAVICON_CURSOR_HMAC_KEY: valid }).cursorHmacKey,
      valid,
    );
    assert.equal(
      loadFaviconPolicyAdmissionConfig({ FAVICON_CURSOR_HMAC_KEY: valid }).cursorHmacKey,
      valid,
    );
    // Flag-off still validates a provided key.
    for (const bad of [
      'not-base64url-at-all',
      Buffer.alloc(31, 1).toString('base64url'),
      Buffer.alloc(33, 1).toString('base64url'),
      `${Buffer.alloc(32, 1).toString('base64url')}=`, // padding is not base64url
    ]) {
      assert.throws(
        () => loadFaviconPolicyAdmissionConfig({ KNOWN_FEATURE_FAVICON_POLICY: 'true',
          FAVICON_CURSOR_HMAC_KEY: bad }),
        /FAVICON_CURSOR_HMAC_KEY/,
        `key ${bad.length} chars must be rejected`,
      );
    }
  });

  test('FAVICON_* contract values are enforced: ranges and consts fail closed', () => {
    assert.equal(loadFaviconPolicyAdmissionConfig({ FAVICON_FETCH_TIMEOUT_MS: '7000' }).fetchTimeoutMs, 7_000);
    assert.throws(() => loadFaviconPolicyAdmissionConfig({ FAVICON_FETCH_TIMEOUT_MS: '500' }),
      /FAVICON_FETCH_TIMEOUT_MS/);
    for (const [key, bad] of [
      ['FAVICON_FETCH_MAX_BYTES', '65537'],
      ['FAVICON_FETCH_MAX_REDIRECTS', '2'],
      ['FAVICON_JOB_BATCH_SIZE', '99'],
      ['FAVICON_JOB_MAX_ATTEMPTS', '4'],
      ['FAVICON_HISTORY_RETENTION_SECONDS', '1'],
      ['FAVICON_JOB_CONCURRENCY', '3'],
    ] as const) {
      assert.throws(() => loadFaviconPolicyAdmissionConfig({ [key]: bad }), new RegExp(key));
    }
    assert.throws(() => loadFaviconPolicyAdmissionConfig({ FAVICON_RETRY_BACKOFF_SECONDS: '1,2,3' }),
      /FAVICON_RETRY_BACKOFF_SECONDS/);
    assert.throws(() => loadFaviconPolicyAdmissionConfig({ FAVICON_RETRY_BACKOFF_SECONDS: '1,2,4,8,99' }),
      /FAVICON_RETRY_BACKOFF_SECONDS/);
    assert.deepEqual(
      [...loadFaviconPolicyAdmissionConfig({ FAVICON_RETRY_BACKOFF_SECONDS: '1,2,4,8,16' }).retryBackoffSeconds],
      [1, 2, 4, 8, 16],
    );
  });
});

describe('updateMyFaviconPolicy application command', () => {
  test('CAS conflict surfaces CollectionPreconditionError with the freshly read currentEtag', async () => {
    const receipts = new MemoryReceipts();
    const policies: FaviconPolicyWritePort = {
      // Local read still sees expected revision 2, but the CAS write loses a
      // concurrent writer that advanced the row to 3.
      findByAccountId: async () => policyRow({ revision: 2n }),
      update: async () => ({ kind: 'stale', currentRevision: 3n }),
    };
    await assert.rejects(() => updateMyFaviconPolicy({
      receipts,
      clock: { now: async () => new Date('2026-09-14T00:00:00.000Z') },
      policies,
      batchJobs: noBatchJobs(),
    }, {
      actor: { principalId: ACCOUNT, subjectId: 'sub-fo01' },
      commandId: '11111111-1111-4111-8111-111111111111',
      expectedEtag: '"favicon-policy:2"',
      patch: { newDefault: 'none' },
    }), (error: unknown) => error instanceof CollectionPreconditionError
      && error.currentEtag === '"favicon-policy:3"');
  });

  test('no-op patch returns the same revision without a receipt write', async () => {
    const receipts = new MemoryReceipts();
    let called = false;
    const policies: FaviconPolicyWritePort = {
      findByAccountId: async () => policyRow({ newDefault: 'none', revision: 2n }),
      update: async () => { called = true; return { kind: 'updated', row: policyRow() }; },
    };
    const outcome = await updateMyFaviconPolicy({
      receipts,
      clock: { now: async () => new Date('2026-09-14T00:00:00.000Z') },
      policies,
      batchJobs: noBatchJobs(),
    }, {
      actor: { principalId: ACCOUNT, subjectId: 'sub-fo01' },
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedEtag: '"favicon-policy:2"',
      patch: { newDefault: 'none' },
    });
    assert.equal(outcome.kind, 'succeeded');
    if (outcome.kind === 'succeeded') {
      assert.equal(outcome.changed, false);
      assert.equal(outcome.policy.revision, 2n);
      assert.equal(outcome.jobId, null);
    }
    assert.equal(called, false);
    assert.equal(receipts.stored.size, 1); // receipt completed with the unchanged body
  });

  test('exact replay replays before fresh If-Match; changed fingerprint is reused', async () => {
    const receipts = new MemoryReceipts();
    const write: FaviconPolicyWritePort = {
      findByAccountId: async () => policyRow({ revision: 1n }),
      update: async (input) => ({ kind: 'updated', row: policyRow({ revision: 2n, newDefault: input.newDefault }) }),
    };
    const input = {
      actor: { principalId: ACCOUNT, subjectId: 'sub-fo01' },
      commandId: '33333333-3333-4333-8333-333333333333',
      expectedEtag: '"favicon-policy:1"',
      patch: { newDefault: 'none' } as const,
    };
    const first = await updateMyFaviconPolicy({
      receipts, clock: clock(), policies: write, batchJobs: noBatchJobs(),
    }, input);
    assert.equal(first.kind, 'succeeded');
    const replay = await updateMyFaviconPolicy({
      receipts, clock: clock(), policies: write, batchJobs: noBatchJobs(),
    }, input);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')), {
        policy: {
          revision: '2', newDefault: 'none', providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
          fillMissing: false, forceAllOnline: false, updatedAt: '2026-09-14T00:00:00.000Z',
        },
        jobId: null,
      });
      // The saved outcome replays with its ETag so a client can feed it back
      // as the next If-Match.
      assert.equal(replay.stableHeaders['etag'], '"favicon-policy:2"');
    }
    const reused = await updateMyFaviconPolicy({
      receipts, clock: clock(), policies: write, batchJobs: noBatchJobs(),
    }, {
      ...input,
      patch: { newDefault: 'capture' },
    });
    assert.equal(reused.kind, 'reused');
  });
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MemoryReceipts implements ProductCommandReceiptPort {
  readonly stored = new Map<string, { fingerprint: string; result: ProductCommandResult }>();
  private readonly claims = new Map<string, { fingerprint: string; issuedAt: number }>();
  private key(binding: { principalId: string; commandScope: string; commandId: string }): string {
    return `${binding.principalId}\u0000${binding.commandScope}\u0000${binding.commandId}`;
  }
  async claim(binding: { principalId: string; commandScope: string; commandId: string },
    fingerprint: string): Promise<ProductCommandClaim> {
    const key = this.key(binding);
    const existing = this.stored.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? { kind: 'replay', result: existing.result }
        : { kind: 'reused' };
    }
    const active = this.claims.get(key);
    if (active !== undefined && active.fingerprint !== fingerprint) return { kind: 'reused' };
    this.claims.set(key, { fingerprint, issuedAt: Date.now() });
    return { kind: 'claimed' };
  }
  async complete(binding: { principalId: string; commandScope: string; commandId: string },
    fingerprint: string, result: ProductCommandResult): Promise<void> {
    this.stored.set(this.key(binding), { fingerprint, result });
    this.claims.delete(this.key(binding));
  }
  async purgeExpired(): Promise<number> { return 0; }
  async deletePrincipalReceipts(): Promise<number> { return 0; }
}

function clock() {
  return { now: async () => new Date('2026-09-14T00:00:00.000Z') };
}

function noBatchJobs(): import('../../../src/modules/collections/index.js').FaviconPolicyBatchJobCommandPorts {
  return {
    jobs: {
      insertJob: async () => { throw new Error('unexpected job insert'); },
      extendRestoreGeneration: async () => { throw new Error('unexpected restore generation'); },
      insertItems: async () => { throw new Error('unexpected item insert'); },
      findActiveBatchJob: async () => null,
      supersedeActiveBatchJobs: async () => {},
      findJobForAccount: async () => null,
    },
    candidates: {
      listCandidates: async () => [],
    },
    restores: {
      listByAccountId: async () => [],
    },
  };
}

function lockedNode(resourceRevision: string): LockedNodeRow {
  return {
    id: 'node-fo01-unit',
    collectionId: 'coll-fo01-unit',
    parentId: null,
    kind: 'bookmark',
    isRoot: false,
    title: 'Unit',
    url: 'https://example.test/unit',
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: 'P',
    resourceRevision,
    childrenRevision: 'ch',
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T00:00:00.000Z'),
    deletedAt: null,
  };
}

function rowSources(row?: Partial<BookmarkIconSourceRow>): BookmarkIconSourceReadPort {
  return {
    findByNodeId: async () => (row === undefined ? null : ({
      nodeId: 'node-fo01-unit',
      collectionId: 'coll-fo01-unit',
      sourceMode: 'inherit',
      revision: 1n,
      updatedAt: new Date('2026-09-14T00:00:00.000Z'),
      ...row,
    })),
  };
}

function noneSources(): BookmarkIconSourceReadPort {
  return { findByNodeId: async () => null };
}

function nonePolicies(): FaviconPolicyReadPort {
  return { findByAccountId: async () => null };
}

function shareLockPort() {
  return { lockForShare: async () => null };
}

function nodePort(node: LockedNodeRow) {
  return { getNode: async () => node };
}

function allowPort() {
  return {
    loadCollectionFacts: async () => ({
      collectionId: 'coll-fo01-unit',
      ownerSubjectId: ACCOUNT,
      visibility: 'private' as const,
      policyRevision: 'p',
      membershipRole: 'owner' as const,
      deleted: false,
    }),
  };
}

function pick(view: IconSourceView): Record<string, string | boolean | null> {
  return {
    revision: view.revision.toString(),
    policyRevision: view.policyRevision.toString(),
    sourceMode: view.sourceMode,
    effectiveMode: view.effectiveMode,
    iconUrl: view.iconUrl,
    iconVersion: view.iconVersion,
    status: view.status,
    restorable: view.restorable,
  };
}