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
  assignedNodeIdSet,
  planAssignExisting,
} from '../../../src/modules/collections/application/organize-planner-assign-existing.js';
import {
  hostClusterPlanner,
  planHostCluster,
} from '../../../src/modules/collections/application/organize-planner-host-cluster.js';

const APPLICATION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/modules/collections/application',
);
const SOURCE_PATH = join(APPLICATION_DIR, 'organize-planner-host-cluster.ts');
const H1_SOURCE_PATH = join(APPLICATION_DIR, 'organize-planner-assign-existing.ts');

const ROOT_ID = 'root';
const UNSORTED_ID = 'folder-unsorted';
const READING_LATER_ID = 'folder-reading-later';
const GITHUB_FOLDER_ID = 'folder-github';
const PLANNER_ID = 'heuristic.v1.host_cluster';

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

function sameHostNoFolderScene(): OrganizePlannerInput {
  return input({
    folders: [folder(UNSORTED_ID, 'Unsorted')],
    bookmarks: [
      bookmark('bm-c', UNSORTED_ID, 'Repo three', 'https://github.com/org/three'),
      bookmark('bm-a', UNSORTED_ID, 'Repo one', 'https://github.com/org/one'),
      bookmark('bm-b', UNSORTED_ID, 'Repo two', 'https://www.github.com/org/two'),
      bookmark('bm-root', ROOT_ID, 'Root github', 'https://github.com/root/should-not-appear'),
    ],
    inboxFolderIds: [UNSORTED_ID],
  });
}

