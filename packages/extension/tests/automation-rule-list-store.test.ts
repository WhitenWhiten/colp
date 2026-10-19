import { describe, expect, it } from 'vitest';
import type { BrowserRule } from '../src/automation/browser-rules.js';
import { checkRuleDraft, type RuleDraft } from '../src/automation/rule-conditions.js';
import {
  createRuleListStore, entryId, individualRules, LEGACY_RULES_KEY, LIST_LIMITS, RULE_LIST_KEY,
  type ListEntry, type LocalRule, type LocalSet, type RuleListRecord,
} from '../src/automation/rule-list-store.js';
import { memoryStateArea, NOW } from './automation-fixture.js';

/** Doc 17 RW-01: the ordered list in this browser, its limits, its commands and the move from the v1 list. */
type Draft = Partial<RuleDraft> & { readonly folderNativeId?: string };
const draft = ({ folderNativeId = '30', ...over }: Draft = {}): RuleDraft =>
  ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId }, ...over });

function legacy(id: string, over: Draft = {}, extra: Partial<BrowserRule> = {}): BrowserRule {
  const checked = checkRuleDraft(draft(over));
  if (!checked.ok) throw new Error('invalid draft');
  return { id, definition: checked.definition, folderNativeId: over.folderNativeId ?? '30', enabled: true, createdAt: NOW, updatedAt: NOW, ...extra };
}

function store(area = memoryStateArea()) {
  let next = 0;
  return { area, store: createRuleListStore(area, { id: () => `r-${++next}`, now: () => NOW }) };
}

const ids = (list: RuleListRecord) => list.entries.map((entry) =>
  entry.kind === 'set' ? `${entry.set.id}[${entry.set.rules.map((rule) => rule.id).join(',')}]` : entryId(entry));

/** An imported set as RW-10 will write it: rules filing by role, bound to folders here. */
function importedSet(id: string, rules: readonly LocalRule[], bindings: Record<string, string>): LocalSet {
  return { id, name: 'Community', enabled: true, createdAt: NOW, updatedAt: NOW, roles: [{ key: 'papers', description: 'Papers' }], bindings, rules,
    origin: { kind: 'import', sourceId: 'community', sourceName: 'Community', sourceVersion: '1', publisher: null, importedAt: NOW } };
}

describe('the move from the v1 list (R2)', () => {
  it('keeps the rules in the order they were made, with their conditions as written, and deletes the old list', async () => {
    const { area, store: rules } = store();
    area.values.set(LEGACY_RULES_KEY, { version: 1, rules: [legacy('b-1', { combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'github.com' },
      { kind: 'titleContains', value: 'Review' }] }, { reviewed: [{ accountRuleId: 'a-1', key: '4:1' }], movingSince: NOW - 1 }),
    legacy('b-2', { name: 'Reading', conditions: [{ kind: 'siteIs', value: 'example.org' }], folderNativeId: '31' }, { enabled: false })] });
    const list = await rules.load();
    expect(list).toMatchObject({ version: 2, revision: 1, enabled: true });
    expect(list).not.toHaveProperty('orderNotice');
    expect(ids(list)).toEqual(['b-1', 'b-2']);
    expect(individualRules(list)[0]).toMatchObject({ id: 'b-1', name: 'Papers from arXiv', combinator: 'any', enabled: true,
      conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Review' }],
      action: { kind: 'file', folderNativeId: '30' }, compiledFrom: { contentVersions: {} }, reviewed: [{ accountRuleId: 'a-1', key: '4:1' }],
      movingSince: NOW - 1 });
    expect(individualRules(list)[1]).toMatchObject({ id: 'b-2', enabled: false, action: { folderNativeId: '31' } });
    expect(area.values.has(LEGACY_RULES_KEY)).toBe(false);
    expect(area.values.get(RULE_LIST_KEY)).toEqual(list);
    // Read again: nothing moves twice.
    expect(await rules.load()).toEqual(list);
  });

  it('names each pair of switched-on rules that can take one page to different folders', async () => {
    const { area, store: rules } = store();
    area.values.set(LEGACY_RULES_KEY, { version: 1, rules: [
      legacy('b-1'),
      legacy('b-2', { conditions: [{ kind: 'titleContains', value: 'paper' }], folderNativeId: '31' }),
      // Same folder as b-1: nothing changes for the pages they share.
      legacy('b-3', { conditions: [{ kind: 'pathStartsWith', value: '/abs/' }] }),
      // Switched off: it files nothing either way.
      legacy('b-4', { conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], folderNativeId: '32' }, { enabled: false }),
      // Never with arxiv.org; with the others it shares pages.
      legacy('b-5', { conditions: [{ kind: 'siteIs', value: 'example.org' }], folderNativeId: '33' }),
    ] });
    expect((await rules.load()).orderNotice).toEqual({ pairs: [['b-1', 'b-2'], ['b-2', 'b-3'], ['b-2', 'b-5'], ['b-3', 'b-5']], shownAt: null });
    expect(await rules.dismissOrderNotice()).toBe(true);
    expect(await rules.load()).not.toHaveProperty('orderNotice');
    expect(await rules.dismissOrderNotice()).toBe(false);
  });

  it('keeps a rule the editor cannot show, matching as it did, with no conditions to edit', async () => {
    const { area, store: rules } = store();
    const odd = legacy('b-1');
    area.values.set(LEGACY_RULES_KEY, { version: 1, rules: [{ ...odd, definition: { ...odd.definition, match: { kind: 'not', item: odd.definition.match } } },
      { id: 'broken', definition: { name: 'x' }, folderNativeId: '30', enabled: true, createdAt: NOW, updatedAt: NOW }] });
    const [rule, ...rest] = individualRules(await rules.load());
    expect(rest).toEqual([]);
    expect(rule).toMatchObject({ id: 'b-1', conditions: [], combinator: 'all', definition: { match: { kind: 'not' } } });
  });
});

