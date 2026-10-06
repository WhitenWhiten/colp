import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { transformExportExtensionCarrier } from '../../src/adapters/index.js';
import {
  preserveExtensions,
  type ExtensionSecurityPolicy,
} from '../../src/schema/index.js';
import { parseIJson } from '../../src/server/index.js';
import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import {
  transformSyncExtensionCarrier,
} from '../../src/sync/index.js';
import {
  createSequenceState,
  decideSequence,
  recordSequenceResult,
} from '../../src/sync/legacy.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = 'core.unknown-extension-preservation';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const retainedNamespace = 'https://vendor.example/extensions/retained/v1';
const removedNamespace = 'https://security.example/extensions/private/v1';

type JsonObject = Record<string, any>;

async function fixture(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as JsonObject;
}

function extensionPayload(): JsonObject {
  return {
    nested: {
      arbitrary: [null, false, 0, '', { deeper: ['unchanged', { flag: true }] }],
    },
  };
}

function protocolJson(value: unknown, headers?: ConstructorParameters<typeof Headers>[0]): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('ETag', responseHeaders.get('ETag') ?? '"core-0012"');
  return Response.json(value, { headers: responseHeaders });
}

describe(`unknown extension preservation [evidence:${evidence}]`, () => {
  it('preserves multiple namespaces and deeply nested arbitrary JSON through the server JSON boundary', () => {
    const extensions = {
      [retainedNamespace]: extensionPayload(),
      'https://another.example/ns': [null, false, 0, '', { opaque: ['value'] }],
    };
    const source = JSON.stringify({ extensions });

    expect(parseIJson(source)).toEqual({ extensions });
  });

  it.each([null, false, 0, ''])(
    'preserves the extension payload %j without truthiness filtering',
    (payload) => {
      expect(parseIJson(JSON.stringify({ extensions: { [retainedNamespace]: payload } }))).toEqual({
        extensions: { [retainedNamespace]: payload },
      });
    },
  );

  it('validates without mutating unknown extensions or a document with missing extensions', async () => {
    const snapshot = await fixture('sync-snapshot.json') as unknown as Snapshot;
    const mutable = snapshot as unknown as JsonObject;
    mutable.collection.extensions = {
      [retainedNamespace]: extensionPayload(),
      'https://another.example/ns': null,
    };
    delete mutable.nodes[0].extensions;
    const before = structuredClone(snapshot);

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
    expect(snapshot).toEqual(before);
    expect('extensions' in mutable.nodes[0]).toBe(false);
  });

  it('preserves per-page unknown extensions while assembling a paginated relay', async () => {
    const source = await fixture('sync-snapshot.json') as unknown as Snapshot;
    const publication = await fixture('collection-snapshot.json');
    source.annotations = publication.annotations;
    source.annotations[0]!.visibility = 'private';
    source.attachments = [{
      id: 'attachment-1',
      collectionId,
      subject: { type: 'node', id: source.nodes[0]!.id },
      rel: 'alternate',
      url: 'https://example.com/attachment',
      visibility: 'private',
      createdAt: '2026-07-15T02:00:00Z',
      updatedAt: '2026-07-15T02:00:00Z',
      revision: 'attachment-revision',
      extensions: { 'https://attachment.example/ns': '' },
    }] as any;
    source.relations = [{
      id: 'relation-1',
      collectionId,
      type: 'related',
      fromNodeId: source.nodes[0]!.id,
      toNodeId: source.nodes[1]!.id,
      visibility: 'private',
      createdAt: '2026-07-15T02:00:00Z',
      updatedAt: '2026-07-15T02:00:00Z',
      revision: 'relation-revision',
      extensions: { 'https://relation.example/ns': null },
    }] as any;
    (source.annotations[0] as JsonObject).extensions = {
      'https://annotation.example/ns': [false, 0],
    };
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    (first.nodes[0] as JsonObject).extensions = { [retainedNamespace]: extensionPayload() };
    second.nodes = source.nodes.slice(1);
    second.attachments = [];
    second.relations = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    (second.nodes[0] as JsonObject).extensions = { 'https://another.example/ns': false };
    const before = structuredClone([first, second]);

    const result = assembleSnapshotPages([first, second]);

    if (!result.valid) throw new Error(JSON.stringify(result.issues));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.snapshot.nodes.map((node) => node.extensions)).toEqual([
        { [retainedNamespace]: extensionPayload() },
        { 'https://another.example/ns': false },
      ]);
      expect(result.snapshot.annotations[0]!.extensions).toEqual({
        'https://annotation.example/ns': [false, 0],
      });
      expect(result.snapshot.attachments[0]!.extensions).toEqual({
        'https://attachment.example/ns': '',
      });
      expect(result.snapshot.relations[0]!.extensions).toEqual({
        'https://relation.example/ns': null,
      });
    }
    expect([first, second]).toEqual(before);
  });

  it('preserves unknown extensions through the public client and pagination relay', async () => {
    const manifest = await fixture('public-manifest.json');
    const source = await fixture('collection-snapshot.json') as unknown as Snapshot;
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    first.collection.extensions = { [retainedNamespace]: extensionPayload() };
    (first.nodes[0] as JsonObject).extensions = { [retainedNamespace]: null };
    second.nodes = source.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    second.collection.extensions = structuredClone(first.collection.extensions);
    (second.nodes[0] as JsonObject).extensions = { 'https://another.example/ns': 0 };
    const wirePages = structuredClone([first, second]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return protocolJson(manifest);
      return url.searchParams.has('pageCursor')
        ? protocolJson(second)
        : protocolJson(first, {
            Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"',
          });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    const received = await client.getSnapshot(collectionId);

    expect(received.collection.extensions).toEqual({ [retainedNamespace]: extensionPayload() });
    expect(received.nodes.map((node) => node.extensions)).toEqual([
      { [retainedNamespace]: null },
      { 'https://another.example/ns': 0 },
    ]);
    expect([first, second]).toEqual(wirePages);
  });

  it('preserves unknown extension-bearing results at the sync-server receipt and replay boundary', () => {
    const result = {
      status: 'applied',
      resource: { extensions: { [retainedNamespace]: extensionPayload() } },
    } as const;
    const state = recordSequenceResult(createSequenceState<typeof result>(), {
      sequence: 1,
      digest: 'digest-1',
      status: 'applied',
      result,
    });

    expect(decideSequence(state, 1, 'digest-1')).toEqual({ kind: 'replay', result });
    expect(result.resource.extensions).toEqual({ [retainedNamespace]: extensionPayload() });
  });

  it('enforces preservation through callable sync-server and export-adapter contracts', () => {
    const source = {
      id: 'node-1',
      extensions: {
        [retainedNamespace]: extensionPayload(),
        'https://another.example/ns': false,
      },
    };
    const before = structuredClone(source);

    expect(transformSyncExtensionCarrier(source, { id: source.id })).toEqual({
      value: source,
      extensionRemovals: [],
    });
    expect(transformExportExtensionCarrier(source, { id: source.id })).toEqual({
      value: source,
      lossless: true,
      warnings: [],
      extensionRemovals: [],
      extensionDegradations: [],
    });
    expect(source).toEqual(before);
  });

  it('directly applies and audits Sync extension transformation policy', () => {
    const source = {
      id: 'node-1',
      extensions: {
        [retainedNamespace]: extensionPayload(),
        [removedNamespace]: { private: true },
      },
    };
    const before = structuredClone(source);
    const decide = vi.fn(({ namespace }: { namespace: string }) => namespace === removedNamespace
      ? { action: 'remove' as const, reason: 'private extension is not projected' }
      : { action: 'preserve' as const });
    const policy: ExtensionSecurityPolicy = { id: 'sync-projection-v1', decide };
    const ownerPath = '/nodes/with~tilde/and/slash';

    const result = transformSyncExtensionCarrier(
      source,
      { id: source.id, title: 'Projected' },
      { extensionCarrierPath: ownerPath, extensionSecurityPolicy: policy },
    );

    expect(result.value).toEqual({
      id: source.id,
      title: 'Projected',
      extensions: { [retainedNamespace]: extensionPayload() },
    });
    expect(result.extensionRemovals).toEqual([{
      namespace: removedNamespace,
      path: `${ownerPath}/extensions/${removedNamespace.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      surface: 'sync-server',
      policyId: policy.id,
      reason: 'private extension is not projected',
    }]);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      namespace: retainedNamespace,
      path: `${ownerPath}/extensions/${retainedNamespace.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      surface: 'sync-server',
    }));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      namespace: removedNamespace,
      surface: 'sync-server',
    }));
    expect(result.value.extensions).not.toBe(source.extensions);
    expect(Object.isFrozen(result.value.extensions)).toBe(true);
    expect(Object.isFrozen(result.value.extensions?.[retainedNamespace])).toBe(true);
    expect(source).toEqual(before);
  });

  it('forbids silent or default filtering at export and adapter transformation boundaries', () => {
    const source = {
      id: 'node-1',
      extensions: {
        [retainedNamespace]: extensionPayload(),
        [removedNamespace]: false,
      },
    };
    const before = structuredClone(source);
    const preserveOnlyPolicy: ExtensionSecurityPolicy = {
      id: 'export-policy-empty',
      decide: () => ({ action: 'preserve' }),
    };

    const implicit = transformExportExtensionCarrier(source, { id: source.id });
    const emptyExplicitPolicy = transformExportExtensionCarrier(source, { id: source.id }, {
      extensionSecurityPolicy: preserveOnlyPolicy,
    });

    expect(implicit).toEqual({
      value: source,
      lossless: true,
      warnings: [],
      extensionRemovals: [],
      extensionDegradations: [],
    });
    expect(emptyExplicitPolicy).toEqual({
      value: source,
      lossless: true,
      warnings: [],
      extensionRemovals: [],
      extensionDegradations: [],
    });
    expect(source).toEqual(before);
  });

  it('removes only explicitly named namespaces and returns an auditable record for every removal', () => {
    const source = {
      id: 'node-1',
      extensions: {
        [removedNamespace]: 0,
        [retainedNamespace]: extensionPayload(),
        'https://another.example/ns': '',
      },
    };
    const policy: ExtensionSecurityPolicy = {
      id: 'security-policy-private-extension-v1',
      decide: ({ namespace }) => namespace === removedNamespace
        ? { action: 'remove', reason: 'private namespace is excluded from this export' }
        : { action: 'preserve' },
    };
    const before = structuredClone(source);

    const result = transformExportExtensionCarrier(source, { id: source.id }, {
      extensionSecurityPolicy: policy,
      extensionCarrierPath: '/nodes/0',
    });

    expect(result.value).toEqual({
      id: 'node-1',
      extensions: {
        [retainedNamespace]: extensionPayload(),
        'https://another.example/ns': '',
      },
    });
    expect(result.extensionRemovals).toEqual([
      {
        policyId: 'security-policy-private-extension-v1',
        namespace: removedNamespace,
        path: `/nodes/0/extensions/${removedNamespace.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        surface: 'export-adapter',
        reason: 'private namespace is excluded from this export',
      },
    ]);
    expect(source).toEqual(before);
  });

  it('applies explicit security removal at page assembly and audits each carrier path', async () => {
    const snapshot = await fixture('sync-snapshot.json') as unknown as Snapshot;
    snapshot.collection.extensions = {
      [removedNamespace]: null,
      [retainedNamespace]: extensionPayload(),
    };
    (snapshot.nodes[0] as JsonObject).extensions = {
      [removedNamespace]: false,
      'https://another.example/ns': 0,
    };
    const before = structuredClone(snapshot);
    const policy: ExtensionSecurityPolicy = {
      id: 'sync-export-private-extension-v1',
      decide: ({ namespace }) => namespace === removedNamespace
        ? { action: 'remove', reason: 'explicit replica export policy' }
        : { action: 'preserve' },
    };

    const result = assembleSnapshotPages([snapshot], { extensionSecurityPolicy: policy });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.snapshot.collection.extensions).toEqual({
        [retainedNamespace]: extensionPayload(),
      });
      expect(result.snapshot.nodes[0]!.extensions).toEqual({
        'https://another.example/ns': 0,
      });
      expect(result.extensionRemovals).toEqual([
        expect.objectContaining({
          namespace: removedNamespace,
          path: `/collection/extensions/${removedNamespace.replaceAll('~', '~0').replaceAll('/', '~1')}`,
          policyId: policy.id,
          surface: 'page-assembly',
        }),
        expect.objectContaining({
          namespace: removedNamespace,
          path: `/nodes/0/extensions/${removedNamespace.replaceAll('~', '~0').replaceAll('/', '~1')}`,
          policyId: policy.id,
          surface: 'page-assembly',
        }),
      ]);
    }
    expect(snapshot).toEqual(before);
  });

  it('fails closed without returning partial output when a security policy is invalid or throws', () => {
    const source = {
      [removedNamespace]: false,
      [retainedNamespace]: extensionPayload(),
    };
    const before = structuredClone(source);

    expect(() => preserveExtensions(source, {
      surface: 'sync-server',
      securityPolicy: { id: ' ', decide: () => ({ action: 'preserve' }) },
    })).toThrow('non-empty id');
    expect(() => preserveExtensions(source, {
      surface: 'sync-server',
      securityPolicy: {
        id: 'missing-reason-policy',
        decide: () => ({ action: 'remove', reason: ' ' }),
      },
    })).toThrow('non-empty reason');
    expect(() => preserveExtensions(source, {
      surface: 'sync-server',
      securityPolicy: {
        id: 'throwing-policy',
        decide: ({ namespace }) => {
          if (namespace === retainedNamespace) throw new Error('policy evaluation failed');
          return { action: 'remove', reason: 'first decision' };
        },
      },
    })).toThrow('policy evaluation failed');
    expect(source).toEqual(before);
  });
});
