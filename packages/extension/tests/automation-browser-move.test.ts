import { describe, expect, it } from 'vitest';
import { BROWSER_PLACEMENTS_KEY, createBrowserPlacementLog } from '../src/automation/browser-rule-store.js';
import { accountEditorUrl, type BrowserRule } from '../src/automation/browser-rules.js';
import { checkRuleDraft, type RuleDraft } from '../src/automation/rule-conditions.js';
import type { AtomicStateArea } from '../src/automation/bundle-store.js';
import { createRuleListStore, individualRules } from '../src/automation/rule-list-store.js';
import { memoryStateArea as memoryArea, NOW } from './automation-fixture.js';

/** AW-71: a browser rule goes to the account only through the filled-in web editor, and waits there to retire. */
type Draft = Partial<RuleDraft> & { readonly folderNativeId?: string };
const draft = ({ folderNativeId = '30', ...over }: Draft = {}): RuleDraft =>
  ({ name: 'arxiv.org → Papers', combinator: 'any', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }, { kind: 'titleContains', value: 'Paper: notes' }],
    action: { kind: 'file', folderNativeId }, ...over });
function stored(over: Draft = {}): BrowserRule {
  const checked = checkRuleDraft(draft(over));
  if (!checked.ok) throw new Error('invalid draft');
  return { id: 'b-1', definition: checked.definition, folderNativeId: '30', enabled: true, createdAt: NOW, updatedAt: NOW };
}

describe('the web editor, filled in', () => {
  it('carries the name, the conditions and the synced folder, in the form the web reads', () => {
    const url = new URL(accountEditorUrl('https://colp.example/automations/', stored(), { collectionId: 'c_personal', nodeId: 'n_papers' })!);
    expect(url.origin + url.pathname).toBe('https://colp.example/automations/new');
    expect([...url.searchParams]).toEqual([['collectionId', 'c_personal'], ['folderId', 'n_papers'], ['name', 'arxiv.org → Papers'], ['combinator', 'any'],
      ['condition', 'siteIs:arxiv.org'], ['condition', 'titleContains:Paper: notes'], ['from', 'browser']]);
  });

  it('is not offered for a rule the editor cannot show', () => {
    const rule = stored();
    const odd = { ...rule, definition: { ...rule.definition, match: { kind: 'not' as const, item: rule.definition.match } } };
    expect(accountEditorUrl('https://colp.example/automations', odd, { collectionId: 'c', nodeId: 'n' })).toBeNull();
  });
});

describe('a rule waiting to move', () => {
  it.each(['edit', 'keep'] as const)('does not retire after a queued %s commits', async (change) => {
    const base = memoryArea();
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let blockNext = false;
    const area: AtomicStateArea = {
      get: base.get,
      commit: base.commit,
      set: async (key, value) => {
        if (blockNext) { blockNext = false; writeStarted?.(); await gate; }
        await base.set(key, value);
      },
    };
    const store = createRuleListStore(area, { id: () => 'b-1' });
    await store.saveRule({ draft: draft() }, NOW);
    await store.markMoving('b-1', NOW + 1);
    const snapshot = individualRules(await store.load())[0]!;
    const account = [{ id: 'a-1', definition: snapshot.definition, folderNativeId: '30' }];
    blockNext = true;
    const userChange = change === 'edit'
      ? store.saveRule({ id: 'b-1', draft: draft({ name: 'Edited', folderNativeId: '31' }) }, NOW + 2)
      : store.stopMoving('b-1');
    await started;
    const refreshes = [store.retireIfDuplicate('b-1', account, NOW + 3), store.retireIfDuplicate('b-1', account, NOW + 3)];
    releaseWrite?.();
    await userChange;
    expect(await Promise.all(refreshes)).toEqual([null, null]);
    expect(individualRules(await store.load())).toMatchObject([{ id: 'b-1' }]);
    expect(individualRules(await store.load())[0]).not.toHaveProperty('movingSince');
  });

  it('is marked once, keeps the first time, and stops waiting when it is edited', async () => {
    const store = createRuleListStore(memoryArea(), { id: () => 'b-1' });
    await store.saveRule({ draft: draft() }, NOW);
    expect(await store.markMoving('b-1', NOW + 1)).toMatchObject({ movingSince: NOW + 1 });
    expect(await store.markMoving('b-1', NOW + 2)).toMatchObject({ movingSince: NOW + 1 });
    expect(individualRules(await store.load())[0]).toMatchObject({ movingSince: NOW + 1 });
    await store.setEnabled({ kind: 'rule', id: 'b-1' }, false, NOW + 3);
    expect(individualRules(await store.load())[0]).toMatchObject({ movingSince: NOW + 1 });
    await store.saveRule({ id: 'b-1', draft: draft({ name: 'Edited' }) }, NOW + 4);
    expect(individualRules(await store.load())[0]).not.toHaveProperty('movingSince');
    expect(await store.markMoving('missing', NOW)).toBeNull();
  });

  it('stops waiting when kept in this browser, and keeps everything else (U5)', async () => {
    const store = createRuleListStore(memoryArea(), { id: () => 'b-1' });
    await store.saveRule({ draft: draft() }, NOW);
    await store.markMoving('b-1', NOW + 1);
    const kept = await store.stopMoving('b-1');
    expect(kept).not.toHaveProperty('movingSince');
    expect(kept).toMatchObject({ id: 'b-1', enabled: true, action: { kind: 'file', folderNativeId: '30' } });
    expect(individualRules(await store.load())[0]).not.toHaveProperty('movingSince');
    expect(await store.stopMoving('b-1')).toMatchObject({ id: 'b-1' });
    expect(await store.stopMoving('missing')).toBeNull();
  });
});

describe('the placement log', () => {
  it('keeps why a page stayed where it was saved, and drops a reason it does not know (U6)', async () => {
    const area = memoryArea();
    const store = createBrowserPlacementLog(area);
    const base = { ruleId: 'b-1', ruleName: 'Papers', folder: 'Inbox', title: 'A paper', url: 'https://arxiv.org/abs/1', at: NOW };
    await store.logPlacement({ ...base, id: 'c-1', kept: 'conflict' });
    await store.logPlacement({ ...base, id: 'c-2', at: NOW + 1 });
    expect((await store.placements()).map((item) => [item.id, item.kept])).toEqual([['c-2', undefined], ['c-1', 'conflict']]);
    await area.set(BROWSER_PLACEMENTS_KEY, [{ ...base, id: 'c-3', kept: 'elsewhere' }]);
    expect(await store.placements()).toEqual([]);
  });
});