describe('rules and sets', () => {
  it('creates, edits, switches and removes rules where they are, one revision per change', async () => {
    const { store: rules } = store();
    expect(await rules.saveRule({ draft: draft({ conditions: [{ kind: 'siteIs', value: 'https://ArXiv.org/abs/1' }] }) }, NOW)).toMatchObject({ ok: true,
      rule: { id: 'r-1', name: 'Papers from arXiv', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
        definition: { match: { value: 'arxiv.org' } }, action: { kind: 'file', folderNativeId: '30' } } });
    await rules.saveRule({ draft: draft({ name: 'Reading', folderNativeId: '31' }) }, NOW);
    await rules.saveRule({ draft: draft({ name: 'First' }), index: 0 }, NOW);
    expect(ids(await rules.load())).toEqual(['r-3', 'r-1', 'r-2']);
    expect(await rules.saveRule({ id: 'r-1', draft: draft({ name: 'Papers' }) }, NOW + 1)).toMatchObject({ ok: true,
      rule: { id: 'r-1', name: 'Papers', createdAt: NOW, updatedAt: NOW + 1 } });
    expect(await rules.setEnabled({ kind: 'rule', id: 'r-2' }, false, NOW + 2)).toMatchObject({ kind: 'rule', rule: { enabled: false } });
    expect(await rules.saveRule({ id: 'r-2', draft: draft({ name: 'Reading' }) }, NOW + 3)).toMatchObject({ rule: { enabled: false } });
    expect(await rules.removeRule('r-3')).toBe(true);
    expect(await rules.removeRule('r-3')).toBe(false);
    const list = await rules.load();
    expect(ids(list)).toEqual(['r-1', 'r-2']);
    expect(list.revision).toBe(7);
    // Nothing to change writes nothing.
    await rules.setEnabled({ kind: 'rule', id: 'r-2' }, false, NOW + 4);
    expect((await rules.load()).revision).toBe(7);
  });

  it('refuses what it cannot keep', async () => {
    const { store: rules } = store();
    expect(await rules.saveRule({ draft: draft({ folderNativeId: '' }) }, NOW)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await rules.saveRule({ id: 'missing', draft: draft() }, NOW)).toEqual({ ok: false, error: 'notFound' });
    expect(await rules.saveRule({ draft: draft(), into: 'missing' }, NOW)).toEqual({ ok: false, error: 'notFound' });
    expect(await rules.setEnabled({ kind: 'rule', id: 'missing' }, false, NOW)).toBeNull();
    expect(await rules.setEnabled({ kind: 'set', id: 'missing' }, false, NOW)).toBeNull();
    expect(await rules.saveSet({ name: '  ' }, NOW)).toEqual({ ok: false, error: 'invalid' });
    expect(await rules.saveSet({ name: 'x'.repeat(201) }, NOW)).toEqual({ ok: false, error: 'invalid' });
    expect(await rules.saveSet({ id: 'missing', name: 'Reading' }, NOW)).toEqual({ ok: false, error: 'notFound' });
  });

  it(`keeps at most ${LIST_LIMITS.rules} individual rules, ${LIST_LIMITS.sets} sets and ${LIST_LIMITS.localRules} rules in all`, async () => {
    const { area, store: rules } = store();
    const rule = (id: string): LocalRule => {
      const checked = checkRuleDraft(draft());
      if (!checked.ok) throw new Error('invalid draft');
      return { id, enabled: true, name: 'Papers', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
        action: { kind: 'file', folderNativeId: '30' }, definition: checked.definition, compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW };
    };
    const custom = (id: string, count: number): ListEntry => ({ kind: 'set', set: { id, name: id, enabled: true, createdAt: NOW, updatedAt: NOW,
      origin: { kind: 'custom' }, roles: [], bindings: {}, rules: Array.from({ length: count }, (_, index) => rule(`${id}-${index}`)) } });
    const individual = Array.from({ length: LIST_LIMITS.rules }, (_, index): ListEntry => ({ kind: 'rule', rule: rule(`i-${index}`) }));
    area.values.set(RULE_LIST_KEY, { version: 2, revision: 1, enabled: true, entries: individual });
    expect(await rules.saveRule({ draft: draft() }, NOW)).toEqual({ ok: false, error: 'limit' });
    const set = await rules.saveSet({ name: 'Reading' }, NOW);
    expect(set).toMatchObject({ ok: true, set: { name: 'Reading', origin: { kind: 'custom' }, rules: [] } });
    expect(await rules.saveRule({ draft: draft(), into: set.ok ? set.set.id : '' }, NOW)).toMatchObject({ ok: true });
    expect(await rules.moveRule('i-0', null, 0, NOW)).toMatchObject({ ok: true });
    // Out of the set: one individual rule too many.
    const inside = (await rules.load()).entries.find((entry) => entry.kind === 'set');
    expect(inside?.kind === 'set' && await rules.moveRule(inside.set.rules[0]!.id, null, 0, NOW)).toEqual({ ok: false, error: 'limit' });
    expect(inside?.kind === 'set' && await rules.removeSet(inside.set.id, true, NOW)).toEqual({ ok: false, error: 'limit' });

    area.values.set(RULE_LIST_KEY, { version: 2, revision: 1, enabled: true,
      entries: Array.from({ length: LIST_LIMITS.sets }, (_, index) => custom(`s-${index}`, index < 20 ? 50 : 0)) });
    expect(await rules.saveSet({ name: 'One more' }, NOW)).toEqual({ ok: false, error: 'limit' });
    // 20 × 50 rules fill the thousand.
    expect(await rules.saveRule({ draft: draft(), into: 's-30' }, NOW)).toEqual({ ok: false, error: 'limit' });
  });

  it('reorders the list only by exactly the entries it has', async () => {
    const { store: rules } = store();
    await rules.saveRule({ draft: draft() }, NOW);
    await rules.saveSet({ name: 'Reading' }, NOW);
    await rules.saveRule({ draft: draft() }, NOW);
    const before = await rules.load();
    expect(ids(before)).toEqual(['r-1', 'r-2[]', 'r-3']);
    for (const order of [['r-1', 'r-2'], ['r-1', 'r-2', 'r-3', 'r-4'], ['r-1', 'r-1', 'r-3'], ['r-1', 'r-2', 'x']]) {
      expect(await rules.reorder(order)).toEqual({ ok: false, error: 'mismatch' });
    }
    expect(await rules.load()).toEqual(before);
    expect(await rules.reorder(['r-3', 'r-1', 'r-2'])).toEqual({ ok: true, revision: before.revision + 1 });
    expect(ids(await rules.load())).toEqual(['r-3', 'r-1', 'r-2[]']);
    expect(await rules.reorder(['r-3', 'r-1', 'r-2'])).toEqual({ ok: true, revision: before.revision + 1 });
  });

  it('moves a rule into a set and out again, at the place asked', async () => {
    const { store: rules } = store();
    await rules.saveRule({ draft: draft() }, NOW);
    await rules.saveRule({ draft: draft() }, NOW);
    const set = await rules.saveSet({ name: 'Reading' }, NOW);
    if (!set.ok) throw new Error('no set');
    await rules.markMoving('r-1', NOW);
    expect(await rules.moveRule('r-1', 'r-3', 0, NOW + 1)).toMatchObject({ ok: true });
    expect(await rules.moveRule('r-2', 'r-3', 0, NOW + 1)).toMatchObject({ ok: true });
    expect(ids(await rules.load())).toEqual(['r-3[r-2,r-1]']);
    // A rule in a set no longer waits to move to the account.
    const inSet = (await rules.load()).entries[0];
    expect(inSet?.kind === 'set' && inSet.set.rules[1]).not.toHaveProperty('movingSince');
    expect(await rules.saveRule({ draft: draft(), into: 'r-3', index: 1 }, NOW)).toMatchObject({ ok: true });
    expect(ids(await rules.load())).toEqual(['r-3[r-2,r-4,r-1]']);
    expect(await rules.moveRule('r-1', null, 0, NOW + 2)).toMatchObject({ ok: true });
    expect(await rules.moveRule('r-4', 'r-3', 5, NOW + 2)).toMatchObject({ ok: true });
    expect(ids(await rules.load())).toEqual(['r-1', 'r-3[r-2,r-4]']);
    expect(await rules.moveRule('missing', null, 0, NOW)).toEqual({ ok: false, error: 'notFound' });
    expect(await rules.moveRule('r-1', 'missing', 0, NOW)).toEqual({ ok: false, error: 'notFound' });
    // A set's switch is its own; its rules keep theirs.
    expect(await rules.setEnabled({ kind: 'set', id: 'r-3' }, false, NOW + 3)).toMatchObject({ kind: 'set', set: { enabled: false,
      rules: [{ enabled: true }, { enabled: true }] } });
    expect(await rules.saveSet({ id: 'r-3', name: 'Later' }, NOW + 4)).toMatchObject({ ok: true, set: { name: 'Later', enabled: false } });
  });

  it('takes a rule out of an imported set with the folder its role was bound to', async () => {
    const { area, store: rules } = store();
    const checked = checkRuleDraft(draft());
    if (!checked.ok) throw new Error('invalid draft');
    const byRole = (id: string, role: string): LocalRule => ({ id, enabled: true, name: id, combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
      action: { kind: 'file', role }, definition: checked.definition, compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW,
      origin: { kind: 'import', sourceId: 'community', sourceName: 'Community', sourceVersion: '1', importedAt: NOW } });
    area.values.set(RULE_LIST_KEY, { version: 2, revision: 4, enabled: true,
      entries: [{ kind: 'set', set: importedSet('s-1', [byRole('e-1', 'papers'), byRole('e-2', 'code')], { papers: '30' }) }] });
    expect(await rules.moveRule('e-1', null, 1, NOW + 1)).toEqual({ ok: true, revision: 5 });
    expect(individualRules(await rules.load())).toMatchObject([{ id: 'e-1', action: { kind: 'file', folderNativeId: '30' }, updatedAt: NOW + 1,
      origin: { kind: 'import' } }]);
    // No folder is bound to its role, so there is none to keep.
    expect(await rules.moveRule('e-2', null, 0, NOW)).toEqual({ ok: false, error: 'unbound' });
    expect(await rules.removeSet('s-1', true, NOW)).toEqual({ ok: false, error: 'unbound' });
    expect(await rules.removeSet('s-1', false, NOW)).toEqual({ ok: true, revision: 6 });
    expect(ids(await rules.load())).toEqual(['e-1']);
  });

  it('puts a deleted set’s rules where it was when they are kept', async () => {
    const { store: rules } = store();
    await rules.saveRule({ draft: draft() }, NOW);
    await rules.saveSet({ name: 'Reading' }, NOW);
    await rules.saveRule({ draft: draft() }, NOW);
    await rules.saveRule({ draft: draft(), into: 'r-2' }, NOW);
    await rules.saveRule({ draft: draft(), into: 'r-2' }, NOW);
    expect(ids(await rules.load())).toEqual(['r-1', 'r-2[r-4,r-5]', 'r-3']);
    expect(await rules.removeSet('r-2', true, NOW)).toMatchObject({ ok: true });
    expect(ids(await rules.load())).toEqual(['r-1', 'r-4', 'r-5', 'r-3']);
    expect(await rules.removeSet('r-2', true, NOW)).toEqual({ ok: false, error: 'notFound' });
  });

  it('switches the whole list, and never loses a change to another one at the same time', async () => {
    const { store: rules } = store();
    await Promise.all([rules.saveRule({ draft: draft() }, NOW), rules.saveRule({ draft: draft({ name: 'Two' }) }, NOW), rules.saveSet({ name: 'Set' }, NOW),
      rules.setListEnabled(false), rules.removeRule('none'), rules.saveRule({ draft: draft({ name: 'Three' }) }, NOW)]);
    const list = await rules.load();
    expect(ids(list)).toEqual(['r-1', 'r-2', 'r-3[]', 'r-4']);
    expect(list).toMatchObject({ enabled: false, revision: 5 });
  });

  it('drops a stored entry it cannot run, and an id seen twice, rather than guess', async () => {
    const { area, store: rules } = store();
    await rules.saveRule({ draft: draft() }, NOW);
    const stored = area.values.get(RULE_LIST_KEY) as RuleListRecord;
    const good = stored.entries[0]!;
    area.values.set(RULE_LIST_KEY, { ...stored, entries: [good, good,
      { kind: 'rule', rule: { ...(good as Extract<ListEntry, { kind: 'rule' }>).rule, id: 'extra', unknown: true } },
      { kind: 'rule', rule: { ...(good as Extract<ListEntry, { kind: 'rule' }>).rule, id: 'odd', action: { kind: 'file' } } },
      { kind: 'folder', id: 'x' }, { kind: 'subscription', subscriptionId: 'sub-1', enabled: true }] });
    expect(ids(await rules.load())).toEqual(['r-1', 'sub-1']);
    area.values.set(RULE_LIST_KEY, { version: 3, revision: 9, enabled: true, entries: [] });
    expect(await rules.load()).toEqual({ version: 2, revision: 0, enabled: true, entries: [] });
  });
});
