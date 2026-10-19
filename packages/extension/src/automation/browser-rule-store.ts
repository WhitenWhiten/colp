import type { BrowserDecisionEntry } from '../capture/contracts.js';
import type { AutomationStateArea } from './bundle-store.js';

/**
 * The pages this browser's own rules (rule-list-store.ts) filed, for Options' recent activity, in the
 * automation store (indexeddb-store.ts) under a key of their own. Nothing here is ever sent anywhere,
 * and signing out leaves it in place.
 */
export const BROWSER_PLACEMENTS_KEY = 'known.automation.browserPlacements.v1';
const PLACEMENT_LIMIT = 20;

/** A page a browser rule filed here, for Options' recent activity. */
export interface BrowserPlacement {
  /** The capture id: logging the same save again changes nothing. */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly folder: string;
  readonly title: string;
  readonly url: string;
  readonly at: number;
  /**
   * The rule matched but the page stayed where it was saved (follow-up U6): `blocked`, the rule's folder was
   * not available; `keepHere`, the rule keeps pages where they are saved; `conflict`, before the ordered list,
   * two rules here wanted different folders. `folder` is then where the page is.
   */
  readonly kept?: 'conflict' | 'blocked' | 'keepHere';
  /** The list entry that decided (doc 17 §4.3); absent on pages filed before the ordered list. */
  readonly entry?: BrowserDecisionEntry;
  /** The set or subscription of that entry, by its name then. */
  readonly sourceName?: string;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parsePlacement(value: unknown): BrowserPlacement | null {
  if (!record(value)) return null;
  const strings = ['id', 'ruleId', 'ruleName', 'folder', 'title', 'url'] as const;
  const entry = value.entry;
  return strings.every((key) => typeof value[key] === 'string') && typeof value.at === 'number'
    && (value.kept === undefined || value.kept === 'conflict' || value.kept === 'blocked' || value.kept === 'keepHere')
    && (entry === undefined || record(entry) && typeof entry.listRevision === 'number'
      && (entry.kind === 'rule' || entry.kind === 'setRule' || entry.kind === 'subscriptionEntry'))
    && (value.sourceName === undefined || typeof value.sourceName === 'string') ? value as unknown as BrowserPlacement : null;
}

/** Every write is one read-modify-write of the whole log, taken one at a time. */
export function createBrowserPlacementLog(area: AutomationStateArea) {
  let lane: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
  }
  const read = async () => {
    const value = await area.get(BROWSER_PLACEMENTS_KEY);
    return (Array.isArray(value) ? value : []).map(parsePlacement).filter((item): item is BrowserPlacement => item !== null);
  };
  return {
    /** Newest first. */
    placements: read,
    /** Keeps the latest few; a placement already logged is left as it is. */
    logPlacement(placement: BrowserPlacement): Promise<boolean> {
      return exclusive(async () => {
        const current = await read();
        if (current.some((item) => item.id === placement.id)) return false;
        await area.set(BROWSER_PLACEMENTS_KEY, [placement, ...current].sort((a, b) => b.at - a.at).slice(0, PLACEMENT_LIMIT));
        return true;
      });
    },
  };
}
export type BrowserPlacementLog = ReturnType<typeof createBrowserPlacementLog>;