describe('heuristic.v1.host_cluster — required scenes', () => {
  test('no matching folder, same host ≥ 2 → create_folder under root titled GitHub', () => {
    const output = planHostCluster(sameHostNoFolderScene());
    assert.equal(output.plannerId, PLANNER_ID);
    assert.equal(output.truncated, false);
    assert.equal(output.actions.length, 1);
    const action = output.actions[0]!;
    assert.equal(action.target.type, 'create_folder');
    if (action.target.type !== 'create_folder') return;
    assert.equal(action.target.parentId, ROOT_ID);
    assert.equal(action.target.title, 'GitHub');
    assert.deepEqual(action.nodeIds, ['bm-a', 'bm-b', 'bm-c']);
    assert.equal(action.count, 3);
    assert.equal(action.sourceFolderId, UNSORTED_ID);
    assert.equal(action.sourceFolderTitle, 'Unsorted');
    assert.equal(action.reason, 'Same host "github.com" (3 bookmarks).');
    assert.equal(action.confidence, 80);
    assert.equal(action.id, `host:${UNSORTED_ID}:github.com`);
    assert.ok(!action.nodeIds.includes('bm-root'));
  });

  test('different hosts with no overlap are not merged', () => {
    const output = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-gh-1', UNSORTED_ID, 'Repo one', 'https://github.com/org/one'),
          bookmark('bm-gh-2', UNSORTED_ID, 'Repo two', 'https://github.com/org/two'),
          bookmark('bm-gl-1', UNSORTED_ID, 'Project one', 'https://gitlab.com/org/one'),
          bookmark('bm-gl-2', UNSORTED_ID, 'Project two', 'https://gitlab.com/org/two'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 2);
    const byHost = new Map(
      output.actions.map((action) => {
        const match = /Same host "([^"]+)"/.exec(action.reason);
        return [match?.[1] ?? '', action];
      }),
    );
    assert.deepEqual(byHost.get('github.com')?.nodeIds, ['bm-gh-1', 'bm-gh-2']);
    assert.deepEqual(byHost.get('gitlab.com')?.nodeIds, ['bm-gl-1', 'bm-gl-2']);
    assert.equal(byHost.get('github.com')?.target.type, 'create_folder');
    assert.equal(byHost.get('gitlab.com')?.target.type, 'create_folder');
    if (byHost.get('github.com')?.target.type === 'create_folder') {
      assert.equal(byHost.get('github.com')!.target.title, 'GitHub');
    }
    if (byHost.get('gitlab.com')?.target.type === 'create_folder') {
      assert.equal(byHost.get('gitlab.com')!.target.title, 'Gitlab');
    }
    const singleton = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-gh', UNSORTED_ID, 'Repo', 'https://github.com/org/one'),
          bookmark('bm-gl', UNSORTED_ID, 'Project', 'https://gitlab.com/org/one'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.deepEqual(singleton.actions, []);
  });

  test('docs.foo.com and foo.com are not merged (no PSL registrable-domain collapse)', () => {
    const output = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-docs-b', UNSORTED_ID, 'Docs b', 'https://docs.foo.com/b'),
          bookmark('bm-apex-a', UNSORTED_ID, 'Apex a', 'https://foo.com/a'),
          bookmark('bm-docs-a', UNSORTED_ID, 'Docs a', 'https://docs.foo.com/a'),
          bookmark('bm-apex-b', UNSORTED_ID, 'Apex b', 'https://foo.com/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 2);
    const docs = output.actions.find((action) => action.reason.includes('"docs.foo.com"'));
    const apex = output.actions.find((action) => action.reason.includes('"foo.com"'));
    assert.ok(docs);
    assert.ok(apex);
    assert.deepEqual(docs!.nodeIds, ['bm-docs-a', 'bm-docs-b']);
    assert.deepEqual(apex!.nodeIds, ['bm-apex-a', 'bm-apex-b']);
    assert.equal(docs!.target.type, 'create_folder');
    assert.equal(apex!.target.type, 'create_folder');
    if (docs!.target.type === 'create_folder') assert.equal(docs!.target.title, 'Foo');
    if (apex!.target.type === 'create_folder') assert.equal(apex!.target.title, 'Foo');
    assert.notDeepEqual(docs!.nodeIds, apex!.nodeIds);
  });

  test('residual after H1: github bookmarks assigned to existing GitHub are not also create_folder', () => {
    const scene = githubScene();
    const h1 = planAssignExisting(scene);
    assert.equal(h1.actions.length, 1);
    assert.equal(h1.actions[0]!.target.type, 'existing');
    const assigned = assignedNodeIdSet(assignExistingGroups(scene));
    assert.deepEqual([...assigned].sort(), ['bm-a', 'bm-b', 'bm-c']);

    const output = planHostCluster(scene);
    assert.equal(output.plannerId, PLANNER_ID);
    assert.equal(output.actions.length, 1);
    assert.deepEqual(output.actions[0], h1.actions[0]);
    assert.equal(output.actions[0]!.target.type, 'existing');
    assert.ok(
      !output.actions.some(
        (action) => action.target.type === 'create_folder' && action.target.title === 'GitHub',
      ),
    );
    for (const nodeId of output.actions.flatMap((action) => action.nodeIds)) {
      assert.notEqual(nodeId, 'bm-root');
    }
  });

  test('root bookmarks are excluded even when they share a host with inbox bookmarks', () => {
    const output = planHostCluster(sameHostNoFolderScene());
    for (const nodeId of output.actions.flatMap((action) => action.nodeIds)) {
      assert.notEqual(nodeId, 'bm-root');
    }
    const rootOnly = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-root-a', ROOT_ID, 'Root a', 'https://github.com/root/a'),
          bookmark('bm-root-b', ROOT_ID, 'Root b', 'https://github.com/root/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.deepEqual(rootOnly.actions, []);
    assert.equal(rootOnly.truncated, false);
  });
});

describe('H1 actions first, then residual host clusters', () => {
  test('planHostCluster prepends assign-existing actions before residual create_folder', () => {
    const scene = input({
      folders: [
        folder(UNSORTED_ID, 'Unsorted'),
        folder(GITHUB_FOLDER_ID, 'GitHub'),
      ],
      bookmarks: [
        bookmark('bm-gh-a', UNSORTED_ID, 'GitHub', 'https://github.com/org/a'),
        bookmark('bm-gh-b', UNSORTED_ID, 'GitHub', 'https://github.com/org/b'),
        bookmark('bm-gl-a', UNSORTED_ID, 'Project a', 'https://gitlab.com/org/a'),
        bookmark('bm-gl-b', UNSORTED_ID, 'Project b', 'https://gitlab.com/org/b'),
        bookmark('bm-root', ROOT_ID, 'GitHub', 'https://github.com/root/skip'),
      ],
      inboxFolderIds: [UNSORTED_ID],
    });
    const h1 = planAssignExisting(scene);
    assert.equal(h1.actions.length, 1);
    const output = planHostCluster(scene);
    assert.equal(output.actions.length, 2);
    assert.deepEqual(output.actions[0], h1.actions[0]);
    assert.equal(output.actions[1]!.target.type, 'create_folder');
    if (output.actions[1]!.target.type !== 'create_folder') return;
    assert.equal(output.actions[1]!.target.title, 'Gitlab');
    assert.deepEqual(output.actions[1]!.nodeIds, ['bm-gl-a', 'bm-gl-b']);
    assert.equal(output.actions[1]!.reason, 'Same host "gitlab.com" (2 bookmarks).');
    assert.ok(!output.actions[1]!.nodeIds.includes('bm-gh-a'));
    assert.ok(!output.actions[1]!.nodeIds.includes('bm-gh-b'));
  });

  test('H1 50-node leftovers stay assigned and are not host-clustered', () => {
    const bookmarks = Array.from({ length: 52 }, (_, index) => {
      const id = `bm-${String(index).padStart(2, '0')}`;
      return bookmark(id, UNSORTED_ID, 'GitHub', `https://github.com/org/${id}`);
    });
    const scene = input({
      folders: [folder(UNSORTED_ID, 'Unsorted'), folder(GITHUB_FOLDER_ID, 'GitHub')],
      bookmarks,
      inboxFolderIds: [UNSORTED_ID],
    });
    const h1 = planAssignExisting(scene);
    assert.equal(h1.truncated, true);
    assert.equal(h1.actions[0]!.nodeIds.length, 50);
    assert.equal(assignedNodeIdSet(assignExistingGroups(scene)).size, 52);

    const output = planHostCluster(scene);
    assert.equal(output.truncated, true);
    assert.equal(output.actions.length, 1);
    assert.deepEqual(output.actions[0], h1.actions[0]);
    assert.ok(!output.actions.some((action) => action.target.type === 'create_folder'));
    const listed = new Set(output.actions.flatMap((action) => action.nodeIds));
    assert.equal(listed.has('bm-50'), false);
    assert.equal(listed.has('bm-51'), false);
  });
});

describe('host bucketing', () => {
  test('hyphenated hosts stay one bucket key', () => {
    const output = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-1', UNSORTED_ID, 'One', 'https://foo-bar.com/a'),
          bookmark('bm-2', UNSORTED_ID, 'Two', 'https://foo-bar.com/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.reason, 'Same host "foo-bar.com" (2 bookmarks).');
    assert.equal(output.actions[0]!.target.type, 'create_folder');
    if (output.actions[0]!.target.type !== 'create_folder') return;
    assert.equal(output.actions[0]!.target.title, 'Foo-bar');
    assert.equal(output.actions[0]!.id, `host:${UNSORTED_ID}:foo-bar.com`);
  });

  test('illegal URLs are skipped without throwing and do not form a bucket', () => {
    assert.doesNotThrow(() =>
      planHostCluster(
        input({
          folders: [folder(UNSORTED_ID, 'Unsorted')],
          bookmarks: [
            bookmark('bm-bad-1', UNSORTED_ID, 'Bad one', 'not a url'),
            bookmark('bm-bad-2', UNSORTED_ID, 'Bad two', '://broken'),
            bookmark('bm-ok-1', UNSORTED_ID, 'Ok one', 'https://github.com/org/a'),
            bookmark('bm-ok-2', UNSORTED_ID, 'Ok two', 'https://github.com/org/b'),
          ],
          inboxFolderIds: [UNSORTED_ID],
        }),
      ),
    );
    const output = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [
          bookmark('bm-bad-1', UNSORTED_ID, 'Bad one', 'not a url'),
          bookmark('bm-bad-2', UNSORTED_ID, 'Bad two', '://broken'),
          bookmark('bm-ok-1', UNSORTED_ID, 'Ok one', 'https://github.com/org/a'),
          bookmark('bm-ok-2', UNSORTED_ID, 'Ok two', 'https://github.com/org/b'),
        ],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.equal(output.actions.length, 1);
    assert.deepEqual(output.actions[0]!.nodeIds, ['bm-ok-1', 'bm-ok-2']);
  });

  test('title collision with a non-inbox live folder under root converts to existing', () => {
    const scene = input({
      folders: [
        folder(UNSORTED_ID, 'Unsorted'),
        folder('folder-example', 'Example'),
      ],
      bookmarks: [
        bookmark('bm-1', UNSORTED_ID, 'Random notes', 'https://example.com/a'),
        bookmark('bm-2', UNSORTED_ID, 'Random notes', 'https://example.com/b'),
      ],
      inboxFolderIds: [UNSORTED_ID],
    });
    assert.deepEqual(planAssignExisting(scene).actions, []);
    const output = planHostCluster(scene);
    assert.equal(output.actions.length, 1);
    assert.equal(output.actions[0]!.target.type, 'existing');
    if (output.actions[0]!.target.type !== 'existing') return;
    assert.equal(output.actions[0]!.target.folderId, 'folder-example');
    assert.equal(output.actions[0]!.target.title, 'Example');
    assert.deepEqual(output.actions[0]!.nodeIds, ['bm-1', 'bm-2']);
    assert.equal(output.actions[0]!.reason, 'Same host "example.com" (2 bookmarks).');
    assert.equal(output.actions[0]!.id, `host:${UNSORTED_ID}:example.com`);
  });
});

describe('caps, uniqueness, and planner export', () => {
  test('combined assign-existing + host-cluster actions stay within 20 and cap 50 nodes', () => {
    const folders = [folder(UNSORTED_ID, 'Unsorted')];
    const bookmarks: OrganizePlannerBookmark[] = [];
    for (let index = 1; index <= 19; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const folderId = `target-${suffix}`;
      const token = `topic${suffix}`;
      folders.push(folder(folderId, token));
      bookmarks.push(
        bookmark(`bm-${suffix}-a`, UNSORTED_ID, token, `https://${token}.example/a`),
        bookmark(`bm-${suffix}-b`, UNSORTED_ID, token, `https://${token}.example/b`),
      );
    }
    const hostBookmarks = Array.from({ length: 51 }, (_, index) => {
      const id = `bm-host-${String(index).padStart(2, '0')}`;
      return bookmark(id, UNSORTED_ID, 'Host page', `https://news.example/${id}`);
    });
    const extraHost = [
      bookmark('bm-other-a', UNSORTED_ID, 'Other a', 'https://other.example/a'),
      bookmark('bm-other-b', UNSORTED_ID, 'Other b', 'https://other.example/b'),
    ];
    const scene = input({
      folders,
      bookmarks: [...bookmarks, ...hostBookmarks, ...extraHost],
      inboxFolderIds: [UNSORTED_ID],
    });
    const h1 = planAssignExisting(scene);
    assert.equal(h1.actions.length, 19);
    const output = planHostCluster(scene);
    assert.equal(output.actions.length, 20);
    assert.equal(output.truncated, true);
    assert.deepEqual(output.actions.slice(0, 19), [...h1.actions]);
    const hostAction = output.actions[19]!;
    assert.equal(hostAction.target.type, 'create_folder');
    assert.equal(hostAction.nodeIds.length, 50);
    assert.equal(hostAction.count, 50);
    assert.equal(hostAction.reason, 'Same host "news.example" (50 bookmarks).');
    assert.ok(!output.actions.some((action) => action.reason.includes('"other.example"')));
    const seen = new Set<string>();
    for (const action of output.actions) {
      for (const nodeId of action.nodeIds) {
        assert.equal(seen.has(nodeId), false);
        seen.add(nodeId);
      }
    }
  });

  test('groups by source folder so two inboxes on the same host yield two actions', () => {
    const output = planHostCluster(
      input({
        folders: [
          folder(UNSORTED_ID, 'Unsorted'),
          folder(READING_LATER_ID, 'Reading later'),
        ],
        bookmarks: [
          bookmark('bm-u1', UNSORTED_ID, 'One', 'https://github.com/u/1'),
          bookmark('bm-u2', UNSORTED_ID, 'Two', 'https://github.com/u/2'),
          bookmark('bm-r1', READING_LATER_ID, 'One', 'https://github.com/r/1'),
          bookmark('bm-r2', READING_LATER_ID, 'Two', 'https://github.com/r/2'),
        ],
        inboxFolderIds: [UNSORTED_ID, READING_LATER_ID],
      }),
    );
    assert.equal(output.actions.length, 2);
    const bySource = new Map(output.actions.map((action) => [action.sourceFolderId, action]));
    assert.deepEqual(bySource.get(UNSORTED_ID)?.nodeIds, ['bm-u1', 'bm-u2']);
    assert.deepEqual(bySource.get(READING_LATER_ID)?.nodeIds, ['bm-r1', 'bm-r2']);
    assert.equal(bySource.get(UNSORTED_ID)?.sourceFolderTitle, 'Unsorted');
    assert.equal(bySource.get(READING_LATER_ID)?.sourceFolderTitle, 'Reading later');
  });

  test('hostClusterPlanner.id and plan wrap planHostCluster', async () => {
    assert.equal(hostClusterPlanner.id, PLANNER_ID);
    const scene = sameHostNoFolderScene();
    const pending = hostClusterPlanner.plan(scene);
    assert.equal(pending instanceof Promise, true);
    const fromPlanner = await pending;
    assert.deepEqual(fromPlanner, planHostCluster(scene));
  });

  test('empty inbox yields empty actions without truncation', () => {
    const output = planHostCluster(
      input({
        folders: [folder(UNSORTED_ID, 'Unsorted')],
        bookmarks: [],
        inboxFolderIds: [UNSORTED_ID],
      }),
    );
    assert.deepEqual(output, { plannerId: PLANNER_ID, truncated: false, actions: [] });
  });
});

describe('module constraints', () => {
  test('imports H1 grouping helpers, does not copy Jaccard, factory, PSL, or Math.random', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    assert.match(source, /from '\.\/organize-planner-assign-existing\.js'/);
    assert.match(source, /assignExistingGroups/);
    assert.match(source, /assignedNodeIdSet/);
    assert.match(source, /planAssignExisting/);
    assert.doesNotMatch(source, /Math\.random/);
    assert.doesNotMatch(source, /createOrganizePlanner/);
    assert.doesNotMatch(source, /public-suffix|tldts|\bpsl\b/iu);
    assert.doesNotMatch(source, /\bjaccard\s*\(/u);
    assert.doesNotMatch(source, /\bhostTokens\b/);
    assert.match(readFileSync(H1_SOURCE_PATH, 'utf8'), /export function assignExistingGroups/);
  });
});
