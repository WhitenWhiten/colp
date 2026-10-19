import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { exclusionIds, isSubscriptionExcluded, personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { automationDatabase } from '../automation/indexeddb-store.js';
import type { BrowserRuleResponse, BrowserRunCommand, BrowserRunView } from '../automation/messages.js';
import { flattenList } from '../automation/rule-list-flatten.js';
import { planRun, RUN_PREVIEW_TTL_MS, topFolders, type RunPlan, type RunTreeNode } from '../automation/run-once.js';
import { browserRuleStore, nativeFolderLookup } from './automation-browser.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * Run once and Undo in the worker (doc 17 §6.4, R16): a preview of one folder is kept for 15 minutes,
 * Apply moves only what it listed, and only while the list is the one it was made from; each run keeps
 * a journal, and Undo moves back only what is still where the run left it. Moves go through the
 * personal-bookmark guard, so a subscription's folders are never touched. Nothing here needs an account;
 * moves in a synced folder reach the server as the Owner's own moves, with no automation receipt.
 */
export const RUN_PREVIEW_KEY = 'known.automation.browserRunPreview.v1';
export const RUNS_KEY = 'known.automation.browserRuns.v1';
const RUN_KEEP = 10, JOURNAL_EVERY = 20, ID = /^[\w-]{1,128}$/u;

interface StoredPreview extends RunPlan {
  readonly previewId: string;
  readonly listRevision: number;
  readonly contentVersions: Readonly<Record<string, string>>;
  readonly scopeNativeId: string;
  readonly scopeTitle: string;
  readonly expiresAt: number;
}
interface JournalItem {
  readonly nativeId: string;
  readonly fromParentId: string;
  readonly fromIndex: number;
  readonly toParentId: string;
  readonly state: 'moved' | 'skipped' | 'undone';
  /** Why the run left it alone. */
  readonly reason?: 'missing' | 'movedMeanwhile' | 'failed';
  /** Why Undo left a moved bookmark where it is. */
  readonly kept?: 'missing' | 'changedSince' | 'failed';
}
export interface RunJournal {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly listRevision: number;
  readonly scopeNativeId: string;
  readonly scopeTitle: string;
  readonly undoneAt: number | null;
  readonly items: readonly JournalItem[];
}

const area = () => automationDatabase().area();
let lane: Promise<unknown> = Promise.resolve(), running: string | null = null;
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
async function journals(): Promise<RunJournal[]> {
  const value = await area().get(RUNS_KEY);
  return (Array.isArray(value) ? value : []).filter((item): item is RunJournal => record(item) && typeof item.runId === 'string'
    && ID.test(item.runId) && typeof item.startedAt === 'number' && Array.isArray(item.items));
}
async function keep(journal: RunJournal): Promise<void> {
  const rest = (await journals()).filter((item) => item.runId !== journal.runId);
  await area().set(RUNS_KEY, [journal, ...rest].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUN_KEEP));
}
const sameVersions = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
const node = async (nativeId: string) => (await chrome.bookmarks.get(nativeId).catch(() => []))[0] ?? null;

async function destinationAllowed(nativeId: string): Promise<boolean> {
  try { await assertBookmarkFolderAllowed(nativeId); return !await isSubscriptionExcluded(nativeId); } catch { return false; }
}

async function preview(scopeNativeId: string): Promise<BrowserRuleResponse> {
  const scope = await node(scopeNativeId);
  if (!scope || scope.url !== undefined) return { ok: false, error: 'notFound' };
  if (!await destinationAllowed(scopeNativeId)) return { ok: false, error: 'excluded' };
  const list = await browserRuleStore().load(), flat = flattenList(list);
  if (flat.stopped) return { ok: false, error: 'listOff' };
  const [tree, excluded] = await Promise.all([chrome.bookmarks.getSubTree(scopeNativeId), exclusionIds()]);
  const now = Date.now();
  const plan = await planRun(tree[0] as RunTreeNode, flat, excluded, { lookup: nativeFolderLookup, destinationAllowed }, now);
  const stored: StoredPreview = { ...plan, previewId: crypto.randomUUID(), listRevision: flat.revision, contentVersions: flat.contentVersions,
    scopeNativeId, scopeTitle: scope.title, expiresAt: now + RUN_PREVIEW_TTL_MS };
  // One preview at a time: a new one replaces the last.
  await area().set(RUN_PREVIEW_KEY, plan.tooMany ? null : stored);
  return { ok: true, run: { previewId: stored.previewId, expiresAt: stored.expiresAt, scope: { nativeId: scopeNativeId, title: scope.title },
    counted: plan.counted, tooMany: plan.tooMany, moves: plan.moves.length, unchanged: plan.unchanged, kept: plan.kept, unmatched: plan.unmatched,
    blocked: plan.blocked.length, excludedFolders: plan.excludedFolders, topFolders: topFolders(plan.moves),
    examples: plan.moves.slice(0, 5).map((move) => ({ title: move.title, url: move.url, to: move.toTitle })) } };
}

