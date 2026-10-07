import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import type {
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
  OrganizePlannerInput,
} from '../../../src/modules/collections/application/organize-planner.js';
import {
  assignExistingGroups,
  assignExistingPlanner,
  assignedNodeIdSet,
  planAssignExisting,
} from '../../../src/modules/collections/application/organize-planner-assign-existing.js';
import {
  bookmarkTokenSet,
  folderTokenSet,
  jaccard,
} from '../../../src/modules/collections/application/organize-planner-tokens.js';

const APPLICATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/modules/collections/application',
);
const SOURCE_PATH = join(APPLICATION_DIR, 'organize-planner-assign-existing.ts');

const ROOT_ID = 'root';
const UNSORTED_ID = 'folder-unsorted';
const READING_LATER_ID = 'folder-reading-later';
const GITHUB_FOLDER_ID = 'folder-github';
const PLANNER_ID = 'heuristic.v1.assign_existing';

function folder(id: string, title: string, parentId = ROOT_ID): OrganizePlannerFolder {
  return { id, parentId, title };
}

function bookmark(
  id: string,
  parentId: string,
  title: string,
  url: string,
): OrganizePlannerBookmark {
  return { id, parentId, title, url };
}

function input(overrides: Partial<OrganizePlannerInput> = {}): OrganizePlannerInput {
  return {
    rootId: ROOT_ID,
    folders: [],
    bookmarks: [],
    inboxFolderIds: [],
    ...overrides,
  };
}

function githubScene(extra: Partial<OrganizePlannerInput> = {}): OrganizePlannerInput {
  return input({
    folders: [
      folder(UNSORTED_ID, 'Unsorted'),
      folder(GITHUB_FOLDER_ID, 'GitHub'),
    ],
    bookmarks: [
      bookmark('bm-c', UNSORTED_ID, 'GitHub', 'https://github.com/org/three'),
      bookmark('bm-a', UNSORTED_ID, 'GitHub', 'https://github.com/org/one'),
      bookmark('bm-b', UNSORTED_ID, 'GitHub', 'https://github.com/org/two'),
      bookmark('bm-root', ROOT_ID, 'GitHub', 'https://github.com/root/should-not-appear'),
    ],
    inboxFolderIds: [UNSORTED_ID],
    ...extra,
  });
}

function overlap(title: string, url: string, folderTitle: string): number {
  return jaccard(bookmarkTokenSet({ title, url }), folderTokenSet(folderTitle));
}

describe('heuristic.v1.assign_existing — required bake-off scene', () => {
  test('3 github.com bookmarks in Unsorted assign to existing GitHub; root bookmark is absent', () => {
    const output = planAssignExisting(githubScene());
    assert.equal(output.plannerId, PLANNER_ID);
    assert.equal(output.truncated, false);
    assert.equal(output.actions.length, 1);
    const action = output.actions[0]!;
    assert.equal(action.target.type, 'existing');
    if (action.target.type !== 'existing') return;
    assert.equal(action.target.folderId, GITHUB_FOLDER_ID);
    assert.equal(action.target.title, 'GitHub');
    assert.deepEqual(action.nodeIds, ['bm-a', 'bm-b', 'bm-c']);
    assert.equal(action.nodeIds.length, 3);
    assert.equal(action.count, 3);
    assert.equal(action.sourceFolderId, UNSORTED_ID);
    assert.equal(action.sourceFolderTitle, 'Unsorted');
    assert.equal(action.reason, 'Title/host overlap with "GitHub".');
    assert.equal(action.confidence, overlap('GitHub', 'https://github.com/org/one', 'GitHub'));
    assert.ok(action.confidence >= 40);
    assert.equal(action.id, `assign:${UNSORTED_ID}:${GITHUB_FOLDER_ID}`);
    assert.ok(!action.nodeIds.includes('bm-root'));
    for (const listed of output.actions.flatMap((item) => item.nodeIds)) {
      assert.notEqual(listed, 'bm-root');
    }
  });
});

