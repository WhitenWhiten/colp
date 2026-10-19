import type { SnapshotStateArea } from './bundle-store.js';
import { record } from './closed-value.js';

export const RUNS_KEY = 'known.automation.browserRuns.v1';
const ITEM_PREFIX = 'known.automation.browserRunItem.v1:';
const RUN_KEEP = 10;
export interface JournalItem {
  readonly ordinal: number;
  readonly nativeId: string;
  readonly fromParentId: string;
  readonly fromIndex: number;
  readonly toParentId: string;
  readonly title?: string;
  readonly url?: string;
  readonly toIndex?: number;
  readonly undoIndex?: number;
  readonly state: 'moving' | 'moved' | 'undoing' | 'skipped' | 'undone';
  readonly reason?: 'missing' | 'movedMeanwhile' | 'failed';
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
type Header = Omit<RunJournal, 'items'> & { readonly itemCount?: number; readonly items?: readonly JournalItem[] };
const itemKey = (id: string, ordinal: number) => `${ITEM_PREFIX}${id}:${ordinal}`;

/** Each move has its own durable row: writing an intent never rewrites the complete bookmark run. */
export function createRunJournalStore(area: SnapshotStateArea) {
  async function headers(): Promise<Header[]> {
    const value = await area.get(RUNS_KEY);
    return (Array.isArray(value) ? value : []).filter((row): row is Header => record(row)
      && typeof row.runId === 'string' && /^[\w-]{1,128}$/u.test(row.runId) && typeof row.startedAt === 'number'
      && (Array.isArray(row.items) || Number.isInteger(row.itemCount) && Number(row.itemCount) >= 0 && Number(row.itemCount) <= 20_000));
  }
  return {
    async list(): Promise<RunJournal[]> {
      const rows = await headers();
      return Promise.all(rows.map(async (header) => {
        const keys = Array.from({ length: header.itemCount ?? 0 }, (_, i) => itemKey(header.runId, i));
        const values = await area.getMany(keys);
        const items = header.items?.map((item, ordinal) => ({ ...item, ordinal }))
          ?? keys.flatMap((key, ordinal) => record(values[key]) ? [{ ...values[key], ordinal } as unknown as JournalItem] : []);
        return { ...header, items };
      }));
    },
    async create(journal: RunJournal, itemCount: number): Promise<void> {
      const { items: _items, ...header } = journal;
      const rows = [ { ...header, itemCount }, ...await headers() ].sort((a, b) => b.startedAt - a.startedAt);
      const deletes = rows.slice(RUN_KEEP).flatMap(row => Array.from({ length: row.itemCount ?? 0 }, (_, i) => itemKey(row.runId, i)));
      await area.commit({ [RUNS_KEY]: rows.slice(0, RUN_KEEP) }, deletes);
    },
    async write(runId: string, item: JournalItem): Promise<void> {
      // Old journals have no content/position proof. Preserve their records, including refusal reasons.
      const rows = await headers(), header = rows.find(row => row.runId === runId);
      if (!header) throw new Error('run_journal_missing');
      if (header.items) {
        await area.set(RUNS_KEY, rows.map(row => row.runId === runId
          ? { ...row, items: header.items!.map((old, i) => i === item.ordinal ? item : old) } : row));
      } else await area.set(itemKey(runId, item.ordinal), item);
    },
    async finish(runId: string, patch: Pick<Partial<RunJournal>, 'finishedAt' | 'undoneAt'>): Promise<void> {
      await area.set(RUNS_KEY, (await headers()).map(row => row.runId === runId ? { ...row, ...patch } : row));
    },
  };
}

type Observation = { readonly parentId?: string; readonly index?: number; readonly title: string; readonly url?: string };
export function matchesRunPosition(item: JournalItem, node: Observation | null, parentId: string, index: number | undefined): boolean {
  return node !== null && typeof item.title === 'string' && typeof item.url === 'string' && index !== undefined
    && node.title === item.title && node.url === item.url && node.parentId === parentId && node.index === index;
}

/** Resolve an interrupted native call from its durable intent. Never repeat an unobserved move automatically. */
export function settleRunIntent(item: JournalItem, node: Observation | null): JournalItem {
  const undo = item.state === 'undoing';
  if (item.state !== 'moving' && !undo) return item;
  const atDestination = matchesRunPosition(item, node, item.toParentId, item.toIndex);
  const atOrigin = matchesRunPosition(item, node, item.fromParentId, undo ? item.undoIndex : item.fromIndex);
  if (undo) return atOrigin ? { ...item, state: 'undone' } : atDestination ? { ...item, state: 'moved' }
    : { ...item, state: 'moved', kept: node ? 'changedSince' : 'missing' };
  return atDestination ? { ...item, state: 'moved' }
    : { ...item, state: 'skipped', reason: !node ? 'missing' : atOrigin ? 'failed' : 'movedMeanwhile' };
}