async function apply(previewId: string): Promise<BrowserRuleResponse> {
  const stored = await area().get(RUN_PREVIEW_KEY) as StoredPreview | null | undefined;
  if (!record(stored) || stored.previewId !== previewId || stored.expiresAt < Date.now()) return { ok: false, error: 'expired' };
  await area().set(RUN_PREVIEW_KEY, null);
  // The run is the previewed list's run: a list that moved on since is previewed again (RS-08.4).
  const flat = flattenList(await browserRuleStore().load());
  if (flat.revision !== stored.listRevision || !sameVersions(flat.contentVersions, stored.contentVersions)) return { ok: false, error: 'changed' };
  let journal: RunJournal = { runId: crypto.randomUUID(), startedAt: Date.now(), finishedAt: null, listRevision: stored.listRevision,
    scopeNativeId: stored.scopeNativeId, scopeTitle: stored.scopeTitle, undoneAt: null, items: [] };
  running = journal.runId;
  try {
    await keep(journal);
    const items: JournalItem[] = [];
    for (const [index, move] of stored.moves.entries()) {
      const current = await node(move.nativeId);
      const base = { nativeId: move.nativeId, fromParentId: move.fromParentId, fromIndex: current?.index ?? 0, toParentId: move.toParentId };
      if (!current) items.push({ ...base, state: 'skipped', reason: 'missing' });
      else if (current.parentId !== move.fromParentId) items.push({ ...base, state: 'skipped', reason: 'movedMeanwhile' });
      else {
        try { await personalBookmarks.move(move.nativeId, { parentId: move.toParentId }); items.push({ ...base, state: 'moved' }); }
        catch { items.push({ ...base, state: 'skipped', reason: 'failed' }); }
      }
      if (index % JOURNAL_EVERY === JOURNAL_EVERY - 1) { journal = { ...journal, items: [...items] }; await keep(journal); }
    }
    journal = { ...journal, items, finishedAt: Date.now() };
    await keep(journal);
  } finally { running = null; }
  const count = (state: JournalItem['state'], reason?: JournalItem['reason']) => journal.items.filter((item) => item.state === state && (!reason || item.reason === reason)).length;
  return { ok: true, result: { runId: journal.runId, moved: count('moved'), skipped: count('skipped') - count('skipped', 'missing'), missing: count('skipped', 'missing') } };
}

async function undo(runId: string): Promise<BrowserRuleResponse> {
  const journal = (await journals()).find((item) => item.runId === runId);
  if (!journal) return { ok: false, error: 'notFound' };
  const items = [...journal.items];
  let moved = 0, skipped = 0, missing = 0;
  // Last moved first, so each bookmark goes back to its old place among its old neighbours.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.state !== 'moved' || item.kept) continue;
    const current = await node(item.nativeId);
    if (!current) { items[index] = { ...item, kept: 'missing' }; missing += 1; continue; }
    if (current.parentId !== item.toParentId) { items[index] = { ...item, kept: 'changedSince' }; skipped += 1; continue; }
    try {
      // Its old place among its neighbours, when that place still exists.
      await personalBookmarks.move(item.nativeId, { parentId: item.fromParentId, index: item.fromIndex })
        .catch(() => personalBookmarks.move(item.nativeId, { parentId: item.fromParentId }));
      items[index] = { ...item, state: 'undone' }; moved += 1;
    } catch { items[index] = { ...item, kept: 'failed' }; skipped += 1; }
  }
  await keep({ ...journal, items, undoneAt: Date.now() });
  return { ok: true, result: { runId, moved, skipped, missing } };
}

export function handleRunCommand(command: BrowserRunCommand): Promise<BrowserRuleResponse> {
  return exclusive(async () => {
    if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
    switch (command.kind) {
      case 'known.automation.browser.runPreview': return preview(command.scopeNativeId);
      case 'known.automation.browser.runApply': return apply(command.previewId);
      case 'known.automation.browser.runUndo': return undo(command.runId);
    }
  });
}

/** The last runs for Options, newest first: what each moved, and whether Undo still has anything to move back. */
export async function browserRunViews(): Promise<BrowserRunView[]> {
  return (await journals()).map((journal) => {
    const count = (state: JournalItem['state']) => journal.items.filter((item) => item.state === state).length;
    const state = journal.undoneAt ? 'undone' : journal.finishedAt !== null ? 'done' : journal.runId === running ? 'running' : 'interrupted';
    return { runId: journal.runId, startedAt: journal.startedAt, finishedAt: journal.finishedAt, scopeTitle: journal.scopeTitle, state,
      moved: count('moved') + count('undone'), skipped: count('skipped'), undone: count('undone'), undoneAt: journal.undoneAt,
      canUndo: state !== 'running' && journal.items.some((item) => item.state === 'moved' && !item.kept) };
  });
}
