import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkRuleDraft, type RuleDraft } from '../src/automation/rule-conditions.js';
import { createRuleListStore, RULE_LIST_KEY, PREVIOUS_RULE_LIST_KEY, LEGACY_RULES_KEY, RULE_MIGRATION_KEY, parseRuleList, type LocalRule, type RuleListRecord } from '../src/automation/rule-list-store.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import { decideList } from '../src/automation/rule-list-decide.js';
import { accountEditorUrl } from '../src/automation/browser-rules.js';
import { exportRuleset } from '../src/automation/ruleset-format.js';
import { memoryStateArea, NOW } from './automation-fixture.js';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLayout, type LayoutNativeNode } from '../src/site-adapters/layout.js';
import type { BrowserSiteRuleExtension, NativeBinding, SavePlan, SourceFolderReservation, Representation } from '../src/site-adapters/contracts.js';
import type { SourceContext } from '../src/site-adapters/ledger-types.js';
import { representationKey } from '../src/site-adapters/reservations.js';

const site = (ids?: string[]): BrowserSiteRuleExtension => ({ version: 1, admission: { entries: ['siteFavorite', 'siteImport', 'reconcile'],
  purpose: 'sourceArchive', connectionId: 'connection', ...(ids ? { collectionIds: ids } : {}) }, layout: { kind: 'sourceCollections', root: 'actionDestination' } });
const draft = (ids?: string[], folder = '30'): RuleDraft => ({ name: 'Archive', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'www.bilibili.com' }],
  action: { kind: 'file', folderNativeId: folder }, site: site(ids) });
function rule(id: string, ids?: string[], folder = '30'): LocalRule {
  const d = draft(ids, folder), checked = checkRuleDraft(d); if (!checked.ok) throw new Error('draft');
  return { id, enabled: true, name: d.name, combinator: d.combinator, conditions: checked.conditions, action: d.action, site: d.site,
    definition: checked.definition, compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW };
}
const list = (...rules: LocalRule[]): RuleListRecord => ({ version: 3, revision: 5, enabled: true, entries: rules.map(rule => ({ kind: 'rule', rule })) });
const page = { title: 'Video', url: 'https://www.bilibili.com/video/av1', explicit: false };
const lookup = async (id: string) => id === '404' ? null : ({ id, title: 'Root' });