describe('source and candidate filters', () => {
  test('inbox-titled folders are never targets even when Jaccard would qualify', () => {
    const inboxTargetId = 'folder-inbox-decoy';
    const output = planAssignExisting(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder(inboxTargetId, 'Inbox'),
          folder('folder-reading', 'Reading later'),
        ],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'Inbox', 'https://inbox.example/a'),
          bookmark('bm-2', UNSORTED_ID, 'Inbox', 'https://inbox.example/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.ok(overlap('Inbox', 'https://inbox.example/a', 'Inbox') >= 40);
    assert.deepEqual(output.actions, []);
  });

  test('folders listed in inboxFolderIds are not targets even with a non-inbox title', () => {
    const otherInboxId = 'folder-projects-as-inbox';
    const output = planAssignExisting(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder(otherInboxId, 'GitHub'),
        ],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'GitHub', 'https://github.com/a/1'),
          bookmark('bm-2', UNSORTED_ID, 'GitHub', 'https://github.com/a/2'),
        ],
        inboxFolderIds: [UNSORTED_ID, otherInboxId],
      }),
    );
    assert.deepEqual(output.actions, []);
  });

  test('ignores bookmarks whose parentId is root even if rootId is in inboxFolderIds', () => {
    const output = planAssignExisting(
      githubScene({ inboxFolderIds: [UNSORTED_ID, ROOT_ID] }),
    );
    assert.equal(output.actions.length, 1);
    assert.ok(!output.actions[0]!.nodeIds.includes('bm-root'));
  });
});

