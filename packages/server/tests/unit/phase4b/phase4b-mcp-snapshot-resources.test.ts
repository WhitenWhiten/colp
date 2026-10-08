import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestAbortedError,
  McpResourceNotFoundError,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  createPhase4bMcpSnapshotResourceProjection,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  serializeMcpIJson,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  createPublicationCursorKeyring,
  type PublicationAnnotationReadPort,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import {
  publicationAnnotation,
  publicationCollection,
  publicationNode,
  publicationRoot,
} from '../../fixtures/phase2/publication-annotations.js';
import type { SharedExposureBlobFacts } from '../../../src/modules/attachments/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const OWNER = 'subject-owner';
const MEMBER = 'subject-member';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
  OIDC_ISSUER: 'https://issuer.example.test/realms/known',
  OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  } as Record<string, string>;
}

function locator(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
}

interface QueryFixtureOptions {
  readonly nodes?: readonly PublicationNodeRecord[];
  readonly annotations?: readonly ReturnType<typeof publicationAnnotation>[];
  readonly current?: () => PublicationCollectionRecord;
  readonly member?: boolean;
  readonly annotationCalls?: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]>;
  /** Exposure-eligibility facts port override (real sentinel-bearing blob facts). */
  readonly sharedExposure?: PublicationSnapshotQueryPorts['sharedExposure'];
}

function makeQuery(options: QueryFixtureOptions = {}): PublicationSnapshotQueryPorts {
  const current = options.current ?? (() => publicationCollection());
  const nodes = options.nodes ?? [];
  const annotations = options.annotations ?? [];
  const cursors = createPublicationCursorKeyring({
    active: { id: 'snapshot-unit', secret: Buffer.alloc(32, 91).toString('base64') },
    retained: [],
  });
  return {
    reads: {
      async loadPage(request) {
        const start = request.afterLocator
          ? Math.max(0, nodes.findIndex((row) => locator(row.id) === request.afterLocator) + 1)
          : request.after
            ? Math.max(0, nodes.findIndex((row) => row.id === request.after?.nodeId) + 1)
            : 0;
        return {
          isolation: 'repeatable read',
          comparatorVersion: 'parent-position-id-v1',
          collection: current(),
          root: publicationRoot,
          candidates: request.metadataOnly ? [] : nodes.slice(start, start + request.limit + 1),
        };
      },
    },
    annotations: {
      async loadPage(request) {
        options.annotationCalls?.push(request);
        const start = request.afterLocator
          ? Math.max(0, annotations.findIndex((row) => locator(row.id) === request.afterLocator) + 1)
          : request.after
            ? Math.max(0, annotations.findIndex((row) => row.id === request.after?.annotationId) + 1)
            : 0;
        const collection = current();
        return {
          isolation: 'repeatable read',
          comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
          contentRevision: collection.contentRevision,
          policyRevision: collection.policyRevision,
          candidates: annotations.slice(start, start + request.limit + 1),
        };
      },
    },
    accessPolicy: {
      async loadCollectionFacts() {
        const collection = current();
        return {
          collectionId: collection.id,
          ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility,
          policyRevision: collection.policyRevision,
          membershipRole: options.member ? 'viewer' : null,
          deleted: false,
        };
      },
    },
    cursors,
    origin: 'https://known.example',
    now: () => NOW,
    sharedExposure: options.sharedExposure ?? Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

function createFixture(options: QueryFixtureOptions = {}): {
  readonly projection: Phase4bMcpSnapshotResourceProjection;
  readonly destroy: () => void;
} {
  const query = makeQuery(options);
  const projection = createPhase4bMcpSnapshotResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    snapshotQuery: query,
    now: () => NOW,
    pageSize: 2,
  });
  return {
    projection,
    destroy() {
      query.cursors.destroy();
    },
  };
}

function snapshotInput(collectionId = 'collection-1'): Readonly<{ resource: { kind: 'collection-snapshot'; collectionId: string } }> {
  return Object.freeze({
    resource: Object.freeze({ kind: 'collection-snapshot', collectionId }),
  });
}