describe('v3 source admission and upgrade fences', () => {
  it('filters each B/C edge before first match and leaves ordinary saves to their ordinary rules', async () => {
    const onlyB = rule('B', ['101']), generic = { ...rule('ordinary'), site: undefined };
    const items = flattenList(list(onlyB, generic)).items;
    const edge = { entry: 'siteFavorite' as const, purpose: 'sourceArchive' as const, connectionId: 'connection', collectionId: '101' };
    expect((await decideList(items, page, lookup, NOW, { site: edge })).decision?.item.id).toBe('B');
    expect((await decideList(items, page, lookup, NOW, { site: { ...edge, collectionId: '102' } })).decision).toBeNull();
    expect((await decideList(items, page, lookup, NOW, { site: { ...edge, connectionId: 'other-account' } })).decision).toBeNull();
    expect((await decideList(items, page, lookup, NOW)).decision?.item.id).toBe('ordinary');
    expect((await decideList(flattenList(list(rule('broken', ['101'], '404'), onlyB)).items, page, lookup, NOW, { site: edge })).decision)
      .toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', item: { id: 'broken' } });
  });
  it('requires import admission and include policy without rewriting import origin', async () => {
    const r = rule('B'), excluded = { ...r, definition: { ...r.definition, policy: { ...r.definition.policy, imports: 'exclude' as const } } };
    const edge = { entry: 'siteImport' as const, purpose: 'sourceArchive' as const, connectionId: 'connection', collectionId: '101' };
    expect(r.definition.policy.imports).toBe('include');
    expect((await decideList(flattenList(list(excluded)).items, page, lookup, NOW, { site: edge })).decision).toBeNull();
    expect((await decideList(flattenList(list(r)).items, page, lookup, NOW, { site: edge })).decision?.outcome).toBe('placed');
    expect(checkRuleDraft({ ...draft(), action: { kind: 'keepHere' } }).ok).toBe(false);
  });
  it('migrates v2 order, role bindings and subscriptions atomically, retaining the raw input', async () => {
    const area = memoryStateArea(), r = { ...rule('ordinary'), site: undefined }, v2 = { ...list(r), version: 2, entries: [
      { kind: 'set', set: { id: 'set', name: 'Set', enabled: true, createdAt: NOW, updatedAt: NOW, origin: { kind: 'custom' }, roles: [{ key: 'papers', description: 'Papers' }], bindings: { papers: '30' }, rules: [r] } },
      { kind: 'subscription', subscriptionId: 'subscription', enabled: true },
    ] };
    area.values.set(PREVIOUS_RULE_LIST_KEY, v2);
    const rules = createRuleListStore(area), migrated = await rules.load();
    expect(migrated).toEqual({ ...v2, version: 3 });
    expect(area.values.has(PREVIOUS_RULE_LIST_KEY)).toBe(false);
    expect(area.values.get(RULE_MIGRATION_KEY)).toMatchObject({ previous: v2 });
    // A rolled-back build reads no source rules; its new edits cannot silently replace v3.
    area.values.set(LEGACY_RULES_KEY, { version: 1, rules: [] });
    await expect(rules.load()).rejects.toThrow('legacyRuleMergeRequired');
    expect((await rules.raw()).current).toEqual(migrated);
  });
  it('never overwrites raw data after an aborted migration or an unknown capability/schema', async () => {
    const area = memoryStateArea(), v2 = { ...list(), version: 2 };
    area.values.set(PREVIOUS_RULE_LIST_KEY, v2);
    const rules = createRuleListStore({ ...area, commit: async () => { throw new Error('aborted'); } });
    await expect(rules.load()).rejects.toThrow('aborted');
    expect(area.values.get(PREVIOUS_RULE_LIST_KEY)).toEqual(v2); expect(area.values.has(RULE_LIST_KEY)).toBe(false);
    for (const raw of [{ ...list(), version: 4 }, list({ ...rule('unknown'), site: { ...site(), version: 2 } as never }),
      list({ ...rule('unknown'), unknown: true } as LocalRule), list(rule('duplicate'), rule('duplicate'))]) {
      area.values.delete(PREVIOUS_RULE_LIST_KEY); area.values.set(RULE_LIST_KEY, raw);
      const store = createRuleListStore(area);
      await expect(store.load()).rejects.toThrow('rulesSchemaIncompatible');
      expect((await store.raw()).current).toEqual(raw);
    }
    expect(() => parseRuleList({ ...list(), revision: -1 })).toThrow('rulesSchemaIncompatible');
  });
  it('keeps source admission across ordinary edits and refuses inequivalent account/export conversions', async () => {
    const area = memoryStateArea(); area.values.set(RULE_LIST_KEY, list(rule('B')));
    const store = createRuleListStore(area), { site: _site, ...ordinaryDraft } = draft();
    expect(await store.saveRule({ id: 'B', draft: ordinaryDraft }, NOW)).toMatchObject({ ok: true, rule: { site: site(), definition: { policy: { imports: 'include' } } } });
    expect(await store.markMoving('B', NOW)).toBeNull();
    expect(accountEditorUrl('https://example.org', rule('B'), { collectionId: 'c', nodeId: 'n' })).toBeNull();
    expect(() => exportRuleset({ id: 's', name: 's', enabled: true, createdAt: NOW, updatedAt: NOW, origin: { kind: 'custom' }, roles: [], bindings: {}, rules: [rule('B')] }, () => 'Root', NOW)).toThrow('sourceRulesCannotExport');
  });
});

