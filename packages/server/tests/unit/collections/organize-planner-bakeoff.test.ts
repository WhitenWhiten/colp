import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import type {
  OrganizePlanAction,
  OrganizePlanTarget,
  OrganizePlanner,
} from '../../../src/modules/collections/application/organize-planner.js';
import { assignExistingPlanner } from '../../../src/modules/collections/application/organize-planner-assign-existing.js';
import {
  DEFAULT_ORGANIZE_PLANNER_ID,
  createOrganizePlanner,
} from '../../../src/modules/collections/application/organize-planner-factory.js';
import { graphCcPlanner } from '../../../src/modules/collections/application/organize-planner-graph-cc.js';
import { hostClusterPlanner } from '../../../src/modules/collections/application/organize-planner-host-cluster.js';
import {
  BAKEOFF_SCENES,
  INBOX_DECOY_FOLDER_ID,
  NEW_THEME_IDS,
  type BakeoffScene,
  type GoldNodeTarget,
} from './organize-planner-bakeoff.fixture.js';

const FACTORY_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../src/modules/collections/application/organize-planner-factory.ts',
  ),
  'utf8',
);

const CANDIDATE_PLANNERS: readonly OrganizePlanner[] = [
  assignExistingPlanner,
  hostClusterPlanner,
  graphCcPlanner,
];

const ASSIGN_EXISTING_ID = 'heuristic.v1.assign_existing';
const HOST_CLUSTER_ID = 'heuristic.v1.host_cluster';
const GRAPH_CC_ID = 'heuristic.v1.graph_cc';

/**
 * Preselected default is `heuristic.v1.host_cluster`. If host_cluster precision
 * is more than 15 percentage points below assign_existing, the factory default
 * MAY become assign_existing. Never default graph_cc unless the other two
 * cannot cover the new-theme scene.
 */
const PRESELECTED_WINNER_ID = HOST_CLUSTER_ID;
const PRECISION_FLIP_MARGIN = 0.15;

type CanonicalTarget =
  | { readonly type: 'existing'; readonly folderId: string; readonly title: string }
  | { readonly type: 'create_folder'; readonly title: string };

interface CanonicalAction {
  readonly target: CanonicalTarget;
  readonly nodeIds: readonly string[];
}

interface PlannerScore {
  readonly plannerId: string;
  readonly precision: number;
  readonly recall: number;
  readonly outputNodeCount: number;
  readonly matchedOutputCount: number;
  readonly shouldMoveCount: number;
  readonly coveredShouldMoveCount: number;
  readonly wrongExistingPenalty: number;
  readonly missedClusterPenalty: number;
  readonly rootPenalty: number;
}

type SceneOutput = {
  readonly scene: BakeoffScene;
  readonly actions: readonly OrganizePlanAction[];
};

function canonicalizeTarget(target: OrganizePlanTarget): CanonicalTarget {
  if (target.type === 'existing') {
    return { type: 'existing', folderId: target.folderId, title: target.title };
  }
  return { type: 'create_folder', title: target.title };
}

