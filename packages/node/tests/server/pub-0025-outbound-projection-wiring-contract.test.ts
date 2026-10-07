import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildAnonymousCollectionDirectory,
  buildPublicationAuthorizedCollectionDirectory,
  buildPublicationAuthorizedCollectionDirectoryPublicProjection,
  buildPublicationDiscoveryOutput,
  createAnonymousCollectionDirectoryPage,
  createPublicationAuthorizedDirectoryPage,
  createPublicationDiscoveryPage,
  createPublicationSnapshotPageResponse,
  PublicationPublicProjectionError,
  selectAnonymousDirectoryCandidates,
  selectPublicationAuthorizedDirectoryCandidates,
  selectPublicationDiscoveryCandidates,
} from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:projection.public-safety]';
const publicNamespace = 'https://public.example/extensions/reading';
const privateNamespace = 'https://private.example/extensions/device-state';

const publicationFixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);

function publicationFixture(): Snapshot {
  return JSON.parse(readFileSync(publicationFixturePath, 'utf8')) as Snapshot;
}

function directoryCollection(
  id: string,
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    canonicalUrl: `https://catalog.example/collections/${id}`,
    title: `Public ${id}`,
    summary: `Summary for ${id}`,
    kind: 'knowledge_collection',
    nodeCount: 3,
    updatedAt: '2026-07-18T00:00:00.000Z',
    visibility: 'public',
    tags: ['design'],
    links: {
      self: `https://api.example/collections/${id}`,
      canonical: `https://catalog.example/collections/${id}`,
      snapshot: `https://cdn.example/snapshots/${id}.json`,
    },
    ...overrides,
  };
}

function buildDirectory(
  candidates: readonly unknown[],
  options?: { readonly publicExtensionNamespaces?: readonly string[] },
  nextCursor: string | null = null,
) {
  const selected = selectAnonymousDirectoryCandidates(candidates);
  const page = createAnonymousCollectionDirectoryPage(selected, {
    collections: selected.collections,
    nextCursor,
  });
  return {
    selected,
    page,
    directory: buildAnonymousCollectionDirectory(page, options ?? {}),
  };
}

function annotation(
  id: string,
  visibility: 'public' | 'unlisted' | 'protected' | 'private',
  value: string,
  collectionId: string,
  subjectId: string,
  type: 'note' | 'summary' | 'tldr' = 'note',
) {
  return {
    id,
    collectionId,
    subject: { type: 'node' as const, id: subjectId },
    type,
    format: 'plain' as const,
    value,
    visibility,
    creator: { id: 'https://alice.example/about', name: 'Alice' },
    createdAt: '2026-07-15T02:00:00Z',
    updatedAt: '2026-07-15T02:00:00Z',
    revision: `r-${id.slice(-4)}`,
    provenance: { kind: 'human' as const },
    extensions: {},
  };
}

function expectProjectionPolicyError(action: () => unknown): void {
  expect(action).toThrow(PublicationPublicProjectionError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicationPublicProjectionError);
    expect((error as PublicationPublicProjectionError).code).toBe('invalid_policy');
    expect(String(error)).toBe('PublicationPublicProjectionError: Publication public projection policy is invalid.');
  }
}

interface DiscoveryItem {
  readonly id: string;
  readonly visibility: 'public';
  readonly updatedAt: string;
  readonly url: string;
  readonly title?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly sourceRefs?: readonly Readonly<Record<string, unknown>>[];
  readonly notes?: readonly Readonly<Record<string, unknown>>[];
}

function discoveryItem(
  id: string,
  overrides: Record<PropertyKey, unknown> = {},
): Record<PropertyKey, unknown> {
  return {
    id,
    visibility: 'public',
    updatedAt: '2026-07-18T00:00:00.000Z',
    url: `https://catalog.example/items/${id}`,
    title: `Discovery ${id}`,
    ...overrides,
  };
}

function isDiscoveryItem(value: unknown): value is DiscoveryItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && candidate.visibility === 'public'
    && typeof candidate.updatedAt === 'string'
    && typeof candidate.url === 'string';
}

