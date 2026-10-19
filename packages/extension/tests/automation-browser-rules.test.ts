import { describe, expect, it } from 'vitest';
import { createBrowserPlacementLog, BROWSER_PLACEMENTS_KEY } from '../src/automation/browser-rule-store.js';
import { editorConditions, resolveBrowserFolder, type FolderLookup } from '../src/automation/browser-rules.js';
import { checkRuleDraft, type RuleCondition } from '../src/automation/rule-conditions.js';
import { memoryStateArea as memoryArea, NOW } from './automation-fixture.js';

/** Browser rules (AW-67, doc 17 RS-07): their folders here, the web editor's form of them, and the pages they filed. */
const folders: Record<string, { id: string; title: string; url?: string; unmodifiable?: string }> = {
  30: { id: '30', title: 'Papers' }, 40: { id: '40', title: 'Managed', unmodifiable: 'managed' },
  50: { id: '50', title: 'A bookmark', url: 'https://example.org/' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;

describe('a rule’s folder here', () => {
  it('is its native id: a rename keeps it, and a new folder with the old title never takes it', async () => {
    expect(await resolveBrowserFolder('30', lookup)).toMatchObject({ status: 'resolved', nativeId: '30', title: 'Papers' });
    folders[30] = { id: '30', title: 'Reading' };
    expect(await resolveBrowserFolder('30', lookup)).toMatchObject({ status: 'resolved', title: 'Reading' });
    folders[31] = { id: '31', title: 'Papers' };
    delete folders[30];
    expect(await resolveBrowserFolder('30', lookup)).toMatchObject({ status: 'unresolved', reason: 'deleted' });
    expect(await resolveBrowserFolder('40', lookup)).toMatchObject({ status: 'unresolved', reason: 'notFolder' });
    expect(await resolveBrowserFolder('50', lookup)).toMatchObject({ status: 'unresolved', reason: 'notFolder' });
  });
});

describe('the web editor’s form of a rule', () => {
  const definition = (conditions: RuleCondition[], combinator: 'all' | 'any' = 'all') => {
    const checked = checkRuleDraft({ name: 'Rule', combinator, conditions, action: { kind: 'file', folderNativeId: '30' } });
    if (!checked.ok) throw new Error('invalid draft');
    return checked.definition;
  };

  it('is the conditions the web can write, and nothing for those it cannot', () => {
    expect(editorConditions(definition([{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Review' }], 'any')))
      .toEqual({ combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'github.com' }, { kind: 'titleContains', value: 'Review' }] });
    expect(editorConditions(definition([{ kind: 'pathUnder', value: '/team' }]))).toBeNull();
  });
});

describe('the placement log', () => {
  it('logs each placed save once and keeps the newest twenty', async () => {
    const area = memoryArea(), store = createBrowserPlacementLog(area);
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

  it('keeps the list entry that decided, and drops one it cannot read', async () => {
    const area = memoryArea(), store = createBrowserPlacementLog(area);
    const base = { ruleId: 'r-1', ruleName: 'GitHub', folder: 'Code', title: 'Repo', url: 'https://github.com/x', at: NOW };
    await store.logPlacement({ ...base, id: 'c-1', entry: { listRevision: 4, kind: 'setRule', ruleId: 'r-1', setId: 's-1' }, sourceName: 'Community' });
    await store.logPlacement({ ...base, id: 'c-2', at: NOW + 1, kept: 'keepHere' });
    expect(await store.placements()).toMatchObject([{ id: 'c-2', kept: 'keepHere' }, { id: 'c-1', sourceName: 'Community', entry: { kind: 'setRule', setId: 's-1' } }]);
    await area.set(BROWSER_PLACEMENTS_KEY, [{ ...base, id: 'c-3', entry: { listRevision: 'x', kind: 'rule' } }]);
    expect(await store.placements()).toEqual([]);
  });
});
