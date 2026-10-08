import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  graphCcPlanner,
  planGraphCc,
} from '../../../src/modules/collections/application/organize-planner-graph-cc.js';
import type {
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
  OrganizePlannerInput,
} from '../../../src/modules/collections/application/organize-planner.js';
import {
  bookmarkTokenSet,
  folderTokenSet,
  jaccard,
  suggestFolderTitle,
} from '../../../src/modules/collections/application/organize-planner-tokens.js';

const APPLICATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/modules/collections/application',
);
const GRAPH_CC_SOURCE = readFileSync(join(APPLICATION_DIR, 'organize-planner-graph-cc.ts'), 'utf8');

const ROOT = 'root';
const UNSORTED = 'unsorted';
const READING_LATER = 'reading-later';

const OVERLAP_BOOKMARKS: OrganizePlannerBookmark[] = [
  { id: 'b1', parentId: UNSORTED, title: 'React query handbook', url: 'https://react.dev/handbook' },
  { id: 'b2', parentId: UNSORTED, title: 'React query docs', url: 'https://react.dev/docs' },
  { id: 'b3', parentId: UNSORTED, title: 'React query guide', url: 'https://react.dev/guide' },
];

const UNRELATED_BOOKMARKS: OrganizePlannerBookmark[] = [
  { id: 'u1', parentId: UNSORTED, title: 'Alpha recipes', url: 'https://alpha.test/1' },
  { id: 'u2', parentId: UNSORTED, title: 'Bravo music', url: 'https://bravo.dev/1' },
  { id: 'u3', parentId: UNSORTED, title: 'Charlie photos', url: 'https://charlie.io/1' },
];

