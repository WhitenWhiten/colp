import type { RuleDefinition } from '@know-n/colp/automation';
import type { BrowserDecisionEntry } from '../capture/contracts.js';
import { ruleFolderNativeId, type LocalRule, type LocalSet, type RuleListRecord } from './rule-list-store.js';

/**
 * The ordered list in evaluation order (doc 17 §6.1): the one source for what Options shows and what a
 * save decides (RS-01.3). A switched-off rule, set or subscription contributes nothing; a set
 * contributes its switched-on rules in their order, each filing where the set binds its role; a
 * subscription contributes its current version's entries, or nothing while it has none (`notReady`).
 */
export type EntryRef = Omit<BrowserDecisionEntry, 'listRevision'>;
export interface FlatItem {
  readonly ref: EntryRef;
  /** The rule's id, or the subscription entry's. */
  readonly id: string;
  readonly name: string;
  /** The set or subscription it belongs to; null for an individual rule. */
  readonly source: { readonly id: string; readonly name: string } | null;
  readonly definition: RuleDefinition;
  /** `folderNativeId` null: its role has no folder bound here, so a match is blocked, never passed on (R8). */
  readonly action: { readonly kind: 'file'; readonly folderNativeId: string | null } | { readonly kind: 'keepHere' };
  /** Hosts and registrable domains excluded from this item's subscription only (RS-05.3). */
  readonly exceptions: readonly { readonly scope: 'host' | 'domain'; readonly value: string }[];
}

/** What a subscription contributes now (subscription content, RW-13). */
export interface SubscriptionItems {
  readonly name: string;
  /** False while no version has validated. */
  readonly ready: boolean;
  readonly contentVersion: string | null;
  readonly items: readonly FlatItem[];
}
export type SubscriptionLookup = (subscriptionId: string) => SubscriptionItems | undefined;

export interface FlatList {
  readonly revision: number;
  readonly items: readonly FlatItem[];
  /** Nothing is evaluated: the whole list is switched off, or the account's automations are paused. */
  readonly stopped: 'listOff' | 'accountPaused' | null;
  /** Switched-on subscriptions that contribute nothing yet. */
  readonly skippedSources: readonly { readonly subscriptionId: string; readonly reason: 'notReady' }[];
  /** Subscription id → the content version its items came from; a preview citing others is stale (RS-08.4). */
  readonly contentVersions: Readonly<Record<string, string>>;
}

function ruleItem(rule: LocalRule, set: LocalSet | null): FlatItem {
  const folderNativeId = ruleFolderNativeId(rule, set);
  return { ref: set ? { kind: 'setRule', ruleId: rule.id, setId: set.id } : { kind: 'rule', ruleId: rule.id }, id: rule.id, name: rule.name,
    source: set ? { id: set.id, name: set.name } : null, definition: rule.definition, exceptions: [],
    action: rule.action.kind === 'keepHere' ? { kind: 'keepHere' } : { kind: 'file', folderNativeId } };
}

export function flattenList(list: RuleListRecord, subscriptions: SubscriptionLookup = () => undefined,
  context: { readonly accountPaused?: boolean } = {}): FlatList {
  const stopped = context.accountPaused ? 'accountPaused' : list.enabled ? null : 'listOff';
  const items: FlatItem[] = [], skippedSources: FlatList['skippedSources'][number][] = [], contentVersions: Record<string, string> = {};
  if (stopped) return { revision: list.revision, items, stopped, skippedSources, contentVersions };
  for (const entry of list.entries) {
    if (entry.kind === 'rule') { if (entry.rule.enabled) items.push(ruleItem(entry.rule, null)); continue; }
    if (entry.kind === 'set') {
      if (entry.set.enabled) for (const rule of entry.set.rules) if (rule.enabled) items.push(ruleItem(rule, entry.set));
      continue;
    }
    if (!entry.enabled) continue;
    const content = subscriptions(entry.subscriptionId);
    if (!content?.ready) { skippedSources.push({ subscriptionId: entry.subscriptionId, reason: 'notReady' }); continue; }
    if (content.contentVersion) contentVersions[entry.subscriptionId] = content.contentVersion;
    items.push(...content.items);
  }
  return { revision: list.revision, items, stopped, skippedSources, contentVersions };
}
