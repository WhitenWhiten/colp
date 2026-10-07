/**
 * Heuristic assign-existing Organize planner (`heuristic.v1.assign_existing`).
 * Pure: no I/O and no non-deterministic choice. Scores inbox bookmarks onto existing
 * non-inbox folders with H0 Jaccard (`bookmarkTokenSet` / `folderTokenSet`).
 *
 * OG-H2 must import {@link assignExistingGroups} / {@link assignedNodeIdSet}
 * and subtract those node ids; do not copy this scoring loop.
 */
import type {
  OrganizePlanAction,
  OrganizePlanner,
  OrganizePlannerBookmark,
  OrganizePlannerFolder,
  OrganizePlannerInput,
  OrganizePlannerOutput,
} from './organize-planner.js';
import {
  bookmarkTokenSet,
  folderTokenSet,
  isInboxFolderTitle,
  jaccard,
} from './organize-planner-tokens.js';

export const ASSIGN_EXISTING_PLANNER_ID = 'heuristic.v1.assign_existing';

const MIN_CONFIDENCE = 40;
const MIN_GROUP_SIZE = 2;
const MAX_ACTIONS = 20;
const MAX_NODES_PER_ACTION = 50;

export interface AssignExistingMember {
  readonly nodeId: string;
  readonly confidence: number;
}

export interface AssignExistingGroup {
  readonly sourceFolderId: string;
  readonly sourceFolderTitle: string;
  readonly targetFolderId: string;
  readonly targetTitle: string;
  /** Members sorted by node id ascending. */
  readonly members: readonly AssignExistingMember[];
  /** Minimum Jaccard among members (integer 0–100). */
  readonly confidence: number;
}

type GroupAccumulator = {
  sourceFolderId: string;
  sourceFolderTitle: string;
  targetFolderId: string;
  targetTitle: string;
  members: AssignExistingMember[];
};

function compareOpaqueId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupKey(sourceFolderId: string, targetFolderId: string): string {
  return `${sourceFolderId}\0${targetFolderId}`;
}

function isCandidateTarget(
  folder: OrganizePlannerFolder,
  rootId: string,
  sourceFolderId: string,
  inboxIds: ReadonlySet<string>,
): boolean {
  if (inboxIds.has(folder.id)) return false;
  if (isInboxFolderTitle(folder.title)) return false;
  if (folder.id === rootId) return false;
  if (folder.id === sourceFolderId) return false;
  return true;
}

function bestExistingFolder(
  bookmark: OrganizePlannerBookmark,
  folders: readonly OrganizePlannerFolder[],
  rootId: string,
  inboxIds: ReadonlySet<string>,
): { folder: OrganizePlannerFolder; score: number } | undefined {
  const tokens = bookmarkTokenSet(bookmark);
  let best: { folder: OrganizePlannerFolder; score: number } | undefined;
  for (const folder of folders) {
    if (!isCandidateTarget(folder, rootId, bookmark.parentId, inboxIds)) continue;
    const score = jaccard(tokens, folderTokenSet(folder.title));
    if (score < MIN_CONFIDENCE) continue;
    if (
      best === undefined
      || score > best.score
      || (score === best.score && folder.id < best.folder.id)
    ) {
      best = { folder, score };
    }
  }
  return best;
}

function minimumConfidence(members: readonly AssignExistingMember[]): number {
  let min = 100;
  for (const member of members) {
    if (member.confidence < min) min = member.confidence;
  }
  return min;
}

/**
 * Group inbox-folder bookmarks onto existing non-inbox folders.
 *
 * A bookmark is a source only when `parentId` is in `inboxFolderIds` and is
 * not `rootId`. Each source bookmark is assigned to at most one folder: the
 * highest Jaccard (`bookmarkTokenSet` × `folderTokenSet`) that is ≥ 40; ties
 * break on lexicographically smaller folder id.
 *
 * Survivors are grouped by `(targetFolderId, sourceFolderId)`. Groups with
 * size &lt; 2 or minimum Jaccard &lt; 40 are dropped. Representative
 * confidence is the **minimum** Jaccard in the group so a weak member cannot
 * ride along.
 *
 * **OG-H2:** import this function and {@link assignedNodeIdSet} to subtract
 * assigned node ids from the residual source set. Do not copy this loop.
 * Caps (20 actions / 50 nodes) apply only in {@link planAssignExisting};
 * truncated members remain in these groups so they are not host-clustered
 * into a second action.
 */
