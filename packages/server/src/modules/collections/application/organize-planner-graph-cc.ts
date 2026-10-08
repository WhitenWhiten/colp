import { createHash } from 'node:crypto';
import type {
  OrganizePlanAction,
  OrganizePlanTarget,
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
  normalizeInboxTitle,
  suggestFolderTitle,
} from './organize-planner-tokens.js';

const PLANNER_ID = 'heuristic.v1.graph_cc' as const;

const EDGE_JACCARD = 50;
const FOLDER_JACCARD = 40;
const MIN_CONFIDENCE = 40;
const MIN_COMPONENT_SIZE = 2;
const MAX_ACTIONS = 20;
const MAX_NODES_PER_ACTION = 50;

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function meanPairwiseJaccard(tokenSets: readonly ReadonlySet<string>[]): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      sum += jaccard(tokenSets[i]!, tokenSets[j]!);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : Math.round(sum / pairs);
}

function meanVsFolder(tokenSets: readonly ReadonlySet<string>[], folderTitle: string): number {
  const folderTokens = folderTokenSet(folderTitle);
  if (tokenSets.length === 0) return 0;
  const sum = tokenSets.reduce((acc, tokens) => acc + jaccard(tokens, folderTokens), 0);
  return sum / tokenSets.length;
}

function stableActionId(input: {
  readonly sourceFolderId: string;
  readonly target: OrganizePlanTarget;
  readonly nodeIds: readonly string[];
}): string {
  const targetKey = input.target.type === 'existing'
    ? `existing:${input.target.folderId}`
    : `create_folder:${input.target.parentId}:${input.target.title}`;
  return createHash('sha256')
    .update([PLANNER_ID, input.sourceFolderId, targetKey, ...input.nodeIds].join('\n'))
    .digest('hex');
}

function isAssignableFolder(
  folder: OrganizePlannerFolder,
  input: OrganizePlannerInput,
  sourceFolderId: string,
  inboxFolderIds: ReadonlySet<string>,
): boolean {
  return folder.id !== input.rootId
    && folder.id !== sourceFolderId
    && !inboxFolderIds.has(folder.id)
    && !isInboxFolderTitle(folder.title);
}

function connectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    visited.add(start);
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    component.sort(compareId);
    components.push(component);
  }
  components.sort((left, right) => compareId(left[0] ?? '', right[0] ?? ''));
  return components;
}

function resolveTarget(
  members: readonly OrganizePlannerBookmark[],
  memberTokens: readonly ReadonlySet<string>[],
  sourceFolderId: string,
  input: OrganizePlannerInput,
  folders: readonly OrganizePlannerFolder[],
  inboxFolderIds: ReadonlySet<string>,
): { readonly target: OrganizePlanTarget; readonly confidence: number; readonly reason: string } {
  let bestFolder: OrganizePlannerFolder | undefined;
  let bestMean = -1;
  for (const folder of folders) {
    if (!isAssignableFolder(folder, input, sourceFolderId, inboxFolderIds)) continue;
    const mean = meanVsFolder(memberTokens, folder.title);
    if (mean > bestMean) {
      bestMean = mean;
      bestFolder = folder;
    }
  }
  if (bestFolder !== undefined && bestMean >= FOLDER_JACCARD) {
    return {
      target: { type: 'existing', folderId: bestFolder.id, title: bestFolder.title },
      confidence: Math.round(bestMean),
      reason: `Title/host overlap with "${bestFolder.title}".`,
    };
  }

  const union = new Set<string>();
  for (const tokens of memberTokens) {
    for (const token of tokens) union.add(token);
  }
  const title = suggestFolderTitle(union, members);
  const normalized = normalizeInboxTitle(title);
  const colliding = folders
    .filter((folder) => (
      folder.parentId === input.rootId
      && isAssignableFolder(folder, input, sourceFolderId, inboxFolderIds)
      && normalizeInboxTitle(folder.title) === normalized
    ))
    .sort((left, right) => compareId(left.id, right.id));
  const pairwise = meanPairwiseJaccard(memberTokens);
  const hit = colliding[0];
  if (hit !== undefined) {
    return {
      target: { type: 'existing', folderId: hit.id, title: hit.title },
      confidence: pairwise,
      reason: `Title/host overlap with "${hit.title}".`,
    };
  }
  return {
    target: { type: 'create_folder', parentId: input.rootId, title },
    confidence: pairwise,
    reason: `Shared title/host tokens (${members.length} bookmarks).`,
  };
}

