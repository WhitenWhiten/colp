import { normalizeUrl } from '@know-n/colp/automation';
import type { BrowserDecisionEntry } from '../capture/contracts.js';
import type { FolderLookup } from './browser-rules.js';
import { decideList } from './rule-list-decide.js';
import type { FlatList } from './rule-list-flatten.js';

/**
 * Run once (doc 17 §6.4, R16, RS-14): this browser's list over the bookmarks already in one folder,
 * planned here from a tree the caller read, and applied by the worker only after a second click. Each
 * bookmark is decided as a save the Owner did not direct (`explicit: false`); subtrees a bookmark
 * subscription manages or that are excluded are not entered; a bookmark already where its rule files
 * it is unchanged and not listed. Planning moves nothing and needs no account.
 */
export const RUN_LIMIT = 20_000;
export const RUN_PREVIEW_TTL_MS = 15 * 60_000;

export interface RunTreeNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly parentId?: string;
  readonly children?: readonly RunTreeNode[];
}
export type RunEntry = BrowserDecisionEntry;
export interface RunMove {
  readonly nativeId: string;
  readonly title: string;
  readonly url: string;
  readonly fromParentId: string;
  readonly toParentId: string;
  /** The destination's title at planning, for the preview's top folders. */
  readonly toTitle: string;
  readonly entry: RunEntry;
}
export interface RunBlocked { readonly nativeId: string; readonly reason: 'bindingUnavailable' | 'evaluation'; readonly entry: RunEntry }
export interface RunPlan {
  /** Bookmarks looked at, up to the limit. */
  readonly counted: number;
  /** More than `RUN_LIMIT` bookmarks are in scope: nothing is planned, a smaller folder is asked for. */
  readonly tooMany: boolean;
  readonly moves: readonly RunMove[];
  readonly blocked: readonly RunBlocked[];
  /** Already where their rule files them. */
  readonly unchanged: number;
  /** A rule keeps them where they are. */
  readonly kept: number;
  /** No rule matches, or the link is not a web page's. */
  readonly unmatched: number;
  /** Subtrees not entered: managed by a bookmark subscription, or excluded. */
  readonly excludedFolders: number;
}

export interface RunPorts {
  readonly lookup: FolderLookup;
  /** False for a destination a run must not file into (a subscription's folder, an unsupported root). */
  readonly destinationAllowed: (nativeId: string) => Promise<boolean>;
}

export async function planRun(root: RunTreeNode, flat: FlatList, excluded: ReadonlySet<string>, ports: RunPorts, now: number): Promise<RunPlan> {
  const bookmarks: RunTreeNode[] = [];
  let excludedFolders = 0, tooMany = false;
  const stack: RunTreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (excluded.has(node.id)) { excludedFolders += 1; continue; }
    if (node.url !== undefined) {
      if (bookmarks.length >= RUN_LIMIT) { tooMany = true; break; }
      bookmarks.push(node); continue;
    }
    // Children in the order the folder shows them, so the preview reads top to bottom.
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(node.children![index]!);
  }
  const empty = { counted: bookmarks.length, moves: [], blocked: [], unchanged: 0, kept: 0, unmatched: 0, excludedFolders };
  if (tooMany) return { ...empty, tooMany };
  const moves: RunMove[] = [], blocked: RunBlocked[] = [], allowed = new Map<string, boolean>();
  let unchanged = 0, kept = 0, unmatched = 0;
  for (const node of bookmarks) {
    if (normalizeUrl(node.url!).status !== 'available') { unmatched += 1; continue; }
    const { decision } = await decideList(flat.items, { url: node.url!, title: node.title, explicit: false }, ports.lookup, now);
    if (!decision) { unmatched += 1; continue; }
    const entry: RunEntry = { listRevision: flat.revision, ...decision.item.ref };
    if (decision.outcome === 'kept') { kept += 1; continue; }
    if (decision.outcome === 'blocked') { blocked.push({ nativeId: node.id, reason: decision.reason === 'evaluation' ? 'evaluation' : 'bindingUnavailable', entry }); continue; }
    const folder = decision.folder!;
    if (folder.nativeId === node.parentId) { unchanged += 1; continue; }
    if (!allowed.has(folder.nativeId)) allowed.set(folder.nativeId, !excluded.has(folder.nativeId) && await ports.destinationAllowed(folder.nativeId));
    if (!allowed.get(folder.nativeId)) { blocked.push({ nativeId: node.id, reason: 'bindingUnavailable', entry }); continue; }
    moves.push({ nativeId: node.id, title: node.title, url: node.url!, fromParentId: node.parentId ?? '', toParentId: folder.nativeId, toTitle: folder.title, entry });
  }
  return { ...empty, tooMany: false, moves, blocked, unchanged, kept, unmatched };
}

/** The destinations most moves go to, for the preview (largest first). */
export function topFolders(moves: readonly RunMove[], limit = 5): { readonly nativeId: string; readonly title: string; readonly count: number }[] {
  const counts = new Map<string, { nativeId: string; title: string; count: number }>();
  for (const move of moves) {
    const row = counts.get(move.toParentId) ?? { nativeId: move.toParentId, title: move.toTitle, count: 0 };
    row.count += 1; counts.set(move.toParentId, row);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, limit);
}
