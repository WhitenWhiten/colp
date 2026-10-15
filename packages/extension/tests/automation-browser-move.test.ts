import { describe, expect, it } from 'vitest';
import { createBrowserRuleStore } from '../src/automation/browser-rule-store.js';
import { accountEditorUrl, checkBrowserDraft, type BrowserRule, type BrowserRuleDraft } from '../src/automation/browser-rules.js';
import type { AutomationStateArea } from '../src/automation/bundle-store.js';
import { NOW } from './automation-fixture.js';

/** AW-71: a browser rule goes to the account only through the filled-in web editor, and waits there to retire. */
const draft = (over: Partial<BrowserRuleDraft> = {}): BrowserRuleDraft =>
  ({ name: 'arxiv.org → Papers', combinator: 'any', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }, { kind: 'titleContains', value: 'Paper: notes' }],
    folderNativeId: '30', ...over });
function stored(over: Partial<BrowserRuleDraft> = {}): BrowserRule {
  const checked = checkBrowserDraft(draft(over));
  if (!checked.ok) throw new Error('invalid draft');
  return { id: 'b-1', definition: checked.definition, folderNativeId: '30', enabled: true, createdAt: NOW, updatedAt: NOW };
}
function memoryArea(): AutomationStateArea {
  const values = new Map<string, unknown>();
  return { get: async (key) => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)); } };
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
  it('is marked once, keeps the first time, and stops waiting when it is edited', async () => {
    const store = createBrowserRuleStore(memoryArea(), { id: () => 'b-1' });
    await store.save({ draft: draft() }, NOW);
    expect(await store.markMoving('b-1', NOW + 1)).toMatchObject({ movingSince: NOW + 1 });
    expect(await store.markMoving('b-1', NOW + 2)).toMatchObject({ movingSince: NOW + 1 });
    expect((await store.list())[0]).toMatchObject({ movingSince: NOW + 1 });
    await store.setEnabled('b-1', false, NOW + 3);
    expect((await store.list())[0]).toMatchObject({ movingSince: NOW + 1 });
    await store.save({ id: 'b-1', draft: draft({ name: 'Edited' }) }, NOW + 4);
    expect((await store.list())[0]).not.toHaveProperty('movingSince');
    expect(await store.markMoving('missing', NOW)).toBeNull();
  });

  it('stops waiting when kept in this browser, and keeps everything else (U5)', async () => {
    const store = createBrowserRuleStore(memoryArea(), { id: () => 'b-1' });
    await store.save({ draft: draft() }, NOW);
    await store.markMoving('b-1', NOW + 1);
    const kept = await store.stopMoving('b-1');
    expect(kept).not.toHaveProperty('movingSince');
    expect(kept).toMatchObject({ id: 'b-1', enabled: true, folderNativeId: '30' });
    expect((await store.list())[0]).not.toHaveProperty('movingSince');
    expect(await store.stopMoving('b-1')).toMatchObject({ id: 'b-1' });
    expect(await store.stopMoving('missing')).toBeNull();
  });
});