function trustedContext(overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
    ...overrides,
  });
}

function authenticatedContext(principalId: string): McpTrustedReadRequestContext {
  return trustedContext({
    binding: Object.freeze({
      kind: 'authenticated',
      principalId,
      clientId: 'mcp-client',
      credentialBindingId: 'credential-1',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    authorization: Object.freeze({ accountSubjectId: principalId }),
  });
}

async function readBody(
  projection: Phase4bMcpSnapshotResourceProjection,
  input: Readonly<{ resource: { kind: 'collection-snapshot'; collectionId: string } }>,
  context: McpTrustedReadRequestContext,
): Promise<Record<string, unknown>> {
  const result = await projection.readResource(input, context);
  assert.equal(result.contents[0]!.mimeType, PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE);
  assert.deepEqual(result.contents[0]!.provenance, { origin: 'internal' });
  return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
}

test('empty snapshot returns a complete COLP Snapshot JSON without sidecars or internal facts', async () => {
  const fixture = createFixture({ nodes: [] });
  try {
    const body = await readBody(fixture.projection, snapshotInput(), trustedContext());
    assert.equal(body.complete, true);
    assert.equal((body.nodes as unknown[]).length, 1);
    assert.deepEqual(body.annotations, []);
    assert.deepEqual(body.relations, []);
    assert.deepEqual(body.attachments, []);
    assert.deepEqual(body.tombstones, []);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /ownerSubjectId|membershipRole|"policyRevision"|subjectId/iu);
  } finally {
    fixture.destroy();
  }
});

test('large snapshot returns a bounded Resource Link summary and never claims complete', async () => {
  const nodes = Array.from({ length: 5 }, (_, index) => publicationNode(`node-${index}`));
  const fixture = createFixture({ nodes });
  try {
    const result = await fixture.projection.readResource(snapshotInput(), trustedContext());
    const text = result.contents[0]!.text;
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.type, 'collection_snapshot_summary');
    assert.equal(body.complete, false);
    assert.equal(body.bounded, true);
    assert.equal(body.reason, 'continuation_available');
    assert.equal(Array.isArray(body.nodes), false);
    assert.equal((body.counts as Record<string, number>).nodes! <= 2, true);
    const page = body.page as Record<string, unknown>;
    const resourceLink = body.resourceLink as Record<string, unknown>;
    assert.equal(resourceLink.type, 'resource_link');
    assert.equal(
      resourceLink.uri,
      `colp://${SERVER_UUID}/collections/collection-1/snapshot`,
    );
    assert.ok(page.nextCursor);
    assert.ok((body.continuation as Record<string, unknown>).cursor);
    assert.ok(Buffer.byteLength(text, 'utf8') <= DEFAULT_MCP_RESOURCE_READ_BUDGET.maxTextBytes);
    assert.doesNotMatch(text, /ownerSubjectId|membershipRole|policyRevision/iu);
  } finally {
    fixture.destroy();
  }
});

test('output budget fallback returns a bounded summary instead of a fake complete snapshot', async () => {
  const fixture = createFixture({ nodes: [] });
  try {
    const body = await readBody(fixture.projection, snapshotInput(), trustedContext({
      budget: Object.freeze({ ...DEFAULT_MCP_RESOURCE_READ_BUDGET, maxNodes: 1 }),
    }));
    assert.equal(body.complete, false);
    assert.equal(body.bounded, true);
    assert.equal(body.reason, 'output_budget');
    assert.equal(Array.isArray(body.nodes), false);
  } finally {
    fixture.destroy();
  }
});

test('abort is checked before and after the snapshot projection call', async () => {
  const fixture = createFixture({ nodes: [] });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => fixture.projection.readResource(snapshotInput(), trustedContext({ abortSignal: controller.signal })),
      McpReadRequestAbortedError,
    );
    await assert.rejects(
      () => fixture.projection.cacheForRead(snapshotInput(), trustedContext({ abortSignal: controller.signal })),
      McpReadRequestAbortedError,
    );
  } finally {
    fixture.destroy();
  }
});