function meanPairwise(bookmarks: readonly Pick<OrganizePlannerBookmark, 'title' | 'url'>[]): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < bookmarks.length; i += 1) {
    for (let j = i + 1; j < bookmarks.length; j += 1) {
      sum += jaccard(bookmarkTokenSet(bookmarks[i]!), bookmarkTokenSet(bookmarks[j]!));
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : Math.round(sum / pairs);
}

function meanVsFolder(
  bookmarks: readonly Pick<OrganizePlannerBookmark, 'title' | 'url'>[],
  folderTitle: string,
): number {
  const folder = folderTokenSet(folderTitle);
  const sum = bookmarks.reduce((acc, bookmark) => acc + jaccard(bookmarkTokenSet(bookmark), folder), 0);
  return Math.round(sum / bookmarks.length);
}

function unionTokens(bookmarks: readonly Pick<OrganizePlannerBookmark, 'title' | 'url'>[]): Set<string> {
  const tokens = new Set<string>();
  for (const bookmark of bookmarks) {
    for (const token of bookmarkTokenSet(bookmark)) tokens.add(token);
  }
  return tokens;
}

function baseInput(overrides: Partial<OrganizePlannerInput> = {}): OrganizePlannerInput {
  return {
    rootId: ROOT,
    folders: [{ id: UNSORTED, parentId: ROOT, title: 'Unsorted' }],
    bookmarks: [],
    inboxFolderIds: [UNSORTED],
    ...overrides,
  };
}

describe('heuristic.v1.graph_cc connected components', () => {
  test('3 bookmarks with high title overlap form one connected component and one action', () => {
    for (let i = 0; i < OVERLAP_BOOKMARKS.length; i += 1) {
      for (let j = i + 1; j < OVERLAP_BOOKMARKS.length; j += 1) {
        assert.ok(
          jaccard(bookmarkTokenSet(OVERLAP_BOOKMARKS[i]!), bookmarkTokenSet(OVERLAP_BOOKMARKS[j]!)) >= 50,
        );
      }
    }

    const output = planGraphCc(baseInput({ bookmarks: OVERLAP_BOOKMARKS }));
    assert.equal(output.plannerId, 'heuristic.v1.graph_cc');
    assert.equal(output.truncated, false);
    assert.equal(output.actions.length, 1);
    const action = output.actions[0]!;
    assert.deepEqual([...action.nodeIds], ['b1', 'b2', 'b3']);
    assert.equal(action.count, 3);
    assert.equal(action.sourceFolderId, UNSORTED);
    assert.equal(action.sourceFolderTitle, 'Unsorted');
    assert.deepEqual(action.target, {
      type: 'create_folder',
      parentId: ROOT,
      title: suggestFolderTitle(unionTokens(OVERLAP_BOOKMARKS), OVERLAP_BOOKMARKS),
    });
    assert.equal(action.reason, 'Shared title/host tokens (3 bookmarks).');
    assert.equal(action.confidence, meanPairwise(OVERLAP_BOOKMARKS));
    assert.ok(action.confidence >= 40);
    assert.match(action.id, /^[A-Za-z0-9._~-]{1,128}$/u);
  });

  test('3 unrelated bookmarks have no edges and empty actions', () => {
    for (let i = 0; i < UNRELATED_BOOKMARKS.length; i += 1) {
      for (let j = i + 1; j < UNRELATED_BOOKMARKS.length; j += 1) {
        assert.equal(
          jaccard(bookmarkTokenSet(UNRELATED_BOOKMARKS[i]!), bookmarkTokenSet(UNRELATED_BOOKMARKS[j]!)),
          0,
        );
      }
    }

    const output = planGraphCc(baseInput({ bookmarks: UNRELATED_BOOKMARKS }));
    assert.equal(output.plannerId, 'heuristic.v1.graph_cc');
    assert.equal(output.truncated, false);
    assert.deepEqual(output.actions, []);
  });

  test('graph edges use H0 jaccard cutoff of 50 (not the folder-assign 40)', () => {
    const atCutoff: OrganizePlannerBookmark[] = [
      { id: 'w1', parentId: UNSORTED, title: 'Widget', url: 'https://shared.example/a' },
      { id: 'w2', parentId: UNSORTED, title: 'Gadget', url: 'https://shared.example/b' },
    ];
    const belowCutoff: OrganizePlannerBookmark[] = [
      { id: 'x1', parentId: UNSORTED, title: 'Widget Extra', url: 'https://shared.example/a' },
      { id: 'x2', parentId: UNSORTED, title: 'Gadget', url: 'https://shared.example/b' },
    ];

    assert.equal(jaccard(bookmarkTokenSet(atCutoff[0]!), bookmarkTokenSet(atCutoff[1]!)), 50);
    assert.equal(jaccard(bookmarkTokenSet(belowCutoff[0]!), bookmarkTokenSet(belowCutoff[1]!)), 40);

    const connected = planGraphCc(baseInput({ bookmarks: atCutoff }));
    assert.equal(connected.actions.length, 1);
    assert.deepEqual([...connected.actions[0]!.nodeIds], ['w1', 'w2']);
    assert.equal(connected.actions[0]!.count, 2);

    const disconnected = planGraphCc(baseInput({ bookmarks: belowCutoff }));
    assert.deepEqual(disconnected.actions, []);
  });

  test('root bookmarks are not source nodes even when titles overlap the cluster', () => {
    const rootTwin: OrganizePlannerBookmark = {
      id: 'root-b',
      parentId: ROOT,
      title: 'React query handbook',
      url: 'https://react.dev/root',
    };
    const output = planGraphCc(
      baseInput({
        bookmarks: [rootTwin, ...OVERLAP_BOOKMARKS],
        inboxFolderIds: [UNSORTED, ROOT],
      }),
    );
    assert.equal(output.actions.length, 1);
    assert.deepEqual([...output.actions[0]!.nodeIds], ['b1', 'b2', 'b3']);
    assert.ok(!output.actions[0]!.nodeIds.includes('root-b'));
  });
});

describe('heuristic.v1.graph_cc targets and splits', () => {
  test('assigns an existing non-inbox folder when mean Jaccard is at least 40', () => {
    const folders: OrganizePlannerFolder[] = [
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: 'react-query', parentId: ROOT, title: 'React Query' },
    ];
    const output = planGraphCc(baseInput({ folders, bookmarks: OVERLAP_BOOKMARKS }));
    assert.equal(output.actions.length, 1);
    const action = output.actions[0]!;
    assert.deepEqual(action.target, {
      type: 'existing',
      folderId: 'react-query',
      title: 'React Query',
    });
    assert.equal(action.reason, 'Title/host overlap with "React Query".');
    assert.equal(action.confidence, meanVsFolder(OVERLAP_BOOKMARKS, 'React Query'));
    assert.ok(action.confidence >= 40);
  });

  test('switches create_folder to existing when the suggested title collides under root', () => {
    const longTitle = 'Alpha beta gamma delta epsilon zeta eta';
    const members: OrganizePlannerBookmark[] = [
      { id: 'c1', parentId: UNSORTED, title: longTitle, url: 'https://cluster.example/a' },
      { id: 'c2', parentId: UNSORTED, title: longTitle, url: 'https://cluster.example/b' },
      { id: 'c3', parentId: UNSORTED, title: longTitle, url: 'https://cluster.example/c' },
    ];
    const suggested = suggestFolderTitle(unionTokens(members), members);
    assert.equal(jaccard(bookmarkTokenSet(members[0]!), folderTokenSet(suggested)) < 40, true);

    const created = planGraphCc(baseInput({ bookmarks: members }));
    assert.deepEqual(created.actions[0]!.target, {
      type: 'create_folder',
      parentId: ROOT,
      title: suggested,
    });

    const folders: OrganizePlannerFolder[] = [
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: 'colliding', parentId: ROOT, title: 'ALPHA  BETA   GAMMA' },
    ];
    const switched = planGraphCc(baseInput({ folders, bookmarks: members }));
    assert.deepEqual(switched.actions[0]!.target, {
      type: 'existing',
      folderId: 'colliding',
      title: 'ALPHA  BETA   GAMMA',
    });
    assert.equal(switched.actions[0]!.reason, 'Title/host overlap with "ALPHA  BETA   GAMMA".');
    assert.equal(switched.actions[0]!.confidence, meanPairwise(members));
  });

  test('does not target inbox-titled folders or the source inbox folder', () => {
    const folders: OrganizePlannerFolder[] = [
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: READING_LATER, parentId: ROOT, title: 'Reading later' },
    ];
    const output = planGraphCc(
      baseInput({
        folders,
        bookmarks: OVERLAP_BOOKMARKS,
        inboxFolderIds: [UNSORTED, READING_LATER],
      }),
    );
    assert.equal(output.actions[0]!.target.type, 'create_folder');
  });

  test('splits a mixed-inbox component into per-source-folder actions', () => {
    const folders: OrganizePlannerFolder[] = [
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: READING_LATER, parentId: ROOT, title: 'Reading later' },
    ];
    const bookmarks: OrganizePlannerBookmark[] = [
      { id: 'b1', parentId: UNSORTED, title: 'React query handbook', url: 'https://react.dev/handbook' },
      { id: 'b2', parentId: UNSORTED, title: 'React query docs', url: 'https://react.dev/docs' },
      { id: 'b3', parentId: READING_LATER, title: 'React query guide', url: 'https://react.dev/guide' },
      { id: 'b4', parentId: READING_LATER, title: 'React query notes', url: 'https://react.dev/notes' },
    ];
    const output = planGraphCc(baseInput({ folders, bookmarks, inboxFolderIds: [UNSORTED, READING_LATER] }));
    assert.equal(output.actions.length, 2);
    assert.deepEqual(
      output.actions.map((action) => ({
        source: action.sourceFolderId,
        nodes: [...action.nodeIds],
      })),
      [
        { source: UNSORTED, nodes: ['b1', 'b2'] },
        { source: READING_LATER, nodes: ['b3', 'b4'] },
      ],
    );
  });

  test('drops a mixed-inbox split that would leave fewer than 2 nodes', () => {
    const folders: OrganizePlannerFolder[] = [
      { id: UNSORTED, parentId: ROOT, title: 'Unsorted' },
      { id: READING_LATER, parentId: ROOT, title: 'Reading later' },
    ];
    const bookmarks: OrganizePlannerBookmark[] = [
      ...OVERLAP_BOOKMARKS.slice(0, 2),
      { id: 'b3', parentId: READING_LATER, title: 'React query guide', url: 'https://react.dev/guide' },
    ];
    const output = planGraphCc(baseInput({ folders, bookmarks, inboxFolderIds: [UNSORTED, READING_LATER] }));
    assert.equal(output.actions.length, 1);
    assert.deepEqual([...output.actions[0]!.nodeIds], ['b1', 'b2']);
    assert.equal(output.actions[0]!.sourceFolderId, UNSORTED);
  });
});