function canonicalizeActions(actions: readonly OrganizePlanAction[]): CanonicalAction[] {
  return [...actions]
    .map((action) => ({
      target: canonicalizeTarget(action.target),
      nodeIds: [...action.nodeIds].sort(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function outputNodeEntries(actions: readonly OrganizePlanAction[]): readonly {
  readonly nodeId: string;
  readonly target: OrganizePlanTarget;
}[] {
  const entries: { nodeId: string; target: OrganizePlanTarget }[] = [];
  for (const action of actions) {
    for (const nodeId of action.nodeIds) {
      entries.push({ nodeId, target: action.target });
    }
  }
  return entries;
}

function goldMatchesAction(gold: GoldNodeTarget, target: OrganizePlanTarget): boolean {
  if (gold.type === 'stay') return false;
  if (gold.type === 'existing') {
    return target.type === 'existing' && target.folderId === gold.folderId;
  }
  if (target.type !== 'create_folder') return false;
  return gold.title === undefined || target.title === gold.title;
}

function shouldMoveNodeIds(scene: BakeoffScene): readonly string[] {
  return Object.entries(scene.goldByNodeId)
    .filter(([, gold]) => gold.type !== 'stay')
    .map(([nodeId]) => nodeId);
}

function coversNewTheme(actions: readonly OrganizePlanAction[]): boolean {
  const byNode = new Map(outputNodeEntries(actions).map((entry) => [entry.nodeId, entry.target]));
  return NEW_THEME_IDS.every((nodeId) => {
    const target = byNode.get(nodeId);
    return target !== undefined && target.type === 'create_folder';
  });
}

function scorePlanner(plannerId: string, sceneOutputs: readonly SceneOutput[]): PlannerScore {
  let matchedOutputCount = 0;
  let outputNodeCount = 0;
  let coveredShouldMoveCount = 0;
  let shouldMoveCount = 0;
  let wrongExistingPenalty = 0;
  let missedClusterPenalty = 0;
  let rootPenalty = 0;

  for (const { scene, actions } of sceneOutputs) {
    const listed = outputNodeEntries(actions);
    const listedIds = new Set(listed.map((entry) => entry.nodeId));
    outputNodeCount += listed.length;

    for (const rootId of scene.rootBookmarkIds) {
      if (listedIds.has(rootId)) rootPenalty -= 100;
    }

    for (const entry of listed) {
      const gold = scene.goldByNodeId[entry.nodeId];
      if (gold !== undefined && goldMatchesAction(gold, entry.target)) {
        matchedOutputCount += 1;
      }
      if (entry.target.type === 'existing') {
        const expected = gold?.type === 'existing' ? gold.folderId : undefined;
        if (expected !== entry.target.folderId) wrongExistingPenalty -= 2;
      }
    }

    for (const nodeId of shouldMoveNodeIds(scene)) {
      shouldMoveCount += 1;
      if (listedIds.has(nodeId)) coveredShouldMoveCount += 1;
    }

    for (const cluster of scene.goldClusters) {
      const covered = cluster.nodeIds.some((nodeId) => listedIds.has(nodeId));
      if (!covered) missedClusterPenalty -= 1;
    }
  }

  return {
    plannerId,
    precision: outputNodeCount === 0 ? 1 : matchedOutputCount / outputNodeCount,
    recall: shouldMoveCount === 0 ? 1 : coveredShouldMoveCount / shouldMoveCount,
    outputNodeCount,
    matchedOutputCount,
    shouldMoveCount,
    coveredShouldMoveCount,
    wrongExistingPenalty,
    missedClusterPenalty,
    rootPenalty,
  };
}

function pickWinner(
  scores: readonly PlannerScore[],
  sceneOutputsByPlanner: ReadonlyMap<string, readonly SceneOutput[]>,
): string {
  const assign = scores.find((score) => score.plannerId === ASSIGN_EXISTING_ID);
  const host = scores.find((score) => score.plannerId === HOST_CLUSTER_ID);
  assert.ok(assign);
  assert.ok(host);

  const hostCoversTheme = coversNewTheme(
    sceneOutputsByPlanner.get(HOST_CLUSTER_ID)?.find((row) => row.scene.name === 'new-theme')?.actions ?? [],
  );
  const assignCoversTheme = coversNewTheme(
    sceneOutputsByPlanner.get(ASSIGN_EXISTING_ID)?.find((row) => row.scene.name === 'new-theme')?.actions ?? [],
  );
  if (!hostCoversTheme && !assignCoversTheme) return GRAPH_CC_ID;
  if (host.precision + PRECISION_FLIP_MARGIN < assign.precision) return ASSIGN_EXISTING_ID;
  return PRESELECTED_WINNER_ID;
}

const ACTION_SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, CanonicalAction[]>>>> = {
  [ASSIGN_EXISTING_ID]: {
    'host-align': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-gh-a', 'bm-gh-b', 'bm-gh-c'],
      },
      {
        target: { type: 'existing', folderId: 'folder-wikipedia', title: 'Wikipedia' },
        nodeIds: ['bm-wiki-a', 'bm-wiki-b'],
      },
    ],
    'new-theme': [],
    noise: [],
    'root-and-inbox-guards': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-guard-gh-a', 'bm-guard-gh-b'],
      },
    ],
  },
  [HOST_CLUSTER_ID]: {
    'host-align': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-gh-a', 'bm-gh-b', 'bm-gh-c'],
      },
      {
        target: { type: 'existing', folderId: 'folder-wikipedia', title: 'Wikipedia' },
        nodeIds: ['bm-wiki-a', 'bm-wiki-b'],
      },
    ],
    'new-theme': [
      {
        target: { type: 'create_folder', title: 'Arxiv' },
        nodeIds: ['bm-arxiv-a', 'bm-arxiv-b', 'bm-arxiv-c', 'bm-arxiv-d'],
      },
    ],
    noise: [],
    'root-and-inbox-guards': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-guard-gh-a', 'bm-guard-gh-b'],
      },
    ],
  },
  [GRAPH_CC_ID]: {
    'host-align': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-gh-a', 'bm-gh-b', 'bm-gh-c'],
      },
      {
        target: { type: 'existing', folderId: 'folder-wikipedia', title: 'Wikipedia' },
        nodeIds: ['bm-wiki-a', 'bm-wiki-b'],
      },
    ],
    'new-theme': [
      {
        target: { type: 'create_folder', title: 'Paper Arxiv One' },
        nodeIds: ['bm-arxiv-a', 'bm-arxiv-b', 'bm-arxiv-c', 'bm-arxiv-d'],
      },
    ],
    noise: [],
    'root-and-inbox-guards': [
      {
        target: { type: 'existing', folderId: 'folder-github', title: 'GitHub' },
        nodeIds: ['bm-guard-gh-a', 'bm-guard-gh-b'],
      },
    ],
  },
};