export function assignExistingGroups(
  input: OrganizePlannerInput,
): readonly AssignExistingGroup[] {
  const inboxIds = new Set(input.inboxFolderIds);
  const folderById = new Map<string, OrganizePlannerFolder>();
  for (const folder of input.folders) {
    if (!folderById.has(folder.id)) folderById.set(folder.id, folder);
  }

  const accumulators = new Map<string, GroupAccumulator>();
  for (const bookmark of input.bookmarks) {
    if (bookmark.parentId === input.rootId) continue;
    if (!inboxIds.has(bookmark.parentId)) continue;
    const match = bestExistingFolder(
      bookmark,
      input.folders,
      input.rootId,
      inboxIds,
    );
    if (match === undefined) continue;
    const sourceFolderId = bookmark.parentId;
    const key = groupKey(sourceFolderId, match.folder.id);
    let group = accumulators.get(key);
    if (group === undefined) {
      group = {
        sourceFolderId,
        sourceFolderTitle: folderById.get(sourceFolderId)?.title ?? '',
        targetFolderId: match.folder.id,
        targetTitle: match.folder.title,
        members: [],
      };
      accumulators.set(key, group);
    }
    group.members.push({ nodeId: bookmark.id, confidence: match.score });
  }

  const groups: AssignExistingGroup[] = [];
  for (const group of accumulators.values()) {
    if (group.members.length < MIN_GROUP_SIZE) continue;
    const members = [...group.members].sort((left, right) =>
      compareOpaqueId(left.nodeId, right.nodeId)
    );
    const confidence = minimumConfidence(members);
    if (confidence < MIN_CONFIDENCE) continue;
    groups.push({
      sourceFolderId: group.sourceFolderId,
      sourceFolderTitle: group.sourceFolderTitle,
      targetFolderId: group.targetFolderId,
      targetTitle: group.targetTitle,
      members,
      confidence,
    });
  }
  return groups;
}

/** Node ids clustered by {@link assignExistingGroups} (pre action/node caps). */
export function assignedNodeIdSet(
  groups: readonly AssignExistingGroup[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const member of group.members) ids.add(member.nodeId);
  }
  return ids;
}

function rankGroups(left: AssignExistingGroup, right: AssignExistingGroup): number {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const source = compareOpaqueId(left.sourceFolderId, right.sourceFolderId);
  if (source !== 0) return source;
  return compareOpaqueId(left.targetFolderId, right.targetFolderId);
}

function toAction(group: AssignExistingGroup): {
  action: OrganizePlanAction;
  omitted: boolean;
} {
  const omitted = group.members.length > MAX_NODES_PER_ACTION;
  const kept = group.members.slice(0, MAX_NODES_PER_ACTION);
  const nodeIds = kept.map((member) => member.nodeId);
  return {
    omitted,
    action: {
      id: `assign:${group.sourceFolderId}:${group.targetFolderId}`,
      sourceFolderId: group.sourceFolderId,
      sourceFolderTitle: group.sourceFolderTitle,
      target: {
        type: 'existing',
        folderId: group.targetFolderId,
        title: group.targetTitle,
      },
      nodeIds,
      count: nodeIds.length,
      reason: `Title/host overlap with "${group.targetTitle}".`,
      confidence: minimumConfidence(kept),
    },
  };
}

export function planAssignExisting(input: OrganizePlannerInput): OrganizePlannerOutput {
  const ranked = [...assignExistingGroups(input)].sort(rankGroups);
  const truncatedByActionCap = ranked.length > MAX_ACTIONS;
  const keptGroups = ranked.slice(0, MAX_ACTIONS);
  const actions: OrganizePlanAction[] = [];
  let truncated = truncatedByActionCap;
  for (const group of keptGroups) {
    const { action, omitted } = toAction(group);
    if (omitted) truncated = true;
    actions.push(action);
  }
  return {
    plannerId: ASSIGN_EXISTING_PLANNER_ID,
    truncated,
    actions,
  };
}

export const assignExistingPlanner: OrganizePlanner = {
  id: ASSIGN_EXISTING_PLANNER_ID,
  plan: async (input) => planAssignExisting(input),
};