test('continuation binds revision scope and page mutation expires as not found', async () => {
  const state = {
    collection: publicationCollection(),
    nodes: [
      publicationNode('node-1'),
      publicationNode('node-2'),
      publicationNode('node-3'),
    ],
  };
  const fixture = createFixture({
    nodes: state.nodes,
    current: () => state.collection,
  });
  try {
    const first = await readBody(fixture.projection, snapshotInput(), trustedContext());
    const cursor = (first.page as Record<string, unknown>).nextCursor as string;
    assert.ok(cursor);
    state.collection = publicationCollection({ contentRevision: 'content-after-mutation' });

    await assert.rejects(
      () => fixture.projection.readPage(
        Object.freeze({ resource: snapshotInput().resource, pageCursor: cursor }),
        trustedContext(),
      ),
      McpResourceNotFoundError,
    );

    const fresh = await readBody(fixture.projection, snapshotInput(), trustedContext());
    assert.equal((fresh.collection as Record<string, unknown>).revision, 'content-after-mutation.policy-1');
    assert.notEqual(fresh.revision, first.revision);
  } finally {
    fixture.destroy();
  }
});

test('sidecar projection ports are not invoked unless requested', async () => {
  const calls: Array<Parameters<PublicationAnnotationReadPort['loadPage']>[0]> = [];
  const fixture = createFixture({
    annotations: [
      publicationAnnotation('annotation-1', {
        payload: {
          ...publicationAnnotation('annotation-1').payload,
          value: 'secret-sidecar-content',
        },
      }),
    ],
    annotationCalls: calls,
  });
  try {
    const result = await fixture.projection.readResource(snapshotInput(), trustedContext());
    const body = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    assert.deepEqual(body.annotations, []);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(result.contents[0]!.text, /secret-sidecar-content/u);
  } finally {
    fixture.destroy();
  }
});

test('malicious untrusted content is escaped as I-JSON data, not raw control or Unicode', async () => {
  const title = 'injected\n<script>alert("x")</script> 中文🙂';
  const url = 'https://example.test/?q=%22%3E%3Csvg%20onload%3Dalert(1)%3E';
  const fixture = createFixture({
    nodes: [publicationNode('node-malicious', { title, url })],
  });
  try {
    const result = await fixture.projection.readResource(snapshotInput(), trustedContext());
    const text = result.contents[0]!.text;
    assert.equal(Buffer.byteLength(text, 'utf8'), text.length);
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/u);
    assert.ok(text.includes('\\u4e2d'));
    assert.ok(text.includes('\\ud83d\\ude42'));
    const body = JSON.parse(text) as { nodes: Array<{ title: string; url: string }> };
    const node = body.nodes.find((candidate) => candidate.title === title)!;
    assert.equal(node.url, url);
    assert.doesNotMatch(text, /ownerSubjectId|creatorPrincipalId|subjectId/iu);

    assert.throws(() => serializeMcpIJson({ value: '\ud800' }), TypeError);
  } finally {
    fixture.destroy();
  }
});

