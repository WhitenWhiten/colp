import type { FolderRef, RuleDefinition } from '@know-n/colp/automation';
import type { RuleCondition } from './rule-conditions.js';
import { ruleMatchView } from './rule-match.js';
import type { LocalFolder } from './runtime-profile.js';

/**
 * Browser rules: the Owner's own placement rules, kept in this browser only
 * (design 01 §7.5, ADR-A24), in one ordered list (rule-list-store.ts) whose
 * rules the first-match evaluator decides (rule-list-decide.ts). They need no
 * account, work offline and may name any folder. At save they come after the
 * account's rules: an account rule's outcome settles the save, and only a page
 * no account rule matches is decided here.
 *
 * This module holds what both sides of that line share: how a folder here is
 * named in the shared core's terms and looked up, and how a rule is handed to
 * the web editor to become an account rule.
 */

/** A rule as builds before the ordered list stored it (key known.automation.browserRules.v1); read once to migrate. */
export interface BrowserRule {
  readonly id: string;
  readonly definition: RuleDefinition;
  readonly folderNativeId: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reviewed?: readonly { readonly accountRuleId: string; readonly key: string }[];
  readonly movingSince?: number;
}

/**
 * A definition's conditions in the web editor's kinds; null when it has no short form here (a nested
 * group, a `not`, a tag condition), so the web editor cannot be filled in with it.
 */
export function editorConditions(definition: RuleDefinition): { readonly combinator: 'all' | 'any'; readonly conditions: readonly RuleCondition[] } | null {
  const match = ruleMatchView(definition.match);
  if (!match || match.conditions.some((condition) => condition.kind === 'hasTag')) return null;
  return { combinator: match.combinator, conditions: match.conditions.map((condition) => ({ kind: condition.kind as RuleCondition['kind'], value: condition.value })) };
}

/**
 * The web editor filled in with this rule (AW-70): the same name and conditions, and its folder by the
 * canonical identity Sync gave it. Null for a rule the editor cannot show.
 */
export function accountEditorUrl(webUrl: string, rule: { readonly definition: RuleDefinition },
  folder: { readonly collectionId: string; readonly nodeId: string }): string | null {
  const match = editorConditions(rule.definition);
  if (!match) return null;
  const url = new URL(`${webUrl.replace(/\/$/u, '')}/new`);
  url.searchParams.set('collectionId', folder.collectionId);
  url.searchParams.set('folderId', folder.nodeId);
  url.searchParams.set('name', rule.definition.name);
  url.searchParams.set('combinator', match.combinator);
  for (const condition of match.conditions) url.searchParams.append('condition', `${condition.kind}:${condition.value}`);
  url.searchParams.set('from', 'browser');
  return url.toString();
}

/** Browser folders, named in the shared core's terms. No server or collection is involved. */
export const BROWSER_COLLECTION = 'browser';
export const browserFolderRef = (nativeId: string): FolderRef => ({ serverUuid: 'browser', collectionId: BROWSER_COLLECTION, nodeId: nativeId });

/** A browser rule's folder, looked up in this browser now. */
export interface FolderLookup {
  (nativeId: string): Promise<{ readonly id: string; readonly title: string; readonly parentId?: string; readonly url?: string;
    readonly unmodifiable?: string } | null>;
}

/** By native id only: a renamed folder is still the rule's, and a new folder with the same title never is. */
export async function resolveBrowserFolder(nativeId: string, lookup: FolderLookup): Promise<LocalFolder> {
  const folder = browserFolderRef(nativeId);
  const node = await lookup(nativeId).catch(() => null);
  if (!node) return { status: 'unresolved', folder, reason: 'deleted' };
  if (node.url !== undefined || node.unmodifiable) return { status: 'unresolved', folder, reason: 'notFolder' };
  return { status: 'resolved', folder, nativeId: node.id, title: node.title };
}
