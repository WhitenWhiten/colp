import { describe, expect, it } from 'vitest';
import type { CompiledRule, RuleBundle } from '@know-n/colp/automation';
import type { ProjectionDeps } from '../src/automation/binding-projector.js';
import type { BundleRecord } from '../src/automation/bundle-store.js';
import { blockedPlacement, decidePreSave, preSaveFacts } from '../src/automation/pre-save.js';
import { validAutomationRequest } from '../src/automation/messages.js';
import { COLLECTION_ID, DAY, NOW, SERVER_UUID, compiledRule, folderRef, ruleBundle } from './automation-fixture.js';

/**
 * The pre-save rule path: the installed bundle decides where an extension save
 * goes before the native create, through the same evaluator the server uses.
 */
interface Native { readonly id: string; readonly title: string; readonly parentId?: string; readonly url?: string }
const tree: Native[] = [
  { id: '1', title: 'Bookmarks bar', parentId: '0' },
  { id: '2', title: 'Other bookmarks', parentId: '0' },
  { id: '10', title: 'Academic', parentId: '1' },
  { id: '20', title: 'Reading', parentId: '1' },
  { id: '21', title: 'Inbox', parentId: '20' },
];
function deps(mappings: Readonly<Record<string, string>> = { bar: '1', academic: '10', reading: '20', inbox: '21' }): ProjectionDeps {
  const byColp = new Map(Object.entries(mappings)), byNative = new Map(Object.entries(mappings).map(([colp, native]) => [native, colp]));
  const nodes = new Map(tree.map((node) => [node.id, node]));
  return {
    async mappingByColpId(colpId) { const nativeId = byColp.get(colpId); return nativeId ? { nativeId, nodeKind: 'folder' } : null; },
    async mappingByNativeId(nativeId) { const colpId = byNative.get(nativeId); return colpId ? { colpId, nodeKind: 'folder' } : null; },
    async nativeNode(nativeId) { return nodes.get(nativeId) ?? null; },
  };
}
const record = (bundle: RuleBundle | null, serverUuid: string | null = SERVER_UUID): BundleRecord => ({ version: 1, ownerKey: 'owner', bundle,
  serverUuid, installedAt: NOW, lastRefreshAt: NOW, lastAttemptAt: NOW, failures: 0, pausedSince: null, problem: null });
const scope = { collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 3 };
const arxiv = { url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId: '21', explicit: false };
const decide = (bundle: RuleBundle | null, input: Partial<typeof arxiv> = {}, options: { readonly now?: number; readonly deps?: ProjectionDeps } = {}) =>
  decidePreSave({ record: record(bundle), now: options.now ?? NOW, scope, deps: options.deps ?? deps() }, { ...arxiv, ...input });