describe('grouping and confidence', () => {
  test('singleton cluster is dropped and the bookmark stays unassigned', () => {
    const scene = input({
      folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
      bookmarks: [bookmark('bm-only', UNSORTED_ID, 'GitHub', 'https://github.com/org/only')],
      inboxFolderIds: [UNSORTED_ID],
    });
    assert.deepEqual(planAssignExisting(scene).actions, []);
    assert.equal(assignedNodeIdSet(assignExistingGroups(scene)).size, 0);
  });

  test('confidence below 40 is dropped even when two weak bookmarks share a folder', () => {
    const weakTitle = 'GitHub foo bar';
    const weakUrl = 'https://github.com/org/weak';
    const weakScore = overlap(weakTitle, weakUrl, 'GitHub');
    assert.ok(weakScore < 40);
    const output = planAssignExisting(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
        bookmarks: [
          bookmark('bm-weak-1', UNSORTED_ID, weakTitle, weakUrl),
          bookmark('bm-weak-2', UNSORTED_ID, weakTitle, `${weakUrl}-2`),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.deepEqual(output.actions, []);
  });

  test('a weak member cannot ride along with a strong pair; group confidence is the minimum Jaccard', () => {
    const weakTitle = 'GitHub foo bar';
    const scene = input({
      folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
      bookmarks: [
        bookmark('bm-strong-a', UNSORTED_ID, 'GitHub', 'https://github.com/org/a'),
        bookmark('bm-strong-b', UNSORTED_ID, 'GitHub', 'https://github.com/org/b'),
        bookmark('bm-weak', UNSORTED_ID, weakTitle, 'https://github.com/org/weak'),
      ],
      inboxFolderIds: [UNSORTED_ID],
    });
    const output = planAssignExisting(scene);
    assert.equal(output.actions.length, 1);
    assert.deepEqual(output.actions[0]!.nodeIds, ['bm-strong-a', 'bm-strong-b']);
    assert.ok(!output.actions[0]!.nodeIds.includes('bm-weak'));
    const strong = overlap('GitHub', 'https://github.com/org/a', 'GitHub');
    assert.equal(output.actions[0]!.confidence, strong);
    assert.ok(output.actions[0]!.confidence >= 40);
  });

  test('Jaccard uses bookmarkTokenSet/folderTokenSet stems, not raw tokenizeTitle', () => {
    const score = overlap('Design systems', 'https://example.com/a', 'Design system');
    assert.ok(score >= 40);
    const output = planAssignExisting(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted'), folder('folder-design', 'Design system')],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'Design systems', 'https://example.com/a'),
          bookmark('bm-2', UNSORTED_ID, 'Design systems', 'https://example.com/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.target.type, 'existing');
    if (output.actions[0]!.target.type !== 'existing') return;
    assert.equal(output.actions[0]!.target.folderId, 'folder-design');
    assert.equal(output.actions[0]!.confidence, score);
  });

  test('ties pick the candidate folder with the lexicographically smaller id', () => {
    const output = planAssignExisting(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder('folder-z', 'GitHub'),
          folder('folder-a', 'GitHub'),
        ],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'GitHub', 'https://github.com/a/1'),
          bookmark('bm-2', UNSORTED_ID, 'GitHub', 'https://github.com/a/2'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.target.type, 'existing');
    if (output.actions[0]!.target.type !== 'existing') return;
    assert.equal(output.actions[0]!.target.folderId, 'folder-a');
    assert.equal(output.actions[0]!.id, `assign:${UNSORTED_ID}:folder-a`);
  });

  test('groups by (targetFolderId, sourceFolderId) so two inboxes yield two actions', () => {
    const output = planAssignExisting(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder(READING_LATER_ID, 'Reading later'),
          folder(GITHUB_FOLDER_ID, 'GitHub'),
        ],
        bookmarks: [
          bookmark('bm-u1', UNSORTED_ID, 'GitHub', 'https://github.com/u/1'),
          bookmark('bm-u2', UNSORTED_ID, 'GitHub', 'https://github.com/u/2'),
          bookmark('bm-r1', READING_LATER_ID, 'GitHub', 'https://github.com/r/1'),
          bookmark('bm-r2', READING_LATER_ID, 'GitHub', 'https://github.com/r/2'),
        ],
        inboxFolderIds: [UNSORTED_ID, READING_LATER_ID],
      }),
    );
    assert.equal(output.actions.length, 2);
    const bySource = new Map(output.actions.map((action) => [action.sourceFolderId, action]));
    assert.deepEqual(bySource.get(UNSORTED_ID)?.nodeIds, ['bm-u1', 'bm-u2']);
    assert.equal(bySource.get(UNSORTED_ID)?.sourceFolderTitle, 'Unsorted');
    assert.deepEqual(bySource.get(READING_LATER_ID)?.nodeIds, ['bm-r1', 'bm-r2']);
    assert.equal(bySource.get(READING_LATER_ID)?.sourceFolderTitle, 'Reading later');
  });
});

