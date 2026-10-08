/**
 * Heuristic host-cluster Organize planner (`heuristic.v1.host_cluster`).
 * Pure: no I/O and no non-deterministic choice. Runs H1 assign-existing first,
 * then buckets residual inbox bookmarks by raw hostname (not Jaccard host tokens).
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
  assignExistingGroups,
  assignedNodeIdSet,
  planAssignExisting,
} from './organize-planner-assign-existing.js';
import {
  bookmarkTokenSet,
  isInboxFolderTitle,
  normalizeInboxTitle,
  suggestFolderTitle,
} from './organize-planner-tokens.js';

export const HOST_CLUSTER_PLANNER_ID = 'heuristic.v1.host_cluster';

const MIN_CONFIDENCE = 40;
const MIN_GROUP_SIZE = 2;
const MAX_ACTIONS = 20;
const MAX_NODES_PER_ACTION = 50;
const HOST_CLUSTER_CONFIDENCE = 80;

type HostClusterGroup = {
  sourceFolderId: string;
  sourceFolderTitle: string;
  host: string;
  members: OrganizePlannerBookmark[];
};

function compareOpaqueId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupKey(sourceFolderId: string, host: string): string {
  return `${sourceFolderId}\0${host}`;
}

/**
 * Bucket key: WHATWG hostname, one leading `www.` stripped, full remainder kept.
 * Illegal URLs return undefined (skip; do not throw).
 */
function hostBucketKey(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.length === 0) return undefined;
    const stripped = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
    return stripped.length > 0 ? stripped : undefined;
  } catch {
    return undefined;
  }
}

function secondLevelLabel(host: string): string {
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length < 2) return '';
  return labels[labels.length - 2] ?? '';
}

function isAllLowercaseAscii(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) return false;
    if (code >= 65 && code <= 90) return false;
  }
  return true;
}

function titleFromSecondLevelLabel(label: string): string {
  if (label.length === 0) return '';
  if (!isAllLowercaseAscii(label)) return label;
  if (label === 'github') return 'GitHub';
  return `${label.slice(0, 1).toLocaleUpperCase('und')}${label.slice(1)}`;
}

function folderTitleForHostGroup(
  host: string,
  members: readonly OrganizePlannerBookmark[],
): string {
  const title = titleFromSecondLevelLabel(secondLevelLabel(host));
  if (title.length === 0 || isInboxFolderTitle(title)) {
    const tokens = new Set<string>();
    for (const bookmark of members) {
      for (const token of bookmarkTokenSet(bookmark)) tokens.add(token);
    }
    return suggestFolderTitle(tokens, members);
  }
  return title;
}

function collidingRootFolder(
  title: string,
  input: OrganizePlannerInput,
  inboxIds: ReadonlySet<string>,
): OrganizePlannerFolder | undefined {
  const normalized = normalizeInboxTitle(title);
  let best: OrganizePlannerFolder | undefined;
  for (const folder of input.folders) {
    if (folder.parentId !== input.rootId) continue;
    if (folder.id === input.rootId) continue;
    if (inboxIds.has(folder.id)) continue;
    if (isInboxFolderTitle(folder.title)) continue;
    if (normalizeInboxTitle(folder.title) !== normalized) continue;
    if (best === undefined || folder.id < best.id) best = folder;
  }
  return best;
}

function rankHostGroups(left: HostClusterGroup, right: HostClusterGroup): number {
  const source = compareOpaqueId(left.sourceFolderId, right.sourceFolderId);
  if (source !== 0) return source;
  return compareOpaqueId(left.host, right.host);
}

