/**
 * P4A-I12 PostgreSQL integration: MCP discovery + read projection exclusion.
 *
 * With a REAL private blob seeded through the production ledger (unique marker
 * inside the physical generation key rows and stored bytes) plus a visible
 * control public collection and a REAL private collection owning its own
 * production-seeded attachment sentinel, every MCP public entry — discovery
 * (`createPhase4bMcpDiscoverResult`), Resource list/read
 * (`createPhase4bMcpCollectionResourceProjection`) and Tool
 * (`collections.get` / `collections.get_snapshot` via
 * `createPhase4bMcpReadToolAdapter`) — must:
 *   (a) actually execute (the control collection is visible);
 *   (b) NEVER contain any private marker in discovery, resource lists,
 *       resource reads, tool results or cache metadata;
 *   (c) conceal the real private collection exactly like an absent id
 *       (identical error/cache surface) while its owner reads the private
 *       collection with attachments still zero-projected.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpResourceNotFoundError,
  McpToolOutputUnavailableError,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  type Mcp20260728RequestContext,
  type McpAuthorizationBinding,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpDiscoverResult,
  createPhase4bMcpRequestContext,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpReadToolAdapterBundle,
} from '../../../src/modules/mcp/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  I12_COLLECTION,
  I12_SUBJECT_OWNER,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  I12_MCP_AUDIENCE as AUDIENCE,
  buildI12McpSurface,
} from '../../support/phase4a-i12-mcp-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const I12_PRIVATE_COLLECTION = 'i12-private-collection';

describeWithPostgres('P4A-I12 MCP discovery/read projection exclusion', () => {
  let isolated: I07MigrationRuntime;
  let surface: Phase4bMcpReadToolAdapterBundle;
  let collectionProjection: ReturnType<typeof createPhase4bMcpCollectionResourceProjection>;
  let snapshotProjection: ReturnType<typeof createPhase4bMcpSnapshotResourceProjection>;
  let destroy: () => void;
  const privateMarkers = {
    stored: privateMarker('i12-mcp-stored'),
    attached: privateMarker('i12-mcp-attached'),
    retiredOld: privateMarker('i12-mcp-retired-old'),
    retiredNew: privateMarker('i12-mcp-retired-new'),
    expired: privateMarker('i12-mcp-expired'),
    quarantined: privateMarker('i12-mcp-quarantined'),
    privateCollection: privateMarker('i12-mcp-private-collection'),
    privateCollectionAttached: privateMarker('i12-mcp-private-attached'),
  };

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_i12_mcp', { maxConnections: 10 });
    await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('i12-mcp-control'),
    });

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
    // FIX-L-054: a REAL private collection owning a REAL production-seeded
    // attachment sentinel, so concealment is verified against existing rows
    // instead of a never-existing id.
    await seedControlCollection(isolated.runtime, {
      collectionId: I12_PRIVATE_COLLECTION,
      visibility: 'private',
      title: privateMarkers.privateCollection,
      controlNodeTitle: privateMarkers.privateCollection,
      publicationSlug: I12_PRIVATE_COLLECTION,
    });
    await seedAttachedPrivate(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.privateCollectionAttached),
      { collectionId: I12_PRIVATE_COLLECTION },
    );

    const built = buildI12McpSurface(isolated);
    surface = built.surface;
    collectionProjection = built.collectionProjection;
    snapshotProjection = built.snapshotProjection;
    destroy = built.destroy;
  }, 120_000);

  afterAll(async () => {
    destroy?.();
    await isolated?.dropSchema();
  });

  function trustedContext(): McpTrustedReadRequestContext {
    return Object.freeze({
      binding: Object.freeze({
        kind: 'anonymous', principalId: 'public', resourceAudience: AUDIENCE, securityEpoch: 'epoch-1',
      }),
      scope: Object.freeze([]),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({}),
    });
  }

  function toolContext(
    name: string,
    collectionId: string = I12_COLLECTION,
    binding: McpAuthorizationBinding = createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: 'epoch-1' }),
  ): Mcp20260728RequestContext {
    return createPhase4bMcpRequestContext({
      headers: Object.freeze([
        Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
        Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
        Object.freeze({ name: 'Mcp-Name', value: name }),
        Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: collectionId }),
      ]),
      httpMethod: 'POST',
      body: Object.freeze({
        method: 'tools/call',
        params: Object.freeze({
          _meta: Object.freeze({
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': Object.freeze({ tools: Object.freeze({ call: true }) }),
          }),
          name,
          arguments: Object.freeze({ collectionId }),
        }),
      }),
      binding,
      scope: ['mcp:read:public', 'mcp:read:own'],
      authorization: Object.freeze(
        binding.kind === 'authenticated'
          ? { accountSubjectId: binding.principalId }
          : {},
      ),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
    });
  }

  function assertNoPrivateMarker(value: unknown, label: string): void {
    for (const marker of Object.values(privateMarkers)) {
      assertMarkerAbsentFromJson(value, marker, `${label} (${marker})`);
    }
  }

  /**
   * Owner-authorized outputs legitimately carry the private collection's own
   * marker; every OTHER marker (all blob/attachment sentinels, including the
   * attachment seeded INSIDE the private collection) must stay absent so a
   * zero-projection regression reddens the suite.
   */
  function assertNoAttachmentMarker(value: unknown, label: string): void {
    for (const [name, marker] of Object.entries(privateMarkers)) {
      if (name === 'privateCollection') continue;
      assertMarkerAbsentFromJson(value, marker, `${label} (${marker})`);
    }
  }

  function ownerBinding(): McpAuthorizationBinding {
    return createAuthenticatedBinding({
      credentialKind: 'oauth',
      principalId: I12_SUBJECT_OWNER,
      clientId: 'known-mcp-oauth-client',
      credentialBindingId: 'i12-mcp-owner-credential',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    });
  }

  function trustedOwnerContext(): McpTrustedReadRequestContext {
    return Object.freeze({
      binding: ownerBinding(),
      scope: Object.freeze(['mcp:read:public', 'mcp:read:own']),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({ accountSubjectId: I12_SUBJECT_OWNER }),
    });
  }

  /** Authenticated but NOT the collection owner: the "unauthorized" case. */
  function trustedUnauthorizedContext(): McpTrustedReadRequestContext {
    return Object.freeze({
      binding: createAuthenticatedBinding({
        credentialKind: 'oauth',
        principalId: 'i12-other-subject',
        clientId: 'known-mcp-oauth-client',
        credentialBindingId: 'i12-mcp-other-credential',
        resourceAudience: AUDIENCE,
        securityEpoch: 'epoch-1',
      }),
      scope: Object.freeze(['mcp:read:public', 'mcp:read:own']),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({ accountSubjectId: 'i12-other-subject' }),
    });
  }

  type ConcealmentError = Error & { readonly code: string };

  async function captureRejection(
    run: () => Promise<unknown>,
    errorType: new () => Error,
    label: string,
  ): Promise<ConcealmentError> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof errorType, `${label} must reject with ${errorType.name}`);
      const candidate = error as ConcealmentError;
      assert.equal(typeof candidate.code, 'string', `${label} must carry a stable error code`);
      return candidate;
    }
    assert.fail(`${label} must reject`);
  }

  /** The full observable error surface (name/code/message + serialized) must match absent. */
  function assertSameConcealmentSurface(
    actual: ConcealmentError,
    absent: ConcealmentError,
    label: string,
  ): void {
    assert.equal(actual.name, absent.name, `${label}: error name must match absent`);
    assert.equal(actual.code, absent.code, `${label}: error code must match absent`);
    assert.equal(actual.message, absent.message, `${label}: error message must match absent`);
    assert.equal(JSON.stringify(actual), JSON.stringify(absent), `${label}: serialized error surface must match absent`);
  }

  test('MCP discovery is fixed, executable, and carries zero private marker', () => {
    const discovery = createPhase4bMcpDiscoverResult();
    const serialized = JSON.stringify(discovery);
    assert.equal(serialized.includes('Known MCP Read'), true, 'discovery server identity must be served');
    assert.equal(serialized.includes('tools'), true);
    assertNoPrivateMarker(discovery, 'discovery');
  });

  test('MCP resource list + read serve the control collection with zero private marker', async () => {
    const context = trustedContext();
    const list = await collectionProjection.listResources(Object.freeze({}), context);
    const serializedList = JSON.stringify(list);
    assert.equal(serializedList.includes(I12_COLLECTION), true, 'control collection resource must be listed (link executed)');
    assertNoPrivateMarker(list, 'resource list');

    const read = await collectionProjection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_COLLECTION }) }),
      context,
    );
    assert.equal(JSON.parse(read.contents[0]!.text).collection.visibility, 'public');
    assertNoPrivateMarker(read, 'resource read');

    const cache = await collectionProjection.cacheForRead(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_COLLECTION }) }),
      context,
    );
    assert.deepEqual(cache, { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' });
    assertNoPrivateMarker(cache, 'cache metadata');
  });

  test('MCP tools collections.get + collections.get_snapshot serve the control with zero private marker', async () => {
    const get = await surface.adapter.callTool(
      toolContext('collections.get'),
      { name: 'collections.get', arguments: { collectionId: I12_COLLECTION } },
    );
    const collection = (get.structuredContent as { collection?: Record<string, unknown> }).collection!;
    assert.equal(collection.id, I12_COLLECTION, 'control collection metadata must be served');
    assertNoPrivateMarker(get, 'collections.get');

    const snapshot = await surface.adapter.callTool(
      toolContext('collections.get_snapshot'),
      { name: 'collections.get_snapshot', arguments: { collectionId: I12_COLLECTION } },
    );
    assert.equal(JSON.stringify(snapshot).includes(I12_COLLECTION), true, 'control snapshot link must be served');
    assertNoPrivateMarker(snapshot, 'collections.get_snapshot');
  });

  test('MCP reads of a REAL private collection are indistinguishable from absent (anonymous/unauthorized)', async () => {
    const anonymous = trustedContext();
    const absentCollection = 'i12-does-not-exist';

    // A REAL private collection (with its own production-seeded attachment)
    // must conceal exactly like an absent id: same error class, same
    // status/body/headers surface (name/code/message/serialized), and the
    // private markers must never ride the error.
    const absentMetadata = await captureRejection(
      () => collectionProjection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: absentCollection }) }),
        anonymous,
      ),
      McpResourceNotFoundError,
      'absent collection metadata read',
    );
    const privateMetadata = await captureRejection(
      () => collectionProjection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_PRIVATE_COLLECTION }) }),
        anonymous,
      ),
      McpResourceNotFoundError,
      'private collection metadata read',
    );
    assertSameConcealmentSurface(privateMetadata, absentMetadata, 'collection-metadata concealment');
    assertNoPrivateMarker(privateMetadata, 'private collection metadata error');

    const unauthorizedMetadata = await captureRejection(
      () => collectionProjection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_PRIVATE_COLLECTION }) }),
        trustedUnauthorizedContext(),
      ),
      McpResourceNotFoundError,
      'unauthorized collection metadata read',
    );
    assertSameConcealmentSurface(unauthorizedMetadata, absentMetadata, 'unauthorized collection-metadata concealment');

    const absentSnapshot = await captureRejection(
      () => snapshotProjection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-snapshot', collectionId: absentCollection }) }),
        anonymous,
      ),
      McpResourceNotFoundError,
      'absent snapshot read',
    );
    const privateSnapshot = await captureRejection(
      () => snapshotProjection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-snapshot', collectionId: I12_PRIVATE_COLLECTION }) }),
        anonymous,
      ),
      McpResourceNotFoundError,
      'private snapshot read',
    );
    assertSameConcealmentSurface(privateSnapshot, absentSnapshot, 'snapshot concealment');
    assertNoPrivateMarker(privateSnapshot, 'private snapshot error');

    // Cache declarations (the "headers" of the read surface) must not
    // distinguish the real private collection from an absent id.
    assert.deepEqual(
      await collectionProjection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_PRIVATE_COLLECTION }) }),
        anonymous,
      ),
      await collectionProjection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: absentCollection }) }),
        anonymous,
      ),
      'collection cache metadata must not distinguish private from absent',
    );
    assert.deepEqual(
      await snapshotProjection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-snapshot', collectionId: I12_PRIVATE_COLLECTION }) }),
        anonymous,
      ),
      await snapshotProjection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-snapshot', collectionId: absentCollection }) }),
        anonymous,
      ),
      'snapshot cache metadata must not distinguish private from absent',
    );

    // Tool surface: the same secret-free error for the real private and the
    // absent id, while the SAME surface still serves the control collection.
    const absentGet = await captureRejection(
      () => surface.adapter.callTool(
        toolContext('collections.get', absentCollection),
        { name: 'collections.get', arguments: { collectionId: absentCollection } },
      ),
      McpToolOutputUnavailableError,
      'absent collections.get',
    );
    const privateGet = await captureRejection(
      () => surface.adapter.callTool(
        toolContext('collections.get', I12_PRIVATE_COLLECTION),
        { name: 'collections.get', arguments: { collectionId: I12_PRIVATE_COLLECTION } },
      ),
      McpToolOutputUnavailableError,
      'private collections.get',
    );
    assertSameConcealmentSurface(privateGet, absentGet, 'collections.get concealment');

    const absentGetSnapshot = await captureRejection(
      () => surface.adapter.callTool(
        toolContext('collections.get_snapshot', absentCollection),
        { name: 'collections.get_snapshot', arguments: { collectionId: absentCollection } },
      ),
      McpToolOutputUnavailableError,
      'absent collections.get_snapshot',
    );
    const privateGetSnapshot = await captureRejection(
      () => surface.adapter.callTool(
        toolContext('collections.get_snapshot', I12_PRIVATE_COLLECTION),
        { name: 'collections.get_snapshot', arguments: { collectionId: I12_PRIVATE_COLLECTION } },
      ),
      McpToolOutputUnavailableError,
      'private collections.get_snapshot',
    );
    assertSameConcealmentSurface(privateGetSnapshot, absentGetSnapshot, 'collections.get_snapshot concealment');

    // The REAL private collection never surfaces in the anonymous list.
    const list = await collectionProjection.listResources(Object.freeze({}), anonymous);
    const serializedList = JSON.stringify(list);
    assert.equal(serializedList.includes(I12_PRIVATE_COLLECTION), false, 'real private collection must never be listed anonymously');
    assertNoPrivateMarker(list, 'anonymous resource list');
  });

  test('owner reads the REAL private collection while attachments stay zero-projected', async () => {
    const owner = trustedOwnerContext();

    // Non-vacuity guard: the owner MUST see the real private collection
    // content (id, visibility, marker-bearing title), otherwise a broken
    // projection that hides the whole collection would pass the attachment
    // assertions vacuously.
    const metadata = await collectionProjection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_PRIVATE_COLLECTION }) }),
      owner,
    );
    const metadataBody = JSON.parse(metadata.contents[0]!.text) as Readonly<Record<string, unknown>>;
    assert.equal((metadataBody.collection as Readonly<Record<string, unknown>>).id, I12_PRIVATE_COLLECTION);
    assert.equal((metadataBody.collection as Readonly<Record<string, unknown>>).visibility, 'private');
    assert.equal(
      JSON.stringify(metadataBody).includes(privateMarkers.privateCollection),
      true,
      'owner must see the real private collection content (non-vacuous)',
    );
    assertNoAttachmentMarker(metadata, 'owner collection metadata read');

    assert.deepEqual(
      await collectionProjection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_PRIVATE_COLLECTION }) }),
        owner,
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );

    const snapshot = await snapshotProjection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-snapshot', collectionId: I12_PRIVATE_COLLECTION }) }),
      owner,
    );
    const snapshotBody = JSON.parse(snapshot.contents[0]!.text) as Readonly<Record<string, unknown>>;
    assert.equal((snapshotBody.collection as Readonly<Record<string, unknown>>).id, I12_PRIVATE_COLLECTION);
    assert.equal(
      JSON.stringify(snapshotBody).includes(privateMarkers.privateCollection),
      true,
      'owner snapshot must serve the real private collection content (non-vacuous)',
    );
    assert.deepEqual(snapshotBody.attachments, [], 'owner snapshot must keep attachments zero-projected');
    assertNoAttachmentMarker(snapshot, 'owner snapshot read');

    const get = await surface.adapter.callTool(
      toolContext('collections.get', I12_PRIVATE_COLLECTION, ownerBinding()),
      { name: 'collections.get', arguments: { collectionId: I12_PRIVATE_COLLECTION } },
    );
    assert.equal(
      (get.structuredContent as { collection?: { visibility?: string } }).collection?.visibility,
      'private',
      'owner collections.get must serve the real private collection',
    );
    assertNoAttachmentMarker(get, 'owner collections.get');

    const snapshotTool = await surface.adapter.callTool(
      toolContext('collections.get_snapshot', I12_PRIVATE_COLLECTION, ownerBinding()),
      { name: 'collections.get_snapshot', arguments: { collectionId: I12_PRIVATE_COLLECTION } },
    );
    const toolBody = snapshotTool.structuredContent as Readonly<Record<string, unknown>>;
    assert.equal((toolBody.collection as Readonly<Record<string, unknown>>).id, I12_PRIVATE_COLLECTION);
    assert.deepEqual(toolBody.attachments, [], 'owner collections.get_snapshot must keep attachments zero-projected');
    assertNoAttachmentMarker(snapshotTool, 'owner collections.get_snapshot');
  });
});