describe('heuristic.v1.graph_cc caps, stability, and isolation', () => {
  test('caps at 20 actions and 50 nodes and sets truncated', () => {
    const pairBookmarks: OrganizePlannerBookmark[] = [];
    for (let index = 0; index < 21; index += 1) {
      const tag = String(index).padStart(2, '0');
      pairBookmarks.push(
        { id: `p${tag}a`, parentId: UNSORTED, title: `Topic${tag} notes`, url: `https://host${tag}.site${tag}/a` },
        { id: `p${tag}b`, parentId: UNSORTED, title: `Topic${tag} guide`, url: `https://host${tag}.site${tag}/b` },
      );
    }
    const cappedActions = planGraphCc(baseInput({ bookmarks: pairBookmarks }));
    assert.equal(cappedActions.truncated, true);
    assert.equal(cappedActions.actions.length, 20);
    assert.deepEqual([...cappedActions.actions[0]!.nodeIds], ['p00a', 'p00b']);
    assert.ok(cappedActions.actions.every((action) => !action.nodeIds.includes('p20a')));

    const oversized: OrganizePlannerBookmark[] = [];
    for (let index = 0; index < 51; index += 1) {
      const tag = String(index).padStart(2, '0');
      oversized.push({
        id: `n${tag}`,
        parentId: UNSORTED,
        title: 'React query handbook',
        url: `https://react.dev/${tag}`,
      });
    }
    const cappedNodes = planGraphCc(baseInput({ bookmarks: oversized }));
    assert.equal(cappedNodes.truncated, true);
    assert.equal(cappedNodes.actions.length, 1);
    assert.equal(cappedNodes.actions[0]!.count, 50);
    assert.equal(cappedNodes.actions[0]!.nodeIds.length, 50);
    assert.equal(cappedNodes.actions[0]!.nodeIds[0], 'n00');
    assert.equal(cappedNodes.actions[0]!.nodeIds[49], 'n49');
    assert.ok(!cappedNodes.actions[0]!.nodeIds.includes('n50'));
  });

  test('action ids are stable, unique, and free of Math.random', () => {
    const first = planGraphCc(baseInput({ bookmarks: OVERLAP_BOOKMARKS }));
    const second = planGraphCc(baseInput({ bookmarks: OVERLAP_BOOKMARKS }));
    assert.deepEqual(first, second);
    const ids = first.actions.map((action) => action.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.doesNotMatch(GRAPH_CC_SOURCE, /Math\.random/);
    assert.doesNotMatch(GRAPH_CC_SOURCE, /createOrganizePlanner/);
    assert.doesNotMatch(GRAPH_CC_SOURCE, /organize-planner-assign-existing/);
    assert.match(GRAPH_CC_SOURCE, /from '\.\/organize-planner-tokens\.js'/u);
  });
});

describe('graphCcPlanner', () => {
  test('exposes heuristic.v1.graph_cc and plan() returns the pure output', async () => {
    assert.equal(graphCcPlanner.id, 'heuristic.v1.graph_cc');
    const input = baseInput({ bookmarks: OVERLAP_BOOKMARKS });
    const pending = graphCcPlanner.plan(input);
    assert.equal(pending instanceof Promise, true);
    assert.deepEqual(await pending, planGraphCc(input));
  });
});