describe('pre-save rule decision', () => {
  it('places a matching default save directly in the rule folder and pins what it evaluated', async () => {
    const bundle = ruleBundle([compiledRule({ ruleRevision: '4', bindingRevision: '2' })], { revision: 'b-9', settingsRevision: 7 });
    const decision = await decide(bundle);
    expect(decision?.targetNativeId).toBe('10');
    expect(decision?.automation).toEqual({
      outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-9', settingsRevision: 7, satisfies: ['classify.root'],
      rule: { id: 'rule-arxiv', name: 'Place research papers in Academic', revision: '4', bindingRevision: '2',
        semanticDigest: bundle.rules[0]!.semanticDigest },
      destination: folderRef('academic'), folderTitle: 'Academic', fromNativeId: '21',
      collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 3,
    });
  });

  it('keeps an explicit folder choice and claims nothing', async () => {
    const decision = await decide(ruleBundle([compiledRule()]), { explicit: true });
    expect(decision).toMatchObject({ targetNativeId: null, automation: { outcome: 'kept', satisfies: [], fromNativeId: '21' } });
    expect(decision?.automation).not.toHaveProperty('destination');
  });

  it('applies to nothing when no rule matches, none is installed, it is paused or for another collection', async () => {
    expect(await decide(ruleBundle([compiledRule()]), { url: 'https://example.org/post' })).toBeNull();
    expect(await decide(null)).toBeNull();
    expect(await decide(ruleBundle([], { paused: true }))).toBeNull();
    const other = compiledRule({ definition: { scope: { collectionId: 'c_other' } }, folder: folderRef('academic', 'c_other') });
    expect(await decide(ruleBundle([other]))).toBeNull();
  });

  it('blocks a match whose folder is not mapped here, keeping the save where it was going', async () => {
    const decision = await decide(ruleBundle([compiledRule()]), {}, { deps: deps({ bar: '1', inbox: '21' }) });
    expect(decision).toMatchObject({ targetNativeId: null, automation: { outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] } });
  });

  it('reports an out-of-date copy but never places from it', async () => {
    const bundle = ruleBundle([compiledRule()], { issuedAt: NOW - 8 * DAY });
    const decision = await decide(bundle);
    expect(decision).toMatchObject({ targetNativeId: null, automation: { outcome: 'expired', satisfies: [] } });
  });

  it('leaves equal-priority rules with different folders to review', async () => {
    const bundle = ruleBundle([compiledRule(), compiledRule({ ruleId: 'rule-reading', folder: folderRef('reading') })]);
    expect(await decide(bundle)).toMatchObject({ targetNativeId: null, automation: { outcome: 'conflict', ruleIds: ['rule-arxiv', 'rule-reading'] } });
    const ranked = ruleBundle([compiledRule(), compiledRule({ ruleId: 'rule-reading', folder: folderRef('reading'), priority: 200 })]);
    expect(await decide(ranked)).toMatchObject({ targetNativeId: '20', automation: { outcome: 'placed', rule: { id: 'rule-reading' } } });
  });

  it('sees the default folder as the server would: canonical parent and ancestors, no tags', async () => {
    const scoped = compiledRule({ definition: { scope: { collectionId: COLLECTION_ID, folderRole: 'readingRoot', includeDescendants: true },
      roles: [{ key: 'academicRoot', kind: 'folder', required: true, description: 'Papers' },
        { key: 'readingRoot', kind: 'folder', required: true, description: 'Reading' }] } });
    const rule: CompiledRule = { ...scoped, nativeBindingHints: { ...scoped.nativeBindingHints,
      readingRoot: { kind: 'folder', folder: folderRef('reading'), followIdentity: true, onUnavailable: 'block', notifyOn: [] } } };
    expect(await decide(ruleBundle([rule]))).toMatchObject({ targetNativeId: '10' });
    // Saved to Other bookmarks, outside the rule's scope folder: no match.
    expect(await decide(ruleBundle([rule]), { parentNativeId: '2' })).toBeNull();
    const facts = preSaveFacts({ url: 'https://ArXiv.org/abs/1#x', title: 'A paper' }, COLLECTION_ID,
      { parent: folderRef('inbox'), ancestors: [folderRef('inbox'), folderRef('reading')] }, 'userDefault', NOW);
    expect(facts).toMatchObject({ type: 'node.created', origin: 'sync', intakeDisposition: 'userDefault',
      bookmark: { tags: [], url: { host: 'arxiv.org', path: '/abs/1' }, parent: folderRef('inbox'), ancestors: [folderRef('inbox'), folderRef('reading')] } });
  });

  it('turns a placement whose folder cannot take the save into a blocked rule', async () => {
    const decision = await decide(ruleBundle([compiledRule()]));
    const blocked = blockedPlacement(decision!.automation);
    expect(blocked).toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [], rule: { id: 'rule-arxiv' } });
    expect(blocked).not.toHaveProperty('destination');
  });
});

describe('the popup asking what a rule would do', () => {
  it('accepts a page and the folder it would be saved to, and nothing more', () => {
    const match = { kind: 'known.automation.match', url: 'https://arxiv.org/abs/1', title: 'A paper', parentNativeId: '21' };
    expect(validAutomationRequest(match)).toBe(true);
    expect(validAutomationRequest({ ...match, explicit: true })).toBe(false);
    expect(validAutomationRequest({ ...match, parentNativeId: '../x' })).toBe(false);
    expect(validAutomationRequest({ ...match, url: 'x'.repeat(9000) })).toBe(false);
  });
});