function sensitiveExtensions(): Record<string, unknown> {
  return {
    [publicNamespace]: {
      rating: 5,
      label: 'safe-public-ext',
      api_key: 'public-ns-api-key-secret',
      sourceRefs: [{
        system: 'browser',
        adapterVersion: '4.2.0',
        replicaId: 'replica-public',
        nativeId: 'native-secret-id',
        profileId: 'profile-secret-id',
        nativeParentId: 'native-parent-keep',
        capturedAt: '2026-07-18T00:00:00Z',
      }],
      notes: [
        { type: 'note', visibility: 'private', value: 'private-note-in-ext' },
        { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
      ],
    },
    [privateNamespace]: {
      api_key: 'private-ns-api-key-secret',
      deviceId: 'device-secret',
      nativeId: 'private-ns-native',
    },
  };
}

describe(`PUB-0025 outbound projection wiring ${evidence}`, () => {
  it(`strips secrets, native IDs, and private annotation-shaped values from the anonymous Directory select→page→build pipeline ${evidence}`, () => {
    const candidates = [
      directoryCollection('public-a', {
        title: 'Public Reading List',
        summary: 'A useful public collection.',
        extensions: {
          [publicNamespace]: {
            rating: 5,
            label: 'safe-public-ext',
            api_key: 'public-ns-api-key-secret',
            sourceRefs: [{
              system: 'browser',
              adapterVersion: '4.2.0',
              replicaId: 'replica-public',
              nativeId: 'native-secret-id',
              profileId: 'profile-secret-id',
              nativeParentId: 'native-parent-keep',
              capturedAt: '2026-07-18T00:00:00Z',
            }],
            notes: [
              { type: 'note', visibility: 'private', value: 'private-note-in-ext' },
              { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
            ],
          },
          [privateNamespace]: {
            api_key: 'private-ns-api-key-secret',
            deviceId: 'device-secret',
            nativeId: 'private-ns-native',
          },
        },
      }),
      directoryCollection('unlisted-a', { visibility: 'unlisted' }),
      directoryCollection('private-a', { visibility: 'private' }),
    ];

    const selected = selectAnonymousDirectoryCandidates(candidates);
    expect(selected.collections.map((item) => item.id)).toEqual(['public-a']);

    const page = createAnonymousCollectionDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    // Control: the pre-projection page still carries authoritative sensitive material.
    expect(page.collections[0]?.extensions?.[publicNamespace]).toEqual({
      rating: 5,
      label: 'safe-public-ext',
      api_key: 'public-ns-api-key-secret',
      sourceRefs: [{
        system: 'browser',
        adapterVersion: '4.2.0',
        replicaId: 'replica-public',
        nativeId: 'native-secret-id',
        profileId: 'profile-secret-id',
        nativeParentId: 'native-parent-keep',
        capturedAt: '2026-07-18T00:00:00Z',
      }],
      notes: [
        { type: 'note', visibility: 'private', value: 'private-note-in-ext' },
        { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
      ],
    });
    expect(page.collections[0]?.extensions?.[privateNamespace]).toEqual({
      api_key: 'private-ns-api-key-secret',
      deviceId: 'device-secret',
      nativeId: 'private-ns-native',
    });

    const directory = buildAnonymousCollectionDirectory(page, {
      publicExtensionNamespaces: [publicNamespace],
    });

    expect(directory).toEqual({
      protocolVersion: '0.1',
      collections: [{
        id: 'public-a',
        canonicalUrl: 'https://catalog.example/collections/public-a',
        title: 'Public Reading List',
        summary: 'A useful public collection.',
        kind: 'knowledge_collection',
        nodeCount: 3,
        updatedAt: '2026-07-18T00:00:00.000Z',
        visibility: 'public',
        tags: ['design'],
        links: {
          self: 'https://api.example/collections/public-a',
          canonical: 'https://catalog.example/collections/public-a',
          snapshot: 'https://cdn.example/snapshots/public-a.json',
        },
        extensions: {
          [publicNamespace]: {
            rating: 5,
            label: 'safe-public-ext',
            notes: [
              { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
            ],
          },
        },
      }],
      nextCursor: null,
    });

    const encoded = JSON.stringify(directory);
    expect(encoded).not.toContain('public-ns-api-key-secret');
    expect(encoded).not.toContain('private-ns-api-key-secret');
    expect(encoded).not.toContain('native-secret-id');
    expect(encoded).not.toContain('profile-secret-id');
    expect(encoded).not.toContain('private-note-in-ext');
    expect(encoded).not.toContain('device-secret');
    expect(encoded).not.toContain(privateNamespace);
    expect(directory.collections[0]?.title).toBe('Public Reading List');
    expect(directory.collections[0]?.summary).toBe('A useful public collection.');
    expect(directory.collections[0]?.extensions?.[publicNamespace]).toEqual({
      rating: 5,
      label: 'safe-public-ext',
      notes: [
        { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
      ],
    });
  });

  it(`defaults Directory publicExtensionNamespaces to [] and strips every extension fail-closed ${evidence}`, () => {
    const { page, directory } = buildDirectory([
      directoryCollection('public-a', {
        extensions: {
          [publicNamespace]: { rating: 5, api_key: 'default-ns-secret' },
          [privateNamespace]: { deviceId: 'device-secret' },
        },
      }),
    ]);

    expect(page.collections[0]?.extensions?.[publicNamespace]).toEqual({
      rating: 5,
      api_key: 'default-ns-secret',
    });
    expect(directory).toEqual({
      protocolVersion: '0.1',
      collections: [{
        id: 'public-a',
        canonicalUrl: 'https://catalog.example/collections/public-a',
        title: 'Public public-a',
        summary: 'Summary for public-a',
        kind: 'knowledge_collection',
        nodeCount: 3,
        updatedAt: '2026-07-18T00:00:00.000Z',
        visibility: 'public',
        tags: ['design'],
        links: {
          self: 'https://api.example/collections/public-a',
          canonical: 'https://catalog.example/collections/public-a',
          snapshot: 'https://cdn.example/snapshots/public-a.json',
        },
      }],
      nextCursor: null,
    });
    expect(directory.collections[0]).not.toHaveProperty('extensions');
    expect(JSON.stringify(directory)).not.toContain('default-ns-secret');
    expect(JSON.stringify(directory)).not.toContain('device-secret');
  });

  it(`projects publication Snapshot response bodies to remove private annotations, secrets, and native IDs while keeping public fields ${evidence}`, async () => {
    const snapshot = publicationFixture();
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark');
    if (bookmark === undefined) throw new TypeError('Fixture must include a bookmark node.');

    const publicAnnotation = snapshot.annotations[0]!;
    snapshot.annotations = [
      publicAnnotation,
      annotation(
        '019b3ca6-0f4e-7a28-a141-013e05048ff5',
        'private',
        'private-annotation-secret-body',
        snapshot.collection.id,
        bookmark.id,
      ),
      annotation(
        '019b3ca6-0f4e-7a28-a141-013e05048ff6',
        'protected',
        'protected-annotation-secret-body',
        snapshot.collection.id,
        bookmark.id,
      ),
      annotation(
        '019b3ca6-0f4e-7a28-a141-013e05048ff7',
        'unlisted',
        'unlisted-annotation-ok',
        snapshot.collection.id,
        bookmark.id,
        'tldr',
      ),
    ];
    snapshot.collection.extensions = {
      [publicNamespace]: {
        readingGoal: 12,
        api_key: 'snap-public-ns-api-key',
        sourceRefs: [{
          system: 'browser',
          adapterVersion: '4.2.0',
          replicaId: 'replica-public',
          nativeId: 'snap-native-secret',
          profileId: 'snap-profile-secret',
          capturedAt: '2026-07-18T00:00:00Z',
        }],
      },
      [privateNamespace]: {
        api_key: 'snap-private-ns-api-key',
        deviceId: 'device-secret',
      },
    };

    const response = createPublicationSnapshotPageResponse(snapshot, {
      method: 'GET',
      publicExtensionNamespaces: [publicNamespace],
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Snapshot;

    expect(body.protocolVersion).toBe('0.1');
    expect(body.mode).toBe('publication');
    expect(body.collection.title).toBe('Interface Systems');
    expect(body.collection.summary).toBe('A curated path into design engineering.');
    expect(body.collection.id).toBe(snapshot.collection.id);
    expect(body.nodes.map((node) => ({ id: node.id, kind: node.kind, title: node.title }))).toEqual([
      {
        id: '019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8',
        kind: 'root',
        title: 'Interface Systems',
      },
      {
        id: '019b3ca4-cb18-7a4f-b8c5-76fa50fd0ea2',
        kind: 'bookmark',
        title: 'Radix Primitives',
      },
    ]);

    expect(body.annotations.map((item) => ({
      id: item.id,
      visibility: item.visibility,
      value: item.value,
      type: item.type,
    }))).toEqual([
      {
        id: publicAnnotation.id,
        visibility: 'public',
        value: 'A low-level component primitive library.',
        type: 'summary',
      },
      {
        id: '019b3ca6-0f4e-7a28-a141-013e05048ff7',
        visibility: 'unlisted',
        value: 'unlisted-annotation-ok',
        type: 'tldr',
      },
    ]);

    expect(body.collection.extensions).toEqual({
      [publicNamespace]: {
        readingGoal: 12,
      },
    });

    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain('private-annotation-secret-body');
    expect(encoded).not.toContain('protected-annotation-secret-body');
    expect(encoded).not.toContain('snap-public-ns-api-key');
    expect(encoded).not.toContain('snap-private-ns-api-key');
    expect(encoded).not.toContain('snap-native-secret');
    expect(encoded).not.toContain('snap-profile-secret');
    expect(encoded).not.toContain('device-secret');
    expect(encoded).not.toContain(privateNamespace);
    expect(encoded).toContain('Interface Systems');
    expect(encoded).toContain('Radix Primitives');
    expect(encoded).toContain('unlisted-annotation-ok');
  });

  it(`defaults Snapshot publicExtensionNamespaces to [] and still removes non-public annotations ${evidence}`, async () => {
    const snapshot = publicationFixture();
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark');
    if (bookmark === undefined) throw new TypeError('Fixture must include a bookmark node.');

    snapshot.annotations = [
      snapshot.annotations[0]!,
      annotation(
        '019b3ca6-0f4e-7a28-a141-013e05048ff5',
        'private',
        'private-annotation-secret-body',
        snapshot.collection.id,
        bookmark.id,
      ),
    ];
    snapshot.collection.extensions = {
      [publicNamespace]: { readingGoal: 12, api_key: 'must-not-leak' },
      [privateNamespace]: { deviceId: 'device-secret' },
    };

    const response = createPublicationSnapshotPageResponse(snapshot, { method: 'GET' });
    const body = await response.json() as Snapshot;

    expect(body.annotations.map((item) => item.visibility)).toEqual(['public']);
    expect(body.annotations.map((item) => item.value)).toEqual([
      'A low-level component primitive library.',
    ]);
    expect(body.collection.extensions).toBeUndefined();
    expect(body.collection.title).toBe('Interface Systems');
    expect(JSON.stringify(body)).not.toContain('private-annotation-secret-body');
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('device-secret');
  });

  it(`fails closed when Directory projection policy is invalid ${evidence}`, () => {
    const { page } = buildDirectory([directoryCollection('public-a')]);

    expectProjectionPolicyError(() => buildAnonymousCollectionDirectory(page, {
      publicExtensionNamespaces: ['http://insecure.example/extensions/x'],
    }));
    expectProjectionPolicyError(() => buildAnonymousCollectionDirectory(page, {
      publicExtensionNamespaces: 'https://public.example/extensions/reading' as never,
    }));
    expectProjectionPolicyError(() => buildAnonymousCollectionDirectory(page, {
      publicExtensionNamespaces: [publicNamespace],
      // Unknown option keys are reject (fail-closed policy surface).
      extra: true,
    } as never));
  });

  it(`fails closed when Snapshot projection policy is invalid ${evidence}`, () => {
    const snapshot = publicationFixture();

    expectProjectionPolicyError(() => createPublicationSnapshotPageResponse(snapshot, {
      method: 'GET',
      publicExtensionNamespaces: ['not-a-url'],
    }));
    expectProjectionPolicyError(() => createPublicationSnapshotPageResponse(snapshot, {
      method: 'GET',
      publicExtensionNamespaces: ['http://insecure.example/extensions/x'],
    }));
    expectProjectionPolicyError(() => createPublicationSnapshotPageResponse(snapshot, {
      method: 'GET',
      publicExtensionNamespaces: [publicNamespace],
      publicProjectionLimits: { maxDepth: 0 },
    }));
  });

  it(`preserves ordinary public Directory and Snapshot fields after forced projection ${evidence}`, async () => {
    const { directory } = buildDirectory([
      directoryCollection('public-b', {
        title: 'Kept Directory Title',
        summary: 'Kept Directory Summary',
        tags: ['kept', 'public'],
        nodeCount: 42,
        extensions: {
          [publicNamespace]: { score: 9, note: 'kept extension note' },
        },
      }),
    ], { publicExtensionNamespaces: [publicNamespace] });

    expect(directory.collections[0]).toEqual({
      id: 'public-b',
      canonicalUrl: 'https://catalog.example/collections/public-b',
      title: 'Kept Directory Title',
      summary: 'Kept Directory Summary',
      kind: 'knowledge_collection',
      nodeCount: 42,
      updatedAt: '2026-07-18T00:00:00.000Z',
      visibility: 'public',
      tags: ['kept', 'public'],
      links: {
        self: 'https://api.example/collections/public-b',
        canonical: 'https://catalog.example/collections/public-b',
        snapshot: 'https://cdn.example/snapshots/public-b.json',
      },
      extensions: {
        [publicNamespace]: { score: 9, note: 'kept extension note' },
      },
    });

    const snapshot = publicationFixture();
    snapshot.collection.extensions = {
      [publicNamespace]: { readingGoal: 7, labels: ['kept'] },
    };
    const response = createPublicationSnapshotPageResponse(snapshot, {
      method: 'GET',
      publicExtensionNamespaces: [publicNamespace],
    });
    const body = await response.json() as Snapshot;

    expect(body.collection.title).toBe('Interface Systems');
    expect(body.collection.tags).toEqual(['design', 'engineering']);
    expect(body.collection.extensions).toEqual({
      [publicNamespace]: { readingGoal: 7, labels: ['kept'] },
    });
    expect(body.page).toEqual({ nextCursor: null, hasMore: false, sequence: 1 });
    expect(body.revision).toBe('r_1042');
  });

  it(`forces public projection on anonymous discovery select→page→build wire ${evidence}`, () => {
    const selected = selectPublicationDiscoveryCandidates('search', [
      discoveryItem('public-a', {
        extensions: sensitiveExtensions(),
        sourceRefs: [{
          system: 'browser',
          nativeId: 'top-level-native-secret',
          profileId: 'top-level-profile-secret',
          nativeParentId: 'native-parent-keep',
        }],
        notes: [
          { type: 'note', visibility: 'private', value: 'private-discovery-note' },
          { type: 'note', visibility: 'public', value: 'public-discovery-note' },
        ],
      }),
      discoveryItem('unlisted-a', { visibility: 'unlisted' }),
      discoveryItem('private-a', { visibility: 'private' }),
    ], isDiscoveryItem);

    expect(selected.items.map((item) => item.id)).toEqual(['public-a']);

    const page = createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: 'cursor-1',
    });
    // Control: pre-projection page still carries authoritative sensitive material.
    expect(page.items[0]?.extensions?.[publicNamespace]).toMatchObject({
      api_key: 'public-ns-api-key-secret',
    });
    expect(page.items[0]?.extensions?.[privateNamespace]).toMatchObject({
      deviceId: 'device-secret',
    });

    const output = buildPublicationDiscoveryOutput(page, {
      publicExtensionNamespaces: [publicNamespace],
    });

    expect(output.channel).toBe('search');
    expect(output.nextCursor).toBe('cursor-1');
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toEqual({
      id: 'public-a',
      visibility: 'public',
      updatedAt: '2026-07-18T00:00:00.000Z',
      url: 'https://catalog.example/items/public-a',
      title: 'Discovery public-a',
      extensions: {
        [publicNamespace]: {
          rating: 5,
          label: 'safe-public-ext',
          notes: [
            { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
          ],
        },
      },
      notes: [
        { type: 'note', visibility: 'public', value: 'public-discovery-note' },
      ],
    });

    const encoded = JSON.stringify(output);
    expect(encoded).not.toContain('public-ns-api-key-secret');
    expect(encoded).not.toContain('private-ns-api-key-secret');
    expect(encoded).not.toContain('native-secret-id');
    expect(encoded).not.toContain('profile-secret-id');
    expect(encoded).not.toContain('top-level-native-secret');
    expect(encoded).not.toContain('top-level-profile-secret');
    expect(encoded).not.toContain('private-note-in-ext');
    expect(encoded).not.toContain('private-discovery-note');
    expect(encoded).not.toContain('device-secret');
    expect(encoded).not.toContain(privateNamespace);
    expect(encoded).toContain('public-discovery-note');
    expect(encoded).toContain('Discovery public-a');
  });

  it(`defaults discovery publicExtensionNamespaces to [] fail-closed and rejects invalid policy ${evidence}`, () => {
    const selected = selectPublicationDiscoveryCandidates('mcp-list', [
      discoveryItem('public-a', {
        extensions: {
          [publicNamespace]: { rating: 5, api_key: 'discovery-default-secret' },
          [privateNamespace]: { deviceId: 'device-secret' },
        },
      }),
    ], isDiscoveryItem);
    const page = createPublicationDiscoveryPage(selected, {
      items: selected.items,
      nextCursor: null,
    });

    const output = buildPublicationDiscoveryOutput(page);
    expect(output.items[0]).toEqual({
      id: 'public-a',
      visibility: 'public',
      updatedAt: '2026-07-18T00:00:00.000Z',
      url: 'https://catalog.example/items/public-a',
      title: 'Discovery public-a',
    });
    expect(output.items[0]).not.toHaveProperty('extensions');
    expect(JSON.stringify(output)).not.toContain('discovery-default-secret');
    expect(JSON.stringify(output)).not.toContain('device-secret');

    expectProjectionPolicyError(() => buildPublicationDiscoveryOutput(page, {
      publicExtensionNamespaces: ['http://insecure.example/extensions/x'],
    }));
    expectProjectionPolicyError(() => buildPublicationDiscoveryOutput(page, {
      publicExtensionNamespaces: [publicNamespace],
      extra: true,
    } as never));
  });

  it(`does not force public projection on the default authorized Directory path ${evidence}`, () => {
    const selected = selectPublicationAuthorizedDirectoryCandidates([
      directoryCollection('public-a', {
        extensions: sensitiveExtensions(),
      }),
      directoryCollection('protected-a', {
        visibility: 'protected',
        extensions: {
          [publicNamespace]: {
            principalId: 'principal-internal-id',
            api_key: 'protected-api-key-secret',
            label: 'principal-visible-label',
          },
        },
      }),
    ], (candidate) => candidate.id === 'protected-a');

    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const directory = buildPublicationAuthorizedCollectionDirectory(page);

    expect(directory.collections.map((item) => item.id)).toEqual(['public-a', 'protected-a']);
    // Default authorized wire retains principal-visible fields that public
    // projection would strip; adapters must opt into the public-projection path.
    expect(directory.collections[0]?.extensions).toEqual(sensitiveExtensions());
    expect(directory.collections[1]?.extensions?.[publicNamespace]).toEqual({
      principalId: 'principal-internal-id',
      api_key: 'protected-api-key-secret',
      label: 'principal-visible-label',
    });
    expect(JSON.stringify(directory)).toContain('protected-api-key-secret');
    expect(JSON.stringify(directory)).toContain('principal-internal-id');
    expect(JSON.stringify(directory)).toContain('public-ns-api-key-secret');
  });

  it(`applies public projection only when authorized Directory opt-in builders are used ${evidence}`, () => {
    const selected = selectPublicationAuthorizedDirectoryCandidates([
      directoryCollection('public-a', {
        extensions: sensitiveExtensions(),
      }),
      directoryCollection('protected-a', {
        visibility: 'protected',
        extensions: {
          [publicNamespace]: {
            principalId: 'principal-internal-id',
            api_key: 'protected-api-key-secret',
            label: 'principal-visible-label',
          },
        },
      }),
    ], (candidate) => candidate.id === 'protected-a');

    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const projected = buildPublicationAuthorizedCollectionDirectoryPublicProjection(page, {
      publicExtensionNamespaces: [publicNamespace],
    });

    expect(projected.collections.map((item) => item.id)).toEqual(['public-a', 'protected-a']);
    expect(projected.collections[0]?.extensions).toEqual({
      [publicNamespace]: {
        rating: 5,
        label: 'safe-public-ext',
        notes: [
          { type: 'note', visibility: 'public', value: 'public-note-in-ext' },
        ],
      },
    });
    expect(projected.collections[1]?.extensions?.[publicNamespace]).toEqual({
      label: 'principal-visible-label',
    });

    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain('public-ns-api-key-secret');
    expect(encoded).not.toContain('protected-api-key-secret');
    expect(encoded).not.toContain('principal-internal-id');
    expect(encoded).not.toContain('native-secret-id');
    expect(encoded).not.toContain('private-note-in-ext');
    expect(encoded).not.toContain(privateNamespace);
    expect(encoded).toContain('principal-visible-label');
    expect(encoded).toContain('safe-public-ext');
  });
});
