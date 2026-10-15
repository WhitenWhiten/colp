import { validateM1Rule } from '@know-n/colp/automation';
import { describe, expect, it } from 'vitest';
import { createBrowserRuleStore, BROWSER_PLACEMENTS_KEY, BROWSER_RULES_KEY } from '../src/automation/browser-rule-store.js';
import { BROWSER_RULE_LIMIT, browserRuleDefinition, checkBrowserDraft, decideBrowserRules, draftFromRule, type BrowserRule,
  type BrowserRuleDraft, type FolderLookup } from '../src/automation/browser-rules.js';
import type { AutomationStateArea } from '../src/automation/bundle-store.js';
import { NOW } from './automation-fixture.js';

/** Browser rules (AW-67): the editor's draft, its stored definition, and what they decide at save. */
const draft = (over: Partial<BrowserRuleDraft> = {}): BrowserRuleDraft =>
  ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], folderNativeId: '30', ...over });

function stored(id: string, over: Partial<BrowserRuleDraft> = {}, enabled = true): BrowserRule {
  const checked = checkBrowserDraft(draft(over));
  if (!checked.ok) throw new Error('invalid draft');
  return { id, definition: checked.definition, folderNativeId: draft(over).folderNativeId, enabled, createdAt: NOW, updatedAt: NOW };
}

const folders: Record<string, { id: string; title: string; url?: string; unmodifiable?: string }> = {
  30: { id: '30', title: 'Papers' }, 31: { id: '31', title: 'Reading' }, 40: { id: '40', title: 'Managed', unmodifiable: 'managed' },
  50: { id: '50', title: 'A bookmark', url: 'https://example.org/' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;
const page = (url: string, title = 'A paper', explicit = false) => ({ url, title, explicit });

function memoryArea(): AutomationStateArea & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); } };
}