function toHostAction(
  group: HostClusterGroup,
  input: OrganizePlannerInput,
  inboxIds: ReadonlySet<string>,
): { action: OrganizePlanAction; omitted: boolean } | undefined {
  if (HOST_CLUSTER_CONFIDENCE < MIN_CONFIDENCE) return undefined;
  const sorted = [...group.members].sort((left, right) =>
    compareOpaqueId(left.id, right.id),
  );
  const omitted = sorted.length > MAX_NODES_PER_ACTION;
  const kept = sorted.slice(0, MAX_NODES_PER_ACTION);
  const nodeIds = kept.map((bookmark) => bookmark.id);
  const title = folderTitleForHostGroup(group.host, kept);
  const collision = collidingRootFolder(title, input, inboxIds);
  const target = collision
    ? { type: 'existing' as const, folderId: collision.id, title: collision.title }
    : { type: 'create_folder' as const, parentId: input.rootId, title };
  return {
    omitted,
    action: {
      id: `host:${group.sourceFolderId}:${group.host}`,
      sourceFolderId: group.sourceFolderId,
      sourceFolderTitle: group.sourceFolderTitle,
      target,
      nodeIds,
      count: nodeIds.length,
      reason: `Same host "${group.host}" (${nodeIds.length} bookmarks).`,
      confidence: HOST_CLUSTER_CONFIDENCE,
    },
  };
}

function residualHostGroups(
  input: OrganizePlannerInput,
  assigned: ReadonlySet<string>,
): HostClusterGroup[] {
  const inboxIds = new Set(input.inboxFolderIds);
  const folderById = new Map<string, OrganizePlannerFolder>();
  for (const folder of input.folders) {
    if (!folderById.has(folder.id)) folderById.set(folder.id, folder);
  }

  const accumulators = new Map<string, HostClusterGroup>();
  for (const bookmark of input.bookmarks) {
    if (bookmark.parentId === input.rootId) continue;
    if (!inboxIds.has(bookmark.parentId)) continue;
    if (assigned.has(bookmark.id)) continue;
    const host = hostBucketKey(bookmark.url);
    if (host === undefined) continue;
    const sourceFolderId = bookmark.parentId;
    const key = groupKey(sourceFolderId, host);
    let group = accumulators.get(key);
    if (group === undefined) {
      group = {
        sourceFolderId,
        sourceFolderTitle: folderById.get(sourceFolderId)?.title ?? '',
        host,
        members: [],
      };
      accumulators.set(key, group);
    }
    group.members.push(bookmark);
  }

  const groups: HostClusterGroup[] = [];
  for (const group of accumulators.values()) {
    if (group.members.length < MIN_GROUP_SIZE) continue;
    groups.push(group);
  }
  return groups;
}

/**
 * Full `heuristic.v1.host_cluster` plan: H1 assign-existing actions first,
 * then residual same-host create_folder (or existing on title collision).
 *
 * Residual membership uses {@link assignedNodeIdSet}({@link assignExistingGroups})
 * so 50-node leftovers stay assigned and are not host-clustered again.
 */
export function planHostCluster(input: OrganizePlannerInput): OrganizePlannerOutput {
  const existing = planAssignExisting(input);
  const assigned = assignedNodeIdSet(assignExistingGroups(input));
  const inboxIds = new Set(input.inboxFolderIds);
  const ranked = residualHostGroups(input, assigned).sort(rankHostGroups);

  const remainingSlots = Math.max(0, MAX_ACTIONS - existing.actions.length);
  const truncatedByActionCap = ranked.length > remainingSlots;
  const keptGroups = ranked.slice(0, remainingSlots);
  const hostActions: OrganizePlanAction[] = [];
  let truncated = existing.truncated || truncatedByActionCap;
  for (const group of keptGroups) {
    const built = toHostAction(group, input, inboxIds);
    if (built === undefined) continue;
    if (built.omitted) truncated = true;
    hostActions.push(built.action);
  }

  return {
    plannerId: HOST_CLUSTER_PLANNER_ID,
    truncated,
    actions: [...existing.actions, ...hostActions],
  };
}

export const hostClusterPlanner: OrganizePlanner = {
  id: HOST_CLUSTER_PLANNER_ID,
  plan: async (input) => planHostCluster(input),
};
