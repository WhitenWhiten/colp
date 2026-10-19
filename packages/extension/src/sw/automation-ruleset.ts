import { compilePredicate, preparePredicateInput } from '@know-n/colp/automation';
import { BROWSER_COLLECTION } from '../automation/browser-rules.js';
import type { BrowserRuleResponse, BrowserRulesetCommand, BrowserRulesetView } from '../automation/messages.js';
import { preSaveFacts } from '../automation/pre-save.js';
import { exportRuleset, parseRuleset, rulesetSet, type CompiledEntry } from '../automation/ruleset-format.js';
import { browserRuleStore, folderView, OVERLAP_SAMPLE, recentPages } from './automation-browser.js';
import { ownFolder } from './automation-config.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * Rule sets from a file in the worker (doc 17 RS-02, RS-07): check a `colp.ruleset/v1` text and say what it
 * would add and how many of this browser's recent bookmarks its rules would file; add it as a set with
 * the roles bound to folders the Owner chose here (or left unbound); and write a set of the Owner's back
 * out as such a file. Nothing is fetched and no folder is created.
 */
type Parsed = Extract<ReturnType<typeof parseRuleset>, { ok: true }>;

/** Of the recent bookmarks, how many the set's rules would take, first match within the set, by role. */
async function sample(compiled: readonly CompiledEntry[]): Promise<BrowserRulesetView['sample']> {
  const pages = await recentPages(), now = Date.now();
  const predicates = compiled.map((item) => ({ role: item.entry.role!, check: compilePredicate(item.definition.match) }));
  const byRole = new Map<string, number>();
  let matched = 0;
  for (const page of pages) {
    const facts = preSaveFacts(page, BROWSER_COLLECTION, { ancestors: [] }, 'userDefault', now);
    const input = preparePredicateInput(facts);
    const hit = predicates.find(({ check }) => check.valid && check.evaluate(facts, { inputSnapshot: input }).outcome === 'matched');
    if (!hit) continue;
    matched += 1; byRole.set(hit.role, (byRole.get(hit.role) ?? 0) + 1);
  }
  return { size: pages.length, limit: OVERLAP_SAMPLE, matched, byRole: [...byRole].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count) };
}

function view(parsed: Parsed, sampled: BrowserRulesetView['sample']): BrowserRulesetView {
  const { ruleset, compiled, left } = parsed;
  return { id: ruleset.id, name: ruleset.name, version: ruleset.version, publisher: ruleset.publisher?.name ?? null, license: ruleset.license ?? null,
    roles: ruleset.roles.map((role) => ({ ...role, rules: compiled.filter((item) => item.entry.role === role.key).length })),
    rules: compiled.length, matchingOnly: left.matchingOnly, inactive: left.inactive, sample: sampled };
}

export async function handleRulesetCommand(command: BrowserRulesetCommand): Promise<BrowserRuleResponse> {
  if (command.kind === 'known.automation.browser.set.export') {
    const list = await browserRuleStore().load();
    const set = list.entries.find((entry) => entry.kind === 'set' && entry.set.id === command.id);
    if (set?.kind !== 'set') return { ok: false, error: 'notFound' };
    const titles = new Map<string, string | null>();
    for (const rule of set.set.rules) {
      if (rule.action.kind === 'file' && 'folderNativeId' in rule.action && !titles.has(rule.action.folderNativeId)) {
        titles.set(rule.action.folderNativeId, (await folderView(rule.action.folderNativeId))?.title ?? null);
      }
    }
    const now = Date.now(), doc = exportRuleset(set.set, (id) => titles.get(id) ?? null, now);
    return { ok: true, config: { content: `${JSON.stringify(doc, null, 2)}\n`, filename: `${doc.id}.colp-ruleset.json` } };
  }
  if (command.kind === 'known.automation.browser.set.bind') {
    if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
    for (const folder of Object.values(command.bindings)) if (folder !== null && !await ownFolder(folder)) return { ok: false, error: 'folderGone' };
    return browserRuleStore().bindRoles(command.id, command.bindings, Date.now());
  }
  const parsed = parseRuleset(command.text);
  if (!parsed.ok) return { ok: false, error: 'invalid', rulesetProblems: parsed.problems };
  if (command.kind === 'known.automation.browser.import.check') {
    return { ok: true, ruleset: view(parsed, await hasBookmarkPermission() ? await sample(parsed.compiled) : null) };
  }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'noAccess' };
  const bindings: Record<string, string> = {};
  for (const [role, folder] of Object.entries(command.bindings)) {
    if (folder === null) continue;
    if (!await ownFolder(folder)) return { ok: false, error: 'folderGone' };
    bindings[role] = folder;
  }
  const set = rulesetSet(parsed, bindings, () => crypto.randomUUID(), Date.now());
  const result = await browserRuleStore().importEntries([{ kind: 'set', set }], false);
  return result.ok ? { ok: true, set } : result;
}