export function planGraphCc(input: OrganizePlannerInput): OrganizePlannerOutput {
  const inboxFolderIds = new Set(input.inboxFolderIds);
  const byId = new Map<string, OrganizePlannerBookmark>();
  for (const bookmark of input.bookmarks) {
    if (!inboxFolderIds.has(bookmark.parentId) || bookmark.parentId === input.rootId) continue;
    if (!byId.has(bookmark.id)) byId.set(bookmark.id, bookmark);
  }

  const ids = [...byId.keys()].sort(compareId);
  const tokenById = new Map<string, ReadonlySet<string>>();
  for (const id of ids) {
    tokenById.set(id, bookmarkTokenSet(byId.get(id)!));
  }

  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (let i = 0; i < ids.length; i += 1) {
    const leftId = ids[i]!;
    const leftTokens = tokenById.get(leftId)!;
    for (let j = i + 1; j < ids.length; j += 1) {
      const rightId = ids[j]!;
      if (jaccard(leftTokens, tokenById.get(rightId)!) < EDGE_JACCARD) continue;
      adjacency.get(leftId)!.push(rightId);
      adjacency.get(rightId)!.push(leftId);
    }
  }
  for (const neighbors of adjacency.values()) neighbors.sort(compareId);

  const folderById = new Map<string, OrganizePlannerFolder>();
  for (const folder of input.folders) {
    if (!folderById.has(folder.id)) folderById.set(folder.id, folder);
  }
  const folders = [...folderById.values()].sort((left, right) => compareId(left.id, right.id));

  const actions: OrganizePlanAction[] = [];
  let truncated = false;

  for (const component of connectedComponents(ids, adjacency)) {
    if (component.length < MIN_COMPONENT_SIZE) continue;
    const grouped = new Map<string, OrganizePlannerBookmark[]>();
    for (const id of component) {
      const bookmark = byId.get(id)!;
      const group = grouped.get(bookmark.parentId);
      if (group) group.push(bookmark);
      else grouped.set(bookmark.parentId, [bookmark]);
    }
    const sourceFolderIds = [...grouped.keys()].sort(compareId);
    for (const sourceFolderId of sourceFolderIds) {
      let members = grouped.get(sourceFolderId)!;
      members.sort((left, right) => compareId(left.id, right.id));
      if (members.length < MIN_COMPONENT_SIZE) continue;
      if (members.length > MAX_NODES_PER_ACTION) {
        truncated = true;
        members = members.slice(0, MAX_NODES_PER_ACTION);
      }
      const memberTokens = members.map((bookmark) => tokenById.get(bookmark.id)!);
      const resolved = resolveTarget(members, memberTokens, sourceFolderId, input, folders, inboxFolderIds);
      if (resolved.confidence < MIN_CONFIDENCE) continue;
      const nodeIds = members.map((bookmark) => bookmark.id);
      const actionWithoutId = {
        sourceFolderId,
        sourceFolderTitle: folderById.get(sourceFolderId)?.title ?? '',
        target: resolved.target,
        nodeIds,
        count: nodeIds.length,
        reason: resolved.reason,
        confidence: resolved.confidence,
      };
      actions.push({
        id: stableActionId(actionWithoutId),
        ...actionWithoutId,
      });
    }
  }

  actions.sort((left, right) => (
    compareId(left.nodeIds[0] ?? '', right.nodeIds[0] ?? '')
    || compareId(left.sourceFolderId, right.sourceFolderId)
    || compareId(left.id, right.id)
  ));

  if (actions.length > MAX_ACTIONS) {
    truncated = true;
    return {
      plannerId: PLANNER_ID,
      truncated,
      actions: actions.slice(0, MAX_ACTIONS),
    };
  }

  return { plannerId: PLANNER_ID, truncated, actions };
}

export const graphCcPlanner: OrganizePlanner = {
  id: PLANNER_ID,
  plan(input) {
    return Promise.resolve(planGraphCc(input));
  },
};
