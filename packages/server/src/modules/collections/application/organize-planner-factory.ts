import type { OrganizePlanner } from './organize-planner.js';
import { assignExistingPlanner } from './organize-planner-assign-existing.js';
import { graphCcPlanner } from './organize-planner-graph-cc.js';
import { hostClusterPlanner } from './organize-planner-host-cluster.js';

/**
 * Bake-off winner (OG-H4). Preselected `heuristic.v1.host_cluster`; the
 * 15-percentage-point precision clause did not fire on the frozen corpus, so
 * the default stays host_cluster. Selection is by explicit id only.
 */
export const DEFAULT_ORGANIZE_PLANNER_ID = 'heuristic.v1.host_cluster' as const;

/** Three heuristic bake-off ids. Must not parse the planner env var (H4 lock). */
export const HEURISTIC_PLANNER_IDS = [
  'heuristic.v1.assign_existing',
  'heuristic.v1.host_cluster',
  'heuristic.v1.graph_cc',
] as const;

export type HeuristicPlannerId = (typeof HEURISTIC_PLANNER_IDS)[number];

const HEURISTIC_PLANNER_ID_SET = new Set<string>(HEURISTIC_PLANNER_IDS);

export function isHeuristicPlannerId(id: string): id is HeuristicPlannerId {
  return HEURISTIC_PLANNER_ID_SET.has(id);
}

export function createOrganizePlanner(id: string | undefined): OrganizePlanner {
  const resolved = id === undefined ? DEFAULT_ORGANIZE_PLANNER_ID : id;
  switch (resolved) {
    case 'heuristic.v1.assign_existing':
      return assignExistingPlanner;
    case 'heuristic.v1.host_cluster':
      return hostClusterPlanner;
    case 'heuristic.v1.graph_cc':
      return graphCcPlanner;
    default:
      throw new Error(`Unknown organize planner id: ${resolved}`);
  }
}