describe('a draft becomes a stored rule', () => {
  it('is the M1 placement definition with no collection, normalized the way the evaluator compares', () => {
    const checked = checkBrowserDraft(draft({ conditions: [{ kind: 'siteIs', value: ' ArXiv.org ' }] }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(validateM1Rule(checked.definition)).toEqual([]);
    expect(checked.definition).toMatchObject({ name: 'Papers from arXiv', scope: {}, on: 'bookmark.intake', tasks: [], priority: 100,
      match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }, intake: { folderRole: 'destination' } });
  });

  it('takes a pasted link for its site, and names an unnamed rule after its first value', () => {
    const checked = checkBrowserDraft(draft({ name: '  ', conditions: [{ kind: 'siteEndsWith', value: 'https://Docs.GitHub.com/en/actions' }] }));
    expect(checked.ok && checked.definition).toMatchObject({ name: 'docs.github.com', match: { op: 'hostSuffix', value: 'docs.github.com' } });
  });

  it('joins several conditions with all or any and drops empty rows', () => {
    const definition = browserRuleDefinition(draft({ combinator: 'any', conditions: [{ kind: 'titleContains', value: 'Paper' }, { kind: 'siteIs', value: '' },
      { kind: 'pathStartsWith', value: '/abs/' }] }));
    expect(definition.match).toEqual({ kind: 'any', items: [{ kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' },
      { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/abs/' }] });
  });

  it('says what the editor should point at', () => {
    expect(checkBrowserDraft(draft({ conditions: [{ kind: 'siteIs', value: '  ' }], folderNativeId: '' }))).toEqual({ ok: false,
      problems: [{ field: 'conditions', code: 'required' }, { field: 'folder', code: 'required' }] });
    expect(checkBrowserDraft(draft({ conditions: [{ kind: 'titleContains', value: 'ok' }, { kind: 'siteIs', value: 'not a host' }] }))).toEqual({ ok: false,
      problems: [{ field: 'condition', index: 1, code: 'invalidHost' }] });
    expect(checkBrowserDraft(draft({ conditions: Array.from({ length: 9 }, (_, index) => ({ kind: 'titleContains' as const, value: `w${index}` })) })))
      .toMatchObject({ ok: false, problems: [{ field: 'conditions', code: 'tooMany' }] });
    expect(checkBrowserDraft(draft({ name: 'x'.repeat(201) }))).toMatchObject({ ok: false, problems: [{ field: 'name', code: 'tooLong' }] });
    expect(checkBrowserDraft(draft({ conditions: [{ kind: 'hasTag' as never, value: 'research' }] })))
      .toMatchObject({ ok: false, problems: [{ field: 'condition', index: 0, code: 'kind' }] });
  });

  it('opens again in the editor as it was written', () => {
    const rule = stored('b-1', { combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Review' }] });
    expect(draftFromRule(rule)).toEqual({ name: 'Papers from arXiv', combinator: 'any', folderNativeId: '30',
      conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Review' }] });
  });
});

describe('what browser rules decide at save', () => {
  it('place a matching page in the rule’s folder and leave others alone', async () => {
    const rules = [stored('b-1')];
    expect(await decideBrowserRules(rules, page('https://arxiv.org/abs/2410.00001'), lookup, NOW)).toEqual({ outcome: 'placed',
      rule: { id: 'b-1', name: 'Papers from arXiv' }, ruleIds: ['b-1'], folder: { nativeId: '30', title: 'Papers' } });
    expect(await decideBrowserRules(rules, page('https://example.org/'), lookup, NOW)).toBeNull();
    expect(await decideBrowserRules([stored('b-1', {}, false)], page('https://arxiv.org/abs/1'), lookup, NOW)).toBeNull();
    expect(await decideBrowserRules([], page('https://arxiv.org/abs/1'), lookup, NOW)).toBeNull();
  });

  it('stand aside for a folder the Owner picked', async () => {
    expect(await decideBrowserRules([stored('b-1')], page('https://arxiv.org/abs/1', 'A paper', true), lookup, NOW))
      .toMatchObject({ outcome: 'kept', folder: null });
  });

  it('block, never guess, when the folder is gone or cannot hold bookmarks', async () => {
    for (const folderNativeId of ['99', '40', '50']) {
      expect(await decideBrowserRules([stored('b-1', { folderNativeId })], page('https://arxiv.org/abs/1'), lookup, NOW))
        .toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', folder: null });
    }
  });

  it('keep the page where it was saved when two rules send it to different folders, and agree when they don’t', async () => {
    const other = stored('b-2', { name: 'Reading list', conditions: [{ kind: 'titleContains', value: 'paper' }], folderNativeId: '31' });
    expect(await decideBrowserRules([stored('b-1'), other], page('https://arxiv.org/abs/1', 'A paper'), lookup, NOW))
      .toMatchObject({ outcome: 'conflict', ruleIds: ['b-1', 'b-2'] });
    const same = stored('b-3', { conditions: [{ kind: 'pathStartsWith', value: '/abs/' }] });
    expect(await decideBrowserRules([stored('b-1'), same], page('https://arxiv.org/abs/1'), lookup, NOW))
      .toMatchObject({ outcome: 'placed', ruleIds: ['b-1', 'b-3'], folder: { nativeId: '30' } });
  });

  it('match a whole site with "ends with", and a path from its first segment', async () => {
    const rules = [stored('b-1', { conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'pathStartsWith', value: '/know-n/' }] })];
    expect(await decideBrowserRules(rules, page('https://gist.github.com/know-n/abc'), lookup, NOW)).toMatchObject({ outcome: 'placed' });
    expect(await decideBrowserRules(rules, page('https://github.com/other/abc'), lookup, NOW)).toBeNull();
  });
});

describe('the browser rule store', () => {
  it('creates, edits, switches off and removes rules, keeping their order and creation time', async () => {
    const area = memoryArea();
    let next = 0;
    const store = createBrowserRuleStore(area, { id: () => `b-${++next}` });
    const first = await store.save({ draft: draft() }, NOW);
    const second = await store.save({ draft: draft({ name: 'Reading', folderNativeId: '31' }) }, NOW + 1);
    expect(first).toMatchObject({ ok: true, rule: { id: 'b-1', enabled: true, createdAt: NOW } });
    expect((await store.list()).map((rule) => rule.id)).toEqual(['b-1', 'b-2']);
    expect(await store.save({ id: 'b-1', draft: draft({ name: 'Papers' }) }, NOW + 2)).toMatchObject({ ok: true,
      rule: { id: 'b-1', createdAt: NOW, updatedAt: NOW + 2, definition: { name: 'Papers' } } });
    expect(await store.setEnabled('b-2', false, NOW + 3)).toMatchObject({ enabled: false });
    expect(await store.save({ id: 'b-2', draft: draft({ name: 'Reading' }) }, NOW + 4)).toMatchObject({ rule: { enabled: false } });
    expect(await store.remove('b-1')).toBe(true);
    expect(await store.remove('b-1')).toBe(false);
    expect((await store.list()).map((rule) => [rule.id, rule.enabled])).toEqual([['b-2', false]]);
    expect(second.ok).toBe(true);
  });

  it('refuses what it cannot keep', async () => {
    const store = createBrowserRuleStore(memoryArea());
    expect(await store.save({ draft: draft({ folderNativeId: '' }) }, NOW)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await store.save({ id: 'missing', draft: draft() }, NOW)).toEqual({ ok: false, error: 'notFound' });
    expect(await store.setEnabled('missing', false, NOW)).toBeNull();
    for (let index = 0; index < BROWSER_RULE_LIMIT; index++) await store.save({ draft: draft() }, NOW);
    expect(await store.save({ draft: draft() }, NOW)).toEqual({ ok: false, error: 'limit' });
  });

  it('never loses a rule to two saves at once, and drops a stored value it cannot run', async () => {
    const area = memoryArea(), store = createBrowserRuleStore(area);
    await Promise.all([store.save({ draft: draft() }, NOW), store.save({ draft: draft({ name: 'Two' }) }, NOW), store.remove('none')]);
    expect(await store.list()).toHaveLength(2);
    area.values.set(BROWSER_RULES_KEY, { version: 1, rules: [...(area.values.get(BROWSER_RULES_KEY) as { rules: unknown[] }).rules,
      { id: 'broken', definition: { name: 'x' }, folderNativeId: '30', enabled: true, createdAt: NOW, updatedAt: NOW }] });
    expect(await store.list()).toHaveLength(2);
  });

  it('logs each placed save once and keeps the newest twenty', async () => {
    const area = memoryArea(), store = createBrowserRuleStore(area);
    const placement = (index: number) => ({ id: `c-${index}`, ruleId: 'b-1', ruleName: 'Papers', folder: 'Papers', title: `Paper ${index}`,
      url: `https://arxiv.org/abs/${index}`, at: NOW + index });
    expect(await store.logPlacement(placement(1))).toBe(true);
    expect(await store.logPlacement(placement(1))).toBe(false);
    for (let index = 2; index <= 25; index++) await store.logPlacement(placement(index));
    const logged = await store.placements();
    expect(logged).toHaveLength(20);
    expect(logged[0]).toMatchObject({ id: 'c-25' });
    expect(area.values.has(BROWSER_PLACEMENTS_KEY)).toBe(true);
  });
});