describe('OG-H4 bake-off corpus', () => {
  test('fixture has at least four scenes covering host-align, new-theme, noise, and root/inbox guards', () => {
    assert.ok(BAKEOFF_SCENES.length >= 4);
    assert.deepEqual(
      BAKEOFF_SCENES.map((scene) => scene.name),
      ['host-align', 'new-theme', 'noise', 'root-and-inbox-guards'],
    );
  });
});

describe('three planners on the same fixtures', () => {
  test('semantic action snapshots exclude action id and sort nodeIds', async () => {
    for (const planner of CANDIDATE_PLANNERS) {
      for (const scene of BAKEOFF_SCENES) {
        const output = await planner.plan(scene.input);
        assert.equal(output.plannerId, planner.id);
        assert.deepEqual(
          canonicalizeActions(output.actions),
          ACTION_SNAPSHOTS[planner.id]![scene.name],
        );
      }
    }
  });

  test('noise scene yields empty actions for every planner', async () => {
    const noise = BAKEOFF_SCENES.find((scene) => scene.name === 'noise');
    assert.ok(noise);
    for (const planner of CANDIDATE_PLANNERS) {
      const output = await planner.plan(noise.input);
      assert.deepEqual(output.actions, []);
    }
  });
});

describe('invariants: root bookmarks and inbox decoy', () => {
  test('root bookmarks never appear in any action; inbox folder is never an existing target', async () => {
    for (const planner of CANDIDATE_PLANNERS) {
      for (const scene of BAKEOFF_SCENES) {
        const output = await planner.plan(scene.input);
        const listed = output.actions.flatMap((action) => [...action.nodeIds]);
        for (const rootId of scene.rootBookmarkIds) {
          assert.equal(
            listed.includes(rootId),
            false,
            `${planner.id} listed root bookmark ${rootId} on ${scene.name}`,
          );
        }
        for (const action of output.actions) {
          if (action.target.type !== 'existing') continue;
          assert.notEqual(action.target.folderId, INBOX_DECOY_FOLDER_ID);
          for (const decoyId of scene.inboxDecoyFolderIds) {
            assert.notEqual(action.target.folderId, decoyId);
          }
        }
      }
    }
  });
});