async function fixture(authorizeCommunity?: import('../src/site-adapters/layout.js').LayoutPorts['authorizeCommunity']) {
  const db = createSourceDatabase(new IDBFactory()), nodes = new Map<string, LayoutNativeNode>([
    ['30', { id: '30', title: 'Root B', dateAdded: 10 }], ['31', { id: '31', title: 'Root C', dateAdded: 11 }],
  ]);
  let record = list(rule('B', ['101']), rule('C', ['102'], '31')), paused = false;
  const context: SourceContext = { connectionId: 'connection', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 1, leaseId: 'lease' };
  const layout = createSourceLayout(db, { rules: async () => flattenList(record), paused: async () => paused, deviceId: async () => 'device',
    authorizeCommunity,
    lookup: async id => nodes.get(id) ?? null, assertRoot: async b => { if (nodes.get(b.nativeId)?.dateAdded !== b.dateAdded) throw new Error('bindingUnavailable'); } });
  await layout.configure({ connectionId: 'connection', enabled: true, liveArchive: true, policy: { revision: 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
  async function facts(item = 'video:av:1', collection = '101', title = 'Same name') {
    await db.transaction(['items', 'collections', 'memberships'], 'readwrite', async tx => {
      tx.objectStore('items').put({ entity: { id: item, identity: 'siteId', kind: 'video', title: 'Video', url: page.url }, ordinal: 1 }, sourceKey('connection', item));
      tx.objectStore('collections').put({ entity: { id: collection, identity: 'siteId', title, parentId: null }, ordinal: 1 }, sourceKey('connection', collection));
      tx.objectStore('memberships').put({ connectionId: 'connection', itemId: item, collectionId: collection, state: 'present', ordinal: 1, liveOrdinal: 1, evidence: 'live', observationId: 'o', conflicts: [] }, sourceKey('connection', item, collection));
    });
  }
  await facts(); await facts('video:av:1', '102');
  const plan = async (item = 'video:av:1', collection = '101', entry: 'siteFavorite' | 'siteImport' = 'siteFavorite') => {
    const result = await layout.plan({ context, itemId: item, collectionId: collection, entry, trigger: entry === 'siteImport'
      ? { kind: 'import', importRunId: 'run', previewId: 'preview' } : { kind: 'observation', observationId: `${item}-${collection}` } });
    if (result.status !== 'planned') throw new Error(result.status); return result.plan;
  };
  return { db, layout, nodes, facts, context, plan, setRecord: (r: RuleListRecord) => { record = r; }, pause: () => { paused = true; } };
}
describe('deterministic layout and native ownership', () => {
  it('pins community provenance in plans and rechecks its independent grant before native dispatch', async () => {
    let permitted = true;
    const f = await fixture(async (_origin, input) => { if (!permitted || input.rootNativeId !== '30' || input.collectionIds[0] !== '101') throw new Error('communityArchiveRevoked'); });
    f.context.communityOrigin = { installationId: 'community', generation: 2, scopeDigest: 'scope', packageDigest: 'bytes' };
    const plan = await f.plan(); expect(plan.communityOrigin).toEqual(f.context.communityOrigin);
    await f.layout.authorize(plan, plan.effects[0]!); permitted = false;
    await expect(f.layout.authorize(plan, plan.effects[0]!)).rejects.toThrow('communityArchiveRevoked');
    await f.facts('video:av:2'); await expect(f.plan('video:av:2')).rejects.toThrow('communityArchiveRevoked');
    expect(await f.db.read('outbox', plan.effects[0]!.commandId)).toBeUndefined(); await f.db.close();
  });
  it('uses separate source identities and roots for B/C even with equal titles; imports remain drafts', async () => {
    const f = await fixture(), b = await f.plan(), c = await f.plan('video:av:1', '102');
    expect(b.mount?.id).not.toBe(c.mount?.id);
    const bf = await f.db.read<SourceFolderReservation>('folderReservations', sourceKey(b.mount!.id, '101'));
    const cf = await f.db.read<SourceFolderReservation>('folderReservations', sourceKey(c.mount!.id, '102'));
    expect(bf?.parent).toMatchObject({ binding: { nativeId: '30' } }); expect(cf?.parent).toMatchObject({ binding: { nativeId: '31' } });
    await f.facts('video:av:2'); const imported = await f.plan('video:av:2', '101', 'siteImport');
    expect(await f.db.read('savePlans', imported.id)).toMatchObject({ state: 'draft' });
    expect(await f.db.read('outbox', imported.effects[1]!.commandId)).toBeUndefined();
    await f.layout.authorize(b, b.effects[0]!); await f.db.close();
  });
  it('checks global/rule/source pause and snapshots before every dispatch', async () => {
    const f = await fixture(), p = await f.plan();
    f.setRecord({ ...list(rule('B', ['101'])), revision: 6 });
    await expect(f.layout.authorize(p, p.effects[0]!)).rejects.toThrow('rulesChanged');
    f.setRecord(list({ ...rule('B', ['101']), enabled: false }));
    await expect(f.layout.authorize(p, p.effects[0]!)).rejects.toThrow('rulesChanged');
    f.setRecord(list(rule('B', ['101']), rule('C', ['102'], '31'))); f.pause();
    await expect(f.layout.authorize(p, p.effects[0]!)).rejects.toThrow('sourceAutomationPaused'); await f.db.close();
  });
  it('requires a migration for a changed root and never switches the stable representation key', async () => {
    const f = await fixture(), p = await f.plan();
    f.setRecord({ ...list(rule('B', ['101'], '31')), revision: 6 });
    await f.facts('video:av:2'); await expect(f.plan('video:av:2')).rejects.toThrow('mountMigrationRequired');
    expect(await f.db.read('mounts', sourceKey('connection', 'B'))).toMatchObject({ id: p.mount!.id, root: { nativeId: '30' } }); await f.db.close();
  });
  it('stops unsent effects when source policy changes, and requires review for a pending folder rename', async () => {
    const f = await fixture(), p = await f.plan();
    await f.facts('video:av:2', '101', 'Renamed before native creation');
    await expect(f.plan('video:av:2')).rejects.toThrow('folderCreationNeedsReview');
    await expect(f.layout.authorize(p, p.effects[0]!)).rejects.toThrow('sourceFactsChanged');
    await f.layout.configure({ connectionId: 'connection', enabled: false, liveArchive: false,
      policy: { revision: 2, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
    await expect(f.layout.authorize(p, p.effects[0]!)).rejects.toThrow('sourceAutomationPaused'); await f.db.close();
  });
  it('preserves a confirmed folder through source and local renames, and stops at a local move', async () => {
    const f = await fixture(), p = await f.plan();
    const key = sourceKey(p.mount!.id, '101'), old = (await f.db.read<SourceFolderReservation>('folderReservations', key))!;
    const native: NativeBinding<'folder'> = { kind: 'folder', bindingId: 'folder', nativeId: 'folder', deviceId: 'device', dateAdded: 20, proof: { kind: 'writeReceipt', id: old.commandId } };
    f.nodes.set('folder', { id: 'folder', title: old.title, dateAdded: 20, parentId: '30' });
    await f.db.transaction(['folderReservations'], 'readwrite', async tx => { tx.objectStore('folderReservations').put({ ...old, state: 'confirmed', native }, key); });
    await f.facts('video:av:2', '101', 'Renamed at source'); const next = await f.plan('video:av:2');
    expect(next.effects[0]).toMatchObject({ reservationId: old.id, folderReservationDigest: old.payloadDigest });
    f.nodes.get('folder')!.title = 'User title';
    await expect(f.layout.authorize(next, next.effects[0]!)).rejects.toThrow('folderManuallyChanged');
    await f.layout.nativeChanged(['folder'], false);
    expect(await f.db.read('folderReservations', key)).toMatchObject({ state: 'confirmed', native, nativeTitle: 'User title' });
    await f.layout.authorize(next, next.effects[0]!);
    f.nodes.get('folder')!.parentId = 'other-parent'; await f.layout.nativeChanged(['folder'], false);
    expect(await f.db.read('folderReservations', key)).toMatchObject({ state: 'blocked', native }); await f.db.close();
  });
  it('retains suppression after deletion instead of recreating a source copy', async () => {
    const f = await fixture(), p = await f.plan(), e = p.effects[1]!;
    if (e.kind !== 'createBookmark') throw new Error('effect');
    const representation: Representation = { ...e.representation, native: { kind: 'bookmark', nativeId: 'saved', bindingId: 'saved', deviceId: 'device', dateAdded: 30, proof: { kind: 'writeReceipt', id: e.commandId } }, manualRevision: 0, state: 'active' };
    await f.db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').put(representation, representationKey(e.representation)); });
    await f.layout.nativeChanged(['saved'], true);
    const result = await f.layout.plan({ context: f.context, itemId: 'video:av:1', collectionId: '101', entry: 'siteFavorite', trigger: { kind: 'observation', observationId: 'later' } });
    expect(result.status).toBe('suppressed');
    expect(await f.db.read('representations', representationKey(e.representation))).toMatchObject({ state: 'suppressed', manualRevision: 1 }); await f.db.close();
  });
});

it('replacing a rule preserves the original mount, command and deleted-copy suppression', async () => {
  const f = await fixture();
  try {
    const first = await f.plan(), effect = first.effects.find(e => e.kind === 'createBookmark')!;
    const rep: Representation = { ...effect.representation, native: { kind: 'bookmark', nativeId: 'deleted', dateAdded: 10, deviceId: 'device', bindingId: 'proof', proof: { kind: 'writeReceipt', id: 'receipt' } }, state: 'suppressed', manualRevision: 1 };
    await f.db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').put(rep, representationKey(rep)); });
    f.setRecord(list(rule('replacement', ['101'])));
    expect(await f.layout.plan({ context: f.context, itemId: 'video:av:1', collectionId: '101', entry: 'siteFavorite', trigger: { kind: 'observation', observationId: 'next' } }))
      .toMatchObject({ status: 'suppressed', representation: rep });
    expect(await f.db.read('mounts', sourceKey('connection', 'replacement'))).toMatchObject({ id: first.mount!.id });
  } finally { await f.db.close(); }
});
it('a second rule cannot create a competing mapping in the same destination scope', async () => {
  const f = await fixture();
  try {
    await f.plan(); f.setRecord(list(rule('replacement', ['101'], '31')));
    await expect(f.plan()).rejects.toThrow('sourceMappingMigrationRequired');
  } finally { await f.db.close(); }
});

it('source archive classification and automatic semantic authorization are independent', async () => {
  const f = await fixture();
  try {
    const record = { connectionId: 'connection', enabled: true, liveArchive: true, semantic: 'automatic' as const,
      policy: { revision: 2, copies: 'singleKeepExisting' as const, backgroundClassification: 'disabled' as const, sourceRemoval: 'retainArchive' as const } };
    await expect(f.layout.configure(record)).rejects.toThrow('semanticRequiresTwoCopies');
    await expect(f.layout.configure({ ...record, policy: { ...record.policy, copies: 'sourceAndSemantic' } })).resolves.toBeUndefined();
    expect((await f.plan()).classification).toBe('disabled');
  } finally { await f.db.close(); }
});

it('replans changed live content only before its bookmark command is submitted', async () => {
  const f = await fixture();
  try {
    const original = await f.plan();
    await f.db.transaction(['items'], 'readwrite', async tx => {
      tx.objectStore('items').put({ entity: { id: 'video:av:1', identity: 'siteId', kind: 'video', title: 'Updated title', url: page.url }, ordinal: 2 }, sourceKey('connection', 'video:av:1'));
    });
    const next = await f.plan();
    expect(next.id).not.toBe(original.id);
    expect(await f.db.read('savePlans', original.id)).toMatchObject({ state: 'cancelled' });
    expect(await f.db.read('work', original.id)).toBeUndefined();
    expect(next.effects[1]).toMatchObject({ item: { title: 'Updated title' } });
    const commandId = next.effects[1]!.commandId;
    await f.db.transaction(['outbox'], 'readwrite', async tx => { tx.objectStore('outbox').put({ state: 'submitted' }, commandId); });
    await f.db.transaction(['items'], 'readwrite', async tx => {
      tx.objectStore('items').put({ entity: { id: 'video:av:1', identity: 'siteId', kind: 'video', title: 'Another title', url: page.url }, ordinal: 3 }, sourceKey('connection', 'video:av:1'));
    });
    await expect(f.plan()).rejects.toThrow('conflict');
    expect(await f.db.read('savePlans', next.id)).toMatchObject({ state: 'approved' });
  } finally { await f.db.close(); }
});
it('a new live observation cannot replace an immutable import reservation', async () => {
  const f = await fixture();
  try {
    const imported = await f.plan('video:av:1', '101', 'siteImport');
    await f.db.transaction(['items'], 'readwrite', async tx => {
      tx.objectStore('items').put({ entity: { id: 'video:av:1', identity: 'siteId', kind: 'video', title: 'Updated title', url: page.url }, ordinal: 2 }, sourceKey('connection', 'video:av:1'));
    });
    await expect(f.plan()).rejects.toThrow('conflict');
    expect(await f.db.read('savePlans', imported.id)).toMatchObject({ state: 'draft' });
  } finally { await f.db.close(); }
});

it('a prepared but unsubmitted bookmark command is safely rebound to its replacement plan', async () => {
  const f = await fixture();
  try {
    const original = await f.plan(), commandId = original.effects[1]!.commandId;
    await f.db.transaction(['outbox'], 'readwrite', async tx => {
      tx.objectStore('outbox').put({ state: 'reserved', command: { bookmark: { planId: original.id } } }, commandId);
    });
    const replacement = await f.layout.plan({ context: f.context, itemId: 'video:av:1', collectionId: '101', entry: 'siteFavorite',
      trigger: { kind: 'observation', observationId: 'new-observation' } });
    expect(replacement.status).toBe('planned');
    expect(await f.db.read('outbox', commandId)).toBeUndefined();
    expect(await f.db.read('savePlans', original.id)).toMatchObject({ state: 'cancelled' });
  } finally { await f.db.close(); }
});
