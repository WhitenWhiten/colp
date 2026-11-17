/**
 * A4-2: projecting a Digest series must resolve its series/access facts once per
 * projection and each distinct source collection tree once, no matter how many
 * editions share it. The series read also feeds edition links and policy facts.
 */
import { describe, expect, test } from 'vitest';
import type { CompiledQuery } from 'kysely';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';
import {
  createBookmarkSubscriptionSources,
  type DigestSeriesReportReads,
} from '../../../src/infrastructure/bookmark-subscriptions/sources.js';
import type {
  ActorCollectionMetadata,
  ActorCollectionNode,
  ActorCollectionReadPort,
} from '../../../src/modules/collections/index.js';

const ACTOR = { accountId: 'account', subjectId: 'subject' };
const SERIES_ID = 'series-1';
const COLLECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://example.test';

function metadata(id: string): ActorCollectionMetadata {
  return {
    c: {
      id, title: 'Shared collection', summary: null, ownerSubjectId: 'owner-subject',
      visibility: 'private', rootNodeId: 'root', contentRevision: 'collection-content-1',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    member: true, followed: true, shared: false, role: 'viewer',
    openUrl: `${ORIGIN}/collections/${id}`, policyRevision: 'collection-policy-1',
  };
}

const rows: ActorCollectionNode[] = [
  {
    id: 'root', parentId: null, kind: 'folder', title: 'Root', url: null, description: null,
    resourceRevision: 'root-rev', visibility: 'inherit',
  },
  {
    id: 'bookmark-1', parentId: 'root', kind: 'bookmark', title: 'Bookmark', url: 'https://example.test/a',
    description: null, resourceRevision: 'bookmark-rev', visibility: 'inherit',
  },
];

const editions = [
  {
    id: 'edition-1', sourceCollectionId: COLLECTION_ID, publishedAt: '2026-01-01T00:00:00.000Z',
    editionOrdinal: 1, titleSnapshot: 'Issue one', summarySnapshot: null, resourceRevision: 'edition-rev-1',
  },
  {
    id: 'edition-2', sourceCollectionId: COLLECTION_ID, publishedAt: '2026-02-01T00:00:00.000Z',
    editionOrdinal: 2, titleSnapshot: 'Issue two', summarySnapshot: null, resourceRevision: 'edition-rev-2',
  },
];

describe('digest series projection source reads', () => {
  test('two editions sharing one source collection read the series once and the tree once', async () => {
    const seriesReads: string[] = [];
    const nodeReads: string[] = [];
    const digestReports: DigestSeriesReportReads = {
      series: async (_actor, id) => {
        seriesReads.push(id);
        return {
          s: {
            id, title: 'Series', ownerSubjectId: 'owner-subject', visibility: 'private',
            slug: 'series-slug', updatedAt: '2026-01-03T00:00:00.000Z', summary: null,
            policyRevision: 'series-policy-1', contentRevision: 'series-content-1',
          },
          member: true, memberRole: 'viewer', hidden: false, followed: true,
        };
      },
      publishedEdition: async (_actor, _seriesId, id) => editions.find(edition => edition.id === id) ?? null,
      publishedCandidates: async () => editions,
      hiddenPublishedEditionIds: async () => new Set<string>(),
    };
    const collections: ActorCollectionReadPort = {
      metadata: async (_actor, id) => metadata(id),
      metadataMany: async (_actor, ids) => new Map(ids.map(id => [id, metadata(id)])),
      nodes: async (_actor, id) => {
        nodeReads.push(id);
        return { meta: metadata(id), rows };
      },
      annotations: async () => [],
    };
    const executeQuery = async (_query: CompiledQuery) => ({ rows: [] });
    const tx = { executeQuery } as unknown as DatabaseTransaction;
    const sources = createBookmarkSubscriptionSources(
      tx, { origin: ORIGIN, reportsEnabled: true }, collections, digestReports,
    );

    const projection = await sources.project(
      ACTOR, { sourceType: 'digest_series', sourceId: SERIES_ID }, 'recent', editions.length,
    );

    expect(projection).not.toBeNull();
    expect(seriesReads).toEqual([SERIES_ID]);
    expect(nodeReads).toEqual([COLLECTION_ID]);
    expect(projection!.editions).toEqual([
      { editionId: 'edition-1', title: 'Issue one', publishedAt: '2026-01-01T00:00:00.000Z' },
      { editionId: 'edition-2', title: 'Issue two', publishedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    // Reusing one tree keeps per-edition folders, links, order and node keys.
    expect(projection!.nodes.map(node => node.role)).toEqual([
      'root', 'source_link',
      'edition_folder', 'edition_link', 'content',
      'edition_folder', 'edition_link', 'content',
    ]);
    expect(projection!.nodes.filter(node => node.role === 'edition_folder')
      .map(node => [node.editionId, node.title]))
      .toEqual([['edition-1', 'Issue one'], ['edition-2', 'Issue two']]);
    expect(projection!.nodes.filter(node => node.role === 'edition_link').map(node => node.url)).toEqual([
      `${ORIGIN}/library/digests/${SERIES_ID}/issues/edition-1/read`,
      `${ORIGIN}/library/digests/${SERIES_ID}/issues/edition-2/read`,
    ]);
    expect(projection!.nodes.filter(node => node.role === 'content').map(node => node.editionId))
      .toEqual(['edition-1', 'edition-2']);
    expect(new Set(projection!.nodes.map(node => node.key)).size).toBe(projection!.nodes.length);
  });
});