test('cache metadata stays private for authenticated, unlisted, and continuation results', async () => {
  const publicFixture = createFixture({ nodes: [] });
  try {
    assert.deepEqual(
      await publicFixture.projection.cacheForRead(snapshotInput(), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
    assert.deepEqual(
      await publicFixture.projection.cacheForRead(snapshotInput(), authenticatedContext(OWNER)),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    publicFixture.destroy();
  }

  const largeFixture = createFixture({
    nodes: [publicationNode('node-1'), publicationNode('node-2')],
  });
  try {
    assert.deepEqual(
      await largeFixture.projection.cacheForRead(snapshotInput(), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    largeFixture.destroy();
  }

  const unlistedFixture = createFixture({
    nodes: [],
    current: () => publicationCollection({ visibility: 'unlisted' }),
  });
  try {
    assert.deepEqual(
      await unlistedFixture.projection.cacheForRead(snapshotInput(), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    unlistedFixture.destroy();
  }
});

test('member snapshots use the existing Publication projection and private cache scope', async () => {
  const fixture = createFixture({
    nodes: [],
    member: true,
    current: () => publicationCollection({ visibility: 'protected' }),
  });
  try {
    const body = await readBody(fixture.projection, snapshotInput(), authenticatedContext(MEMBER));
    assert.equal(body.complete, true);
    assert.equal((body.collection as Record<string, unknown>).visibility, 'protected');
    assert.doesNotMatch(JSON.stringify(body), /ownerSubjectId|membershipRole|"policyRevision"/iu);
    assert.deepEqual(
      await fixture.projection.cacheForRead(snapshotInput(), authenticatedContext(MEMBER)),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    fixture.destroy();
  }
});

test('non-snapshot resources are concealed', async () => {
  const fixture = createFixture({ nodes: [] });
  try {
    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-node', collectionId: 'collection-1', nodeId: 'node-1' }),
        }),
        trustedContext(),
      ),
      McpResourceNotFoundError,
    );
  } finally {
    fixture.destroy();
  }
});

// ---------------------------------------------------------------------------
// FIX-M-021: attachment metadata sentinels in the exposure facts
// ---------------------------------------------------------------------------

const UNIT_ATTACHMENT_MARKER = 'unit-attachment-metadata-sentinel';

/**
 * Exposure-eligibility facts for REAL private attachment rows whose
 * non-sensitive metadata fields (blobId, verified mediaType) carry the
 * sentinel. A projection that leaks any of them must fail the marker scan.
 */
function sentinelExposurePort(): PublicationSnapshotQueryPorts['sharedExposure'] {
  const facts: readonly SharedExposureBlobFacts[] = Object.freeze([
    Object.freeze({
      blobId: `unit-blob-${UNIT_ATTACHMENT_MARKER}-stored`,
      logicalState: 'stored_private',
      currentGenerationState: 'active',
    }),
    Object.freeze({
      blobId: `unit-blob-${UNIT_ATTACHMENT_MARKER}-attached`,
      logicalState: 'attached_private',
      currentGenerationState: 'active',
    }),
  ]);
  return Object.freeze({ async listBlobFacts() { return facts; } });
}

function assertNoAttachmentMetadata(text: string): void {
  assert.equal(
    text.includes(UNIT_ATTACHMENT_MARKER),
    false,
    'snapshot must never contain the attachment metadata sentinel',
  );
}

test('real exposure facts for stored_private and attached_private blobs project zero attachment metadata', async () => {
  const fixture = createFixture({ nodes: [], sharedExposure: sentinelExposurePort() });
  try {
    const body = await readBody(fixture.projection, snapshotInput(), trustedContext());
    assert.equal(body.complete, true);
    assert.deepEqual(body.attachments, []);
    assertNoAttachmentMetadata(JSON.stringify(body));
  } finally {
    fixture.destroy();
  }
});

test('mutation negative control: a seam projecting blobId or mediaType is caught by the marker assertion', async () => {
  const fixture = createFixture({ nodes: [], sharedExposure: sentinelExposurePort() });
  try {
    const body = await readBody(fixture.projection, snapshotInput(), trustedContext());
    assert.deepEqual(body.attachments, []);
    for (const leaked of [
      { field: 'blobId', value: `unit-blob-${UNIT_ATTACHMENT_MARKER}-stored` },
      { field: 'mediaType', value: `application/octet-stream; fixture=${UNIT_ATTACHMENT_MARKER}` },
    ] as const) {
      const seamed: Record<string, unknown> = {
        ...body,
        attachments: [Object.freeze({ [leaked.field]: leaked.value })],
      };
      let detected = false;
      try {
        assertNoAttachmentMetadata(JSON.stringify(seamed));
      } catch {
        detected = true;
      }
      assert.equal(detected, true, `a seam projecting ${leaked.field} must redden the suite`);
    }
  } finally {
    fixture.destroy();
  }
});