describe('test-only scoring locks the factory default', () => {
  test('winner is host_cluster and matches DEFAULT_ORGANIZE_PLANNER_ID', async () => {
    const sceneOutputsByPlanner = new Map<string, SceneOutput[]>();
    const scores: PlannerScore[] = [];

    for (const planner of CANDIDATE_PLANNERS) {
      const rows: SceneOutput[] = [];
      for (const scene of BAKEOFF_SCENES) {
        const output = await planner.plan(scene.input);
        rows.push({ scene, actions: output.actions });
      }
      sceneOutputsByPlanner.set(planner.id, rows);
      scores.push(scorePlanner(planner.id, rows));
    }

    const assign = scores.find((score) => score.plannerId === ASSIGN_EXISTING_ID);
    const host = scores.find((score) => score.plannerId === HOST_CLUSTER_ID);
    const graph = scores.find((score) => score.plannerId === GRAPH_CC_ID);
    assert.ok(assign);
    assert.ok(host);
    assert.ok(graph);

    assert.equal(assign.precision, 1);
    assert.equal(assign.matchedOutputCount, 7);
    assert.equal(assign.outputNodeCount, 7);
    assert.equal(assign.coveredShouldMoveCount, 7);
    assert.equal(assign.shouldMoveCount, 11);
    assert.equal(assign.missedClusterPenalty, -1);
    assert.equal(assign.wrongExistingPenalty, 0);
    assert.equal(assign.rootPenalty, 0);

    assert.equal(host.precision, 1);
    assert.equal(host.matchedOutputCount, 11);
    assert.equal(host.outputNodeCount, 11);
    assert.equal(host.recall, 1);
    assert.equal(host.missedClusterPenalty, 0);
    assert.equal(host.wrongExistingPenalty, 0);
    assert.equal(host.rootPenalty, 0);

    assert.equal(graph.precision, 1);
    assert.equal(graph.recall, 1);
    assert.equal(graph.rootPenalty, 0);

    for (const score of scores) {
      assert.equal(score.rootPenalty, 0);
    }

    const winnerId = pickWinner(scores, sceneOutputsByPlanner);
    assert.equal(winnerId, HOST_CLUSTER_ID);
    assert.equal(DEFAULT_ORGANIZE_PLANNER_ID, winnerId);
    assert.equal(createOrganizePlanner(undefined).id, DEFAULT_ORGANIZE_PLANNER_ID);
    assert.equal(createOrganizePlanner(undefined).id, winnerId);
    assert.ok(host.precision + PRECISION_FLIP_MARGIN >= assign.precision);
  });
});

describe('createOrganizePlanner factory', () => {
  test('maps known ids to the three heuristic planners', () => {
    assert.equal(createOrganizePlanner(ASSIGN_EXISTING_ID).id, ASSIGN_EXISTING_ID);
    assert.equal(createOrganizePlanner(HOST_CLUSTER_ID).id, HOST_CLUSTER_ID);
    assert.equal(createOrganizePlanner(GRAPH_CC_ID).id, GRAPH_CC_ID);
    assert.equal(createOrganizePlanner(ASSIGN_EXISTING_ID), assignExistingPlanner);
    assert.equal(createOrganizePlanner(HOST_CLUSTER_ID), hostClusterPlanner);
    assert.equal(createOrganizePlanner(GRAPH_CC_ID), graphCcPlanner);
    assert.equal(createOrganizePlanner(undefined), hostClusterPlanner);
  });

  test('unknown id throws a domain Error that includes the id', () => {
    const unknown = 'heuristic.v1.not_a_real_planner';
    assert.throws(
      () => createOrganizePlanner(unknown),
      (error: unknown) => error instanceof Error && error.message.includes(unknown),
    );
    assert.throws(
      () => createOrganizePlanner('llm.v1.demo'),
      (error: unknown) => error instanceof Error && error.message.includes('llm.v1.demo'),
    );
    assert.throws(() => createOrganizePlanner(''));
  });

  test('does not read env, parse ORGANIZE_PLANNER_ID, or use Math.random', () => {
    assert.doesNotMatch(FACTORY_SOURCE, /process\.env/);
    assert.doesNotMatch(FACTORY_SOURCE, /(?<!DEFAULT_)ORGANIZE_PLANNER_ID/);
    assert.doesNotMatch(FACTORY_SOURCE, /Math\.random/);
    assert.doesNotMatch(FACTORY_SOURCE, /llm\.v1/);
  });
});