describe('caps and uniqueness', () => {
  test('keeps at most 20 actions, ranked by confidence then sourceFolderId then targetFolderId', () => {
    const folders = [folder(UNSORTED_ID, 'Unsorted')];
    const bookmarks: OrganizePlannerBookmark[] = [];
    for (let index = 1; index <= 21; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const folderId = `target-${suffix}`;
      const token = `topic${suffix}`;
      folders.push(folder(folderId, token));
      bookmarks.push(
        bookmark(`bm-${suffix}-a`, UNSORTED_ID, token, `https://${token}.example/a`),
        bookmark(`bm-${suffix}-b`, UNSORTED_ID, token, `https://${token}.example/b`),
      );
    }
    const output = planAssignExisting(
      input({ folders, bookmarks, inboxFolderIds: [UNSORTED_ID] }),
    );
    assert.equal(output.truncated, true);
    assert.equal(output.actions.length, 20);
    const targetIds = output.actions.map((action) =>
      action.target.type === 'existing' ? action.target.folderId : '',
    );
    assert.deepEqual(
      targetIds,
      Array.from({ length: 20 }, (_, index) => `target-${String(index + 1).padStart(2, '0')}`),
    );
    assert.ok(!targetIds.includes('target-21'));
  });

  test('each action keeps at most 50 nodeIds (sorted); extras set truncated and stay out of every action', () => {
    const bookmarks = Array.from({ length: 51 }, (_, index) => {
      const id = `bm-${String(index).padStart(2, '0')}`;
      return bookmark(id, UNSORTED_ID, 'GitHub', `https://github.com/org/${id}`);
    });
    const scene = input({
      folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
      bookmarks,
      inboxFolderIds: [UNSORTED_ID],
    });
    const output = planAssignExisting(scene);
    assert.equal(output.truncated, true);
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.nodeIds.length, 50);
    assert.equal(output.actions[0]!.count, 50);
    assert.deepEqual(
      output.actions[0]!.nodeIds,
      Array.from({ length: 50 }, (_, index) => `bm-${String(index).padStart(2, '0')}`),
    );
    assert.ok(!output.actions[0]!.nodeIds.includes('bm-50'));
    const assigned = assignedNodeIdSet(assignExistingGroups(scene));
    assert.equal(assigned.size, 51);
    assert.ok(assigned.has('bm-50'));
  });

  test('each bookmark appears in at most one action when two folders both match', () => {
    const output = planAssignExisting(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder('folder-github-docs', 'GitHub docs'),
          folder(GITHUB_FOLDER_ID, 'GitHub'),
        ],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'GitHub', 'https://github.com/a/1'),
          bookmark('bm-2', UNSORTED_ID, 'GitHub', 'https://github.com/a/2'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    const seen = new Set<string>();
    for (const action of output.actions) {
      for (const nodeId of action.nodeIds) {
        assert.equal(seen.has(nodeId), false);
        seen.add(nodeId);
      }
    }
    assert.deepEqual([...seen].sort(), ['bm-1', 'bm-2']);
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.target.type, 'existing');
    if (output.actions[0]!.target.type !== 'existing') return;
    assert.equal(output.actions[0]!.target.folderId, GITHUB_FOLDER_ID);
  });
});

describe('H2 grouping helper and planner export', () => {
  test('assignExistingGroups and assignedNodeIdSet expose the clustered node set for host-cluster residual', () => {
    const groups = assignExistingGroups(githubScene());
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.targetFolderId, GITHUB_FOLDER_ID);
    assert.equal(groups[0]!.sourceFolderId, UNSORTED_ID);
    assert.equal(groups[0]!.members.length, 3);
    assert.equal(groups[0]!.confidence, groups[0]!.members.reduce(
      (min, member) => Math.min(min, member.confidence),
      100,
    ));
    const assigned = assignedNodeIdSet(groups);
    assert.deepEqual([...assigned].sort(), ['bm-a', 'bm-b', 'bm-c']);
    assert.equal(assigned.has('bm-root'), false);
  });

  test('assignExistingPlanner.id and plan wrap planAssignExisting', async () => {
    assert.equal(assignExistingPlanner.id, PLANNER_ID);
    const scene = githubScene();
    const pending = assignExistingPlanner.plan(scene);
    assert.equal(pending instanceof Promise, true);
    const fromPlanner = await pending;
    assert.deepEqual(fromPlanner, planAssignExisting(scene));
  });

  test('empty inbox yields empty actions without truncation', () => {
    const output = planAssignExisting(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
        bookmarks: [],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.deepEqual(output, { plannerId: PLANNER_ID, truncated: false, actions: [] });
  });
});

describe('module constraints', () => {
  test('does not use Math.random, does not export a factory, and imports H0 token helpers', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    assert.doesNotMatch(source, /Math\.random/);
    assert.doesNotMatch(source, /createOrganizePlanner/);
    assert.match(source, /from '\.\/organize-planner-tokens\.js'/);
    assert.match(source, /bookmarkTokenSet/);
    assert.match(source, /folderTokenSet/);
    assert.match(source, /isInboxFolderTitle/);
    assert.match(source, /jaccard/);
    assert.doesNotMatch(source, /tokenizeTitle/);
  });
});
