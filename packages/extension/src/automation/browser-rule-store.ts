import { validateM1Rule } from '@know-n/colp/automation';
import type { AutomationStateArea } from './bundle-store.js';
import { BROWSER_RULE_LIMIT, checkBrowserDraft, type BrowserRule, type BrowserRuleDraft, type DraftProblem } from './browser-rules.js';

/**
 * This browser's own rules and the pages they filed, in the automation store
 * (indexeddb-store.ts) next to the account's bundle, under keys of their own.
 * Nothing here is ever sent anywhere, and signing out leaves it in place.
 *
 * Every change is one read-modify-write of the whole list, taken one at a time,
 * so two pages saving at once never lose a rule.
 */
export const BROWSER_RULES_KEY = 'known.automation.browserRules.v1';
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
}

export type SaveResult = { readonly ok: true; readonly rule: BrowserRule }
  | { readonly ok: false; readonly error: 'invalid'; readonly problems: readonly DraftProblem[] }
  | { readonly ok: false; readonly error: 'notFound' | 'limit' };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A stored rule this build can run; anything else is dropped rather than guessed at. */
function parseRule(value: unknown): BrowserRule | null {
  if (!record(value) || typeof value.id !== 'string' || typeof value.folderNativeId !== 'string' || typeof value.enabled !== 'boolean'
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number' || validateM1Rule(value.definition).length) return null;
  const reviewed = Array.isArray(value.reviewed) ? value.reviewed.filter((item): item is { accountRuleId: string; key: string } =>
    record(item) && typeof item.accountRuleId === 'string' && typeof item.key === 'string') : [];
  const { reviewed: _reviewed, ...rest } = value as unknown as BrowserRule;
  return reviewed.length ? { ...rest, reviewed } : rest;
}
const REVIEW_LIMIT = 20;

function parsePlacement(value: unknown): BrowserPlacement | null {
  if (!record(value)) return null;
  const strings = ['id', 'ruleId', 'ruleName', 'folder', 'title', 'url'] as const;
  return strings.every((key) => typeof value[key] === 'string') && typeof value.at === 'number' ? value as unknown as BrowserPlacement : null;
}

export function createBrowserRuleStore(area: AutomationStateArea, options: { readonly id?: () => string } = {}) {
  const newId = options.id ?? (() => crypto.randomUUID());
  let lane: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = lane.then(work, work); lane = run.catch(() => undefined); return run;
  }
  async function read(): Promise<BrowserRule[]> {
    const value = await area.get(BROWSER_RULES_KEY);
    const rules = record(value) && Array.isArray(value.rules) ? value.rules : [];
    return rules.map(parseRule).filter((rule): rule is BrowserRule => rule !== null);
  }
  const write = (rules: readonly BrowserRule[]) => area.set(BROWSER_RULES_KEY, { version: 1, rules });

  return {
    /** Oldest first: the order the Owner made them in. */
    list: read,
    /** Creates a rule (no id) or replaces one's conditions, name and folder. */
    save(input: { readonly id?: string; readonly draft: BrowserRuleDraft; readonly enabled?: boolean }, now: number): Promise<SaveResult> {
      return exclusive(async () => {
        const checked = checkBrowserDraft(input.draft);
        if (!checked.ok) return { ok: false, error: 'invalid', problems: checked.problems };
        const rules = await read();
        const at = input.id === undefined ? -1 : rules.findIndex((rule) => rule.id === input.id);
        if (input.id !== undefined && at < 0) return { ok: false, error: 'notFound' };
        if (at < 0 && rules.length >= BROWSER_RULE_LIMIT) return { ok: false, error: 'limit' };
        const previous = at < 0 ? null : rules[at]!;
        const rule: BrowserRule = { id: previous?.id ?? newId(), definition: checked.definition, folderNativeId: input.draft.folderNativeId,
          enabled: input.enabled ?? previous?.enabled ?? true, createdAt: previous?.createdAt ?? now, updatedAt: now };
        await write(at < 0 ? [...rules, rule] : rules.map((item, index) => index === at ? rule : item));
        return { ok: true, rule };
      });
    },
    setEnabled(id: string, enabled: boolean, now: number): Promise<BrowserRule | null> {
      return exclusive(async () => {
        const rules = await read(), current = rules.find((rule) => rule.id === id);
        if (!current) return null;
        if (current.enabled === enabled) return current;
        const next = { ...current, enabled, updatedAt: now };
        await write(rules.map((rule) => rule.id === id ? next : rule));
        return next;
      });
    },
    /** The Owner kept this rule next to an account rule's current revision; the newest few are remembered. */
    review(id: string, accountRuleId: string, key: string): Promise<BrowserRule | null> {
      return exclusive(async () => {
        const rules = await read(), current = rules.find((rule) => rule.id === id);
        if (!current) return null;
        const reviewed = [{ accountRuleId, key }, ...(current.reviewed ?? []).filter((item) => item.accountRuleId !== accountRuleId)].slice(0, REVIEW_LIMIT);
        const next = { ...current, reviewed };
        await write(rules.map((rule) => rule.id === id ? next : rule));
        return next;
      });
    },
    remove(id: string): Promise<boolean> {
      return exclusive(async () => {
        const rules = await read();
        if (!rules.some((rule) => rule.id === id)) return false;
        await write(rules.filter((rule) => rule.id !== id));
        return true;
      });
    },
    /** Newest first. */
    async placements(): Promise<BrowserPlacement[]> {
      const value = await area.get(BROWSER_PLACEMENTS_KEY);
      return (Array.isArray(value) ? value : []).map(parsePlacement).filter((item): item is BrowserPlacement => item !== null);
    },
    /** Keeps the latest few; a placement already logged is left as it is. */
    logPlacement(placement: BrowserPlacement): Promise<boolean> {
      return exclusive(async () => {
        const value = await area.get(BROWSER_PLACEMENTS_KEY);
        const current = (Array.isArray(value) ? value : []).map(parsePlacement).filter((item): item is BrowserPlacement => item !== null);
        if (current.some((item) => item.id === placement.id)) return false;
        await area.set(BROWSER_PLACEMENTS_KEY, [placement, ...current].sort((a, b) => b.at - a.at).slice(0, PLACEMENT_LIMIT));
        return true;
      });
    },
  };
}
export type BrowserRuleStore = ReturnType<typeof createBrowserRuleStore>;
