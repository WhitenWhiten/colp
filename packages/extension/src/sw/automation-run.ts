import { createRunFolderPositions } from '../automation/run-folder-positions.js';
import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { exclusionIds, isSubscriptionExcluded, personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { createRunJournalStore, matchesRunPosition, settleRunIntent, type JournalItem, type RunJournal } from '../automation/run-journal.js';
export { RUNS_KEY } from '../automation/run-journal.js';
export type { RunJournal } from '../automation/run-journal.js';
import { record } from '../automation/closed-value.js';
import { automationDatabase } from '../automation/indexeddb-store.js';
import { createLane } from '../automation/lane.js';
import type { BrowserRuleResponse, BrowserRunCommand, BrowserRunView } from '../automation/messages.js';
import { planRun, RUN_PREVIEW_TTL_MS, topFolders, type RunPlan, type RunTreeNode } from '../automation/run-once.js';
import { currentFlat, nativeFolderLookup } from './automation-browser.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * Run once and Undo in the worker (doc 17 §6.4, R16): a preview of one folder is kept for 15 minutes,
 * Apply moves only what it listed, and only while the list is the one it was made from; each run keeps
 * a journal, and Undo moves back only what is still where the run left it. Moves go through the
 * personal-bookmark guard, so a subscription's folders are never touched. Nothing here needs an account;
 * moves in a synced folder reach the server as the Owner's own moves, with no automation receipt.
 */
export const RUN_PREVIEW_KEY = 'known.automation.browserRunPreview.v1';

interface StoredPreview extends RunPlan {
  readonly previewId: string;
  readonly listRevision: number;
  readonly contentVersions: Readonly<Record<string, string>>;
  readonly scopeNativeId: string;
  readonly scopeTitle: string;
  readonly expiresAt: number;
}
const area = () => automationDatabase().area();
const journalStore = () => createRunJournalStore(area());
const exclusive = createLane();
let running: string | null = null;
const sameVersions = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
const node = async (nativeId: string) => {
  try { return (await chrome.bookmarks.get(nativeId))[0] ?? null; }
  catch (error) { if (classifyBookmarkApiFailure(error) === 'not_found') return null; throw error; }
};

async function destinationAllowed(nativeId: string): Promise<boolean> {
  try { await assertBookmarkFolderAllowed(nativeId); return !await isSubscriptionExcluded(nativeId); } catch { return false; }
}

async function preview(scopeNativeId: string): Promise<BrowserRuleResponse> {
  const scope = await node(scopeNativeId);
  if (!scope || scope.url !== undefined) return { ok: false, error: 'notFound' };
  if (!await destinationAllowed(scopeNativeId)) return { ok: false, error: 'excluded' };
  const flat = await currentFlat();
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

async function apply(previewId: string, assertCurrent: () => Promise<void>): Promise<BrowserRuleResponse> {
  const stored = await area().get(RUN_PREVIEW_KEY) as StoredPreview | null | undefined;
  if (!record(stored) || stored.previewId !== previewId || stored.expiresAt < Date.now()) return { ok: false, error: 'expired' };
  await area().set(RUN_PREVIEW_KEY, null);
  // The run is the previewed list's run: a list that moved on since is previewed again (RS-08.4).
  const flat = await currentFlat();
  if (flat.revision !== stored.listRevision || !sameVersions(flat.contentVersions, stored.contentVersions)) return { ok: false, error: 'changed' };
  const journal: RunJournal = { runId: crypto.randomUUID(), startedAt: Date.now(), finishedAt: null, listRevision: stored.listRevision,
    scopeNativeId: stored.scopeNativeId, scopeTitle: stored.scopeTitle, undoneAt: null, items: [] };
  const log = journalStore(), items: JournalItem[] = [];
  const positions = createRunFolderPositions();
  running = journal.runId;
  try {
    await log.create(journal, stored.moves.length);
    for (const [ordinal, move] of stored.moves.entries()) {
      await assertCurrent();
      const current = await node(move.nativeId);
      let item: JournalItem = { ordinal, nativeId: move.nativeId, fromParentId: move.fromParentId,
        fromIndex: current?.index ?? 0, toParentId: move.toParentId, title: move.title, url: move.url, state: 'moving' };
      if (!current) item = { ...item, state: 'skipped', reason: 'missing' };
      else if (current.parentId !== move.fromParentId || current.title !== move.title || current.url !== move.url)
        item = { ...item, state: 'skipped', reason: 'movedMeanwhile' };
      else {
        item = { ...item, toIndex: await positions.count(move.toParentId) };
        // A worker stop before or after the native call leaves an intent that Undo can inspect.
        await log.write(journal.runId, item);
        const settlePosition = positions.expectMove(current, { parentId: move.toParentId, index: item.toIndex! });
        await assertCurrent();
        try { await personalBookmarks.move(move.nativeId, { parentId: move.toParentId, index: item.toIndex }); }
        catch { /* A rejected native call can still have applied; inspect its effect before deciding. */ }
        const observed = await node(move.nativeId); settlePosition(observed);
        item = settleRunIntent(item, observed);
      }
      await log.write(journal.runId, item);
      items.push(item);
    }
    await log.finish(journal.runId, { finishedAt: Date.now() });
  } finally { positions.dispose(); running = null; }
  const count = (state: JournalItem['state'], reason?: JournalItem['reason']) => items.filter((item) => item.state === state && (!reason || item.reason === reason)).length;
  return { ok: true, result: { runId: journal.runId, moved: count('moved'), skipped: count('skipped') - count('skipped', 'missing'), missing: count('skipped', 'missing') } };
}

async function undo(runId: string, assertCurrent: () => Promise<void>): Promise<BrowserRuleResponse> {
  const log = journalStore(), journal = (await log.list()).find((item) => item.runId === runId);
  if (!journal) return { ok: false, error: 'notFound' };
  const positions = createRunFolderPositions();
  try {
    let moved = 0, skipped = 0, missing = 0;
    for (const original of [...journal.items].reverse()) {
      await assertCurrent();
      let item = original;
      const current = await node(item.nativeId);
      if (item.state === 'moving' || item.state === 'undoing') {
        item = settleRunIntent(item, current);
        await log.write(runId, item);
      }
      if (item.state !== 'moved' || item.kept) continue;
      if (!current) { await log.write(runId, { ...item, kept: 'missing' }); missing += 1; continue; }
      if (!matchesRunPosition(item, current, item.toParentId, item.toIndex)) {
        await log.write(runId, { ...item, kept: 'changedSince' }); skipped += 1; continue;
      }
      let undoIndex: number;
      try { undoIndex = Math.min(item.fromIndex, await positions.count(item.fromParentId)); }
      catch { await log.write(runId, { ...item, kept: 'failed' }); skipped += 1; continue; }
      item = { ...item, state: 'undoing', undoIndex };
      await log.write(runId, item);
      const settlePosition = positions.expectMove(current, { parentId: item.fromParentId, index: undoIndex });
      await assertCurrent();
      try { await personalBookmarks.move(item.nativeId, { parentId: item.fromParentId, index: undoIndex }); }
      catch { /* Settle the durable intent from the observed location, including lost native replies. */ }
      const observed = await node(item.nativeId); settlePosition(observed);
      item = settleRunIntent(item, observed);
      await log.write(runId, item);
      if (item.state === 'undone') moved += 1; else skipped += 1;
    }
    await log.finish(runId, { undoneAt: Date.now() });
    return { ok: true, result: { runId, moved, skipped, missing } };
  } finally { positions.dispose(); }
}

export function handleRunCommand(command: BrowserRunCommand, assertCurrent: () => Promise<void> = async () => {}): Promise<BrowserRuleResponse> {
  return exclusive(async () => {
    await assertCurrent();
    if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
    switch (command.kind) {
      case 'known.automation.browser.runPreview': return preview(command.scopeNativeId);
      case 'known.automation.browser.runApply': return apply(command.previewId, assertCurrent);
      case 'known.automation.browser.runUndo': return undo(command.runId, assertCurrent);
    }
  });
}

/** The last runs for Options, newest first: what each moved, and whether Undo still has anything to move back. */
export async function browserRunViews(): Promise<BrowserRunView[]> {
  return (await journalStore().list()).map((journal) => {
    const count = (state: JournalItem['state']) => journal.items.filter((item) => item.state === state).length;
    const state = journal.undoneAt ? 'undone' : journal.finishedAt !== null ? 'done' : journal.runId === running ? 'running' : 'interrupted';
    return { runId: journal.runId, startedAt: journal.startedAt, finishedAt: journal.finishedAt, scopeTitle: journal.scopeTitle, state,
      moved: count('moved') + count('undone'), skipped: count('skipped'), undone: count('undone'), undoneAt: journal.undoneAt,
      canUndo: state !== 'running' && journal.items.some((item) => ['moving', 'moved', 'undoing'].includes(item.state) && !item.kept) };
  });
}
