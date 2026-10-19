import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validBrowserRuleCommand } from '../src/automation/messages.js';
import { checkRuleDraft, type RuleAction, type RuleCondition } from '../src/automation/rule-conditions.js';
import type { ListEntry, LocalRule, LocalSet, RuleListRecord } from '../src/automation/rule-list-store.js';
import { buildRulesConfig, configEntries, parseRulesConfig, suggestFolders, type RulesConfig } from '../src/automation/rules-config-format.js';
import { newSubscription, subscriptionKeys, type LocalAdjustments, type SubscriptionRecord } from '../src/automation/subscription-store.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 §5.3, RS-07.4, RS-19.3/4: the rule configuration as a closed file whose folders are always chosen again here. */
const folders = vi.hoisted(() => new Map<string, { id: string; title: string; parentId: string; url?: string }>());
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ assertBookmarkFolderAllowed: async () => undefined }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async (id: string) => id === 'managed' }));

import { handleConfigCommand } from '../src/sw/automation-config.js';
import { handleRulesetCommand } from '../src/sw/automation-ruleset.js';
import { riskStore } from '../src/sw/risk.js';
import { browserRuleStore, browserSubscriptionStore, handleBrowserRuleCommand } from '../src/sw/automation-browser.js';

function rule(id: string, conditions: RuleCondition[], action: RuleAction, enabled = true): LocalRule {
  const checked = checkRuleDraft({ name: `Rule ${id}`, combinator: 'all', conditions, action });
  if (!checked.ok) throw new Error('invalid draft');
  return { id, enabled, name: checked.name, combinator: 'all', conditions: checked.conditions, action, definition: checked.definition,
    compiledFrom: { contentVersions: {} }, createdAt: NOW - 5, updatedAt: NOW - 5, reviewed: [{ accountRuleId: 'acct', key: '1:1' }] };
}
const research: LocalSet = { id: 'set-1', name: 'Research', enabled: false, createdAt: NOW - 5, updatedAt: NOW - 5,
  origin: { kind: 'import', sourceId: 'community-tech', sourceName: 'Community technology sites', sourceVersion: '2026.10.18-1', publisher: 'Example Collective', importedAt: NOW - 9 },
  roles: [{ key: 'papers', description: 'Academic papers' }, { key: 'code', description: 'Source code' }], bindings: { papers: '30', code: '32' },
  rules: [rule('r-role', [{ kind: 'siteEndsWith', value: 'arxiv.org' }], { kind: 'file', role: 'papers' }),
    rule('r-own', [{ kind: 'pathUnder', value: '/docs' }], { kind: 'file', folderNativeId: '31' }, false)] };
const record: RuleListRecord = { version: 2, revision: 9, enabled: true, entries: [
  { kind: 'rule', rule: rule('r-1', [{ kind: 'siteIs', value: 'arxiv.org' }, { kind: 'titleContains', value: 'paper' }], { kind: 'file', folderNativeId: '30' }) },
  { kind: 'set', set: research },
  { kind: 'rule', rule: rule('r-keep', [{ kind: 'siteIs', value: 'example.org' }], { kind: 'keepHere' }) },
  { kind: 'subscription', subscriptionId: 'sub-1', enabled: true }] };
const paths: Record<string, { title: string; path: string[] }> = { 30: { title: 'Papers', path: ['Bookmarks bar', 'Papers'] },
  31: { title: 'Docs', path: ['Bookmarks bar', 'Docs'] }, 32: { title: 'Code', path: ['Other bookmarks', 'Code'] } };
const subscription: SubscriptionRecord = { ...newSubscription('sub-1', { url: 'https://rules.example.org/community.json', origin: 'https://rules.example.org',
  updatePolicy: 'auto', refreshIntervalHours: 168, paused: true }, NOW - 9), state: 'ready', currentVersion: '4', etag: '"4"', lastSuccessAt: NOW - 2 };
const adjustments: LocalAdjustments = { disabledEntryIds: ['e-off'], exceptions: [{ id: 'x-1', scope: 'domain', value: 'example.org', createdAt: NOW - 3 }],
  bindings: { papers: '31' } };
const exported = () => buildRulesConfig(record, async (id) => paths[id] ?? null, NOW,
  (id) => id === 'sub-1' ? { record: subscription, local: adjustments } : null);
let next = 0;
const newId = () => `new-${++next}`;

describe('the file', () => {
  it('validates raw predicates and refuses ambiguous or executable rule payloads', () => {
    const raw = { id: 'advanced', enabled: true, name: 'Docs', combinator: 'all', conditions: [], action: { kind: 'keepHere' },
      match: { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/docs' } };
    const config = (rule: unknown) => ({ format: 'known-rules-config/v1', exportedAt: NOW,
      folders: [], list: { enabled: true, entries: [{ kind: 'rule', rule }] } });
    expect(parseRulesConfig(config(raw)).list.entries).toHaveLength(1);
    expect(() => parseRulesConfig(config({ ...raw, conditions: [{ kind: 'siteIs', value: 'example.org' }] }))).toThrow('config_invalid');
    expect(() => parseRulesConfig(config({ ...raw, match: { ...raw.match, op: 'matches' } }))).toThrow('config_invalid');
    expect(() => parseRulesConfig(config({ ...raw, match: { ...raw.match, script: 'alert(1)' } }))).toThrow('config_invalid');
    expect(() => parseRulesConfig(config({ ...raw, definition: { tasks: [] } }))).toThrow('config_invalid');
  });

  it('round-trips the list: order, switches, conditions, actions, a set’s origin, roles and bindings, and subscription entries', async () => {
    const file = JSON.parse(JSON.stringify(await exported())) as unknown;
    const config = parseRulesConfig(file);
    expect(config.folders).toEqual([{ nativeId: '30', title: 'Papers', path: ['Bookmarks bar', 'Papers'] },
      { nativeId: '31', title: 'Docs', path: ['Bookmarks bar', 'Docs'] }, { nativeId: '32', title: 'Code', path: ['Other bookmarks', 'Code'] }]);
    const made = configEntries(config, { 30: '70', 31: '71', 32: '72' }, newId, NOW);
    if ('error' in made) throw new Error(made.error);
    const shape = (entries: readonly ListEntry[]) => entries.map((entry) => entry.kind === 'rule'
      ? { kind: 'rule', enabled: entry.rule.enabled, name: entry.rule.name, conditions: entry.rule.conditions, action: entry.rule.action, definition: entry.rule.definition }
      : entry.kind === 'set' ? { kind: 'set', name: entry.set.name, enabled: entry.set.enabled, origin: entry.set.origin, roles: entry.set.roles,
        bindings: entry.set.bindings, rules: entry.set.rules.map((item) => [item.name, item.enabled, item.action]) } : entry);
    const here = (id: string) => ({ 30: '70', 31: '71', 32: '72' } as Record<string, string>)[id]!;
    expect(shape(made.entries)).toEqual(shape(record.entries).map((entry) => entry.kind === 'rule' && entry.action && 'folderNativeId' in entry.action
      ? { ...entry, action: { kind: 'file', folderNativeId: here(entry.action.folderNativeId) } }
      : entry.kind === 'set' ? { ...entry, bindings: { papers: '70', code: '72' }, rules: [['Rule r-role', true, { kind: 'file', role: 'papers' }],
        ['Rule r-own', false, { kind: 'file', folderNativeId: '71' }]] } : entry));
    // New ids, the import's time, and nothing of this browser's own state about a rule.
    const first = made.entries[0] as Extract<ListEntry, { kind: 'rule' }>;
    expect([first.rule.id, first.rule.createdAt, 'reviewed' in first.rule, made.skipped]).toEqual(['new-1', NOW, false, 0]);
    // A subscription keeps its id, address, settings and adjustments, its folders chosen here; nothing it fetched is in the file (RS-19.3).
    expect(made.subscriptions).toEqual([{ config: { id: 'sub-1', enabled: true, url: subscription.url, updatePolicy: 'auto', refreshIntervalHours: 168, paused: true,
      pinned: false, disabledEntryIds: ['e-off'], exceptions: [{ scope: 'domain', value: 'example.org' }], bindings: { papers: '31' } },
    local: { disabledEntryIds: ['e-off'], exceptions: [{ id: expect.any(String), scope: 'domain', value: 'example.org', createdAt: NOW }], bindings: { papers: '71' } } }]);
    expect(JSON.stringify(file)).not.toMatch(/"(?:etag|currentVersion|lastSuccessAt|document|digest)"/u);
  });

  it('never uses a folder id from the file that was not chosen here', async () => {
    const config = parseRulesConfig(JSON.parse(JSON.stringify(await exported())));
    expect(configEntries(config, { 31: '71', 32: '72' }, newId, NOW)).toEqual({ error: 'unmapped' });
    expect(configEntries(config, { 30: '30', 31: '71' }, newId, NOW)).not.toHaveProperty('error');
    // A folder only a binding uses may stay unbound; its role then has no folder.
    const made = configEntries(config, { 30: '70', 31: '71', 32: null }, newId, NOW);
    if ('error' in made) throw new Error(made.error);
    expect((made.entries[1] as Extract<ListEntry, { kind: 'set' }>).set.bindings).toEqual({ papers: '70' });
    const ids = JSON.stringify(made.entries);
    expect(['"32"', '"31"'].map((id) => ids.includes(id))).toEqual([false, false]);
  });

  it('has no key named like a secret, and refuses one', async () => {
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.add(key); walk(item); }
    };
    walk(await exported());
    expect([...keys].filter((key) => /secret|token|passw|authori[sz]|api.?key|credential|cookie|session|bearer/iu.test(key))).toEqual([]);
    const file = JSON.parse(JSON.stringify(await exported())) as RulesConfig & Record<string, unknown>;
    expect(() => parseRulesConfig({ ...file, authorization: 'Bearer x' })).toThrow('config_invalid');
    const withHeader = structuredClone(file) as unknown as { list: { entries: { subscription?: Record<string, unknown> }[] } };
    withHeader.list.entries[3]!.subscription!.Authorization = 'Basic x';
    expect(() => parseRulesConfig(withHeader)).toThrow('config_invalid');
  });

  it('is closed and versioned, and names every folder it uses', async () => {
    const file = JSON.parse(JSON.stringify(await exported())) as RulesConfig;
    expect(() => parseRulesConfig({ ...file, format: 'known-rules-config/v2' })).toThrow('config_version_unsupported');
    expect(() => parseRulesConfig({ ...file, format: 'known-browser-backup' })).toThrow('config_invalid');
    expect(() => parseRulesConfig({ ...file, folders: file.folders.slice(1) })).toThrow('config_invalid');
    const extra = structuredClone(file) as unknown as { list: { entries: { rule?: Record<string, unknown> }[] } };
    extra.list.entries[0]!.rule!.definition = {};
    expect(() => parseRulesConfig(extra)).toThrow('config_invalid');
  });

  it('suggests the folder here with exactly the same path, and nothing when that is not one folder', () => {
    const here = [{ id: 'a', path: ['Bookmarks bar', 'Papers'] }, { id: 'b', path: ['Bookmarks bar', 'Docs'] }, { id: 'c', path: ['Bookmarks bar', 'Docs'] }];
    expect(suggestFolders([{ nativeId: '30', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }, { nativeId: '31', title: 'Docs', path: ['Bookmarks bar', 'Docs'] },
      { nativeId: '32', title: 'Code', path: ['Other bookmarks', 'Code'] }, { nativeId: '33', title: '', path: [] }], here))
      .toEqual({ 30: 'a', 31: null, 32: null, 33: null });
  });
});

describe('the worker', () => {
  const subscribed = (id: string, url: string): RulesConfig => ({ format: 'known-rules-config/v1', exportedAt: NOW, folders: [{ nativeId: '9', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }],
    list: { enabled: true, entries: [{ kind: 'subscription', subscription: { id, enabled: true, url, updatePolicy: 'review', refreshIntervalHours: 24, paused: false,
      pinned: false, disabledEntryIds: [], exceptions: [{ scope: 'host', value: 'docs.example.org' }], bindings: { papers: '9' } } }] } });
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    folders.clear();
    for (const [id, title, parentId] of [['1', 'Bookmarks bar', '0'], ['30', 'Papers', '1'], ['31', 'Docs', '1'], ['70', 'Reading', '1'], ['managed', 'Subscribed', '1']]) {
      folders.set(id!, { id: id!, title: title!, parentId: parentId! });
    }
    folders.set('b1', { id: 'b1', title: 'A bookmark', parentId: '1', url: 'https://example.org/' });
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } },
      bookmarks: { get: async (id: string) => { const node = folders.get(id); if (!node) throw new Error('Can’t find bookmark for id.'); return [node]; } } });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: { name: 'Mine', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'mine.example' }],
      action: { kind: 'file', folderNativeId: '30' } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('preserves an imported path predicate and its destination across full backup and replacement', async () => {
    const text = JSON.stringify({ format: 'colp.ruleset/v1', id: 'docs', name: 'Docs', version: '1',
      roles: [{ key: 'docs', description: 'Documentation' }], sites: [{ id: 'site', name: 'Site', addresses: [
        { host: 'example.org', scope: 'exact', status: 'current', pathPrefix: '/docs' },
      ] }], entries: [{ id: 'docs', site: 'site', role: 'docs' }] });
    const added = await handleRulesetCommand({ kind: 'known.automation.browser.import', text, bindings: { docs: '30' } });
    if (!added.ok || !('set' in added) || !added.set) throw new Error('not imported');
    expect(added.set.rules[0]!.conditions).toEqual([]);
    const match = added.set.rules[0]!.definition.match;
    const out = await handleConfigCommand({ kind: 'known.automation.browser.config.export' });
    if (!out.ok || !('config' in out)) throw new Error('not exported');
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: out.config.content,
      folders: { 30: '70' }, replace: true })).toMatchObject({ ok: true, imported: { rules: 2, skipped: 0 } });
    const set = (await browserRuleStore().load()).entries.find(entry => entry.kind === 'set');
    expect(set).toMatchObject({ kind: 'set', set: { bindings: { docs: '70' }, rules: [{ conditions: [], definition: { match } }] } });
  });

  it.each([true, false])('replacement restores the exported list switch (%s), append preserves the local switch', async enabled => {
    await browserRuleStore().setListEnabled(enabled);
    const out = await handleConfigCommand({ kind: 'known.automation.browser.config.export' });
    if (!out.ok || !('config' in out)) throw new Error('not exported');
    await browserRuleStore().setListEnabled(!enabled);
    const command = { kind: 'known.automation.browser.config.import' as const, text: out.config.content, folders: { 30: '70' } };
    expect(await handleConfigCommand({ ...command, replace: false })).toMatchObject({ ok: true });
    expect((await browserRuleStore().load()).enabled).toBe(!enabled);
    expect(await handleConfigCommand({ ...command, replace: true })).toMatchObject({ ok: true });
    expect((await browserRuleStore().load()).enabled).toBe(enabled);
  });

  it('exports the list with its folders’ paths, and imports it below the list or in its place', async () => {
    const out = await handleConfigCommand({ kind: 'known.automation.browser.config.export' });
    if (!out.ok || !('config' in out)) throw new Error('no export');
    expect(out.config.filename).toMatch(/^known-rules-config-\d{4}-\d{2}-\d{2}\.json$/u);
    const text = out.config.content;
    expect(JSON.parse(text)).toMatchObject({ format: 'known-rules-config/v1', folders: [{ nativeId: '30', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }] });
    const command = (folderMap: Record<string, string | null>, replace: boolean) =>
      ({ kind: 'known.automation.browser.config.import' as const, text, folders: folderMap, replace });
    expect(validBrowserRuleCommand(command({ 30: '70' }, false))).toBe(true);
    expect(await handleConfigCommand(command({}, false))).toEqual({ ok: false, error: 'unmapped' });
    expect(await handleConfigCommand(command({ 30: 'b1' }, false))).toEqual({ ok: false, error: 'folderGone' });
    expect(await handleConfigCommand(command({ 30: 'managed' }, false))).toEqual({ ok: false, error: 'folderGone' });
    expect(await handleConfigCommand(command({ 30: '70' }, false))).toMatchObject({ ok: true, imported: { rules: 1, sets: 0, skipped: 0 } });
    const after = (await browserRuleStore().load()).entries.map((entry) => entry.kind === 'rule' ? [entry.rule.name, entry.rule.action] : entry.kind);
    expect(after).toEqual([['Mine', { kind: 'file', folderNativeId: '30' }], ['Mine', { kind: 'file', folderNativeId: '70' }]]);
    expect(await handleConfigCommand(command({ 30: '31' }, true))).toMatchObject({ ok: true, imported: { rules: 1 } });
    expect((await browserRuleStore().load()).entries.map((entry) => entry.kind === 'rule' ? entry.rule.action : entry.kind))
      .toEqual([{ kind: 'file', folderNativeId: '31' }]);
    expect(await handleConfigCommand({ ...command({ 30: '70' }, false), text: '{"format":"known-rules-config/v9"}' })).toEqual({ ok: false, error: 'unsupported' });
    expect(await handleConfigCommand({ ...command({ 30: '70' }, false), text: 'not json' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('recreates a subscription not ready, with its settings and folders chosen here, and leaves out a second one to the same address', async () => {
    const text = JSON.stringify(subscribed('sub-9', 'https://rules.example.org/community.json'));
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text, folders: { 9: '30' }, replace: false }))
      .toMatchObject({ ok: true, imported: { subscriptions: 1, skipped: 0 } });
    expect(await browserSubscriptionStore().get('sub-9')).toMatchObject({ state: 'notReady', url: 'https://rules.example.org/community.json', lastAttemptAt: null,
      updatePolicy: 'review', refreshIntervalHours: 24 });
    expect(await browserSubscriptionStore().adjustments('sub-9')).toMatchObject({ bindings: { papers: '30' }, exceptions: [{ scope: 'host', value: 'docs.example.org' }] });
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: JSON.stringify(subscribed('sub-10', 'https://rules.example.org/community.json')),
      folders: { 9: '30' }, replace: false })).toMatchObject({ ok: true, imported: { subscriptions: 0, skipped: 1 } });
    expect(await browserSubscriptionStore().get('sub-10')).toBeNull();
    // Replacing the list takes a subscription it no longer has with every key it had.
    await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: JSON.stringify(subscribed('sub-11', 'https://rules.example.org/other.json')),
      folders: { 9: '30' }, replace: true });
    expect([await browserSubscriptionStore().get('sub-9'), await browserSubscriptionStore().get('sub-11')]).toEqual([null, expect.objectContaining({ state: 'notReady' })]);
    expect((await browserRuleStore().load()).entries.map((entry) => entry.kind === 'subscription' ? entry.subscriptionId : entry.kind)).toEqual(['sub-11']);
    expect(subscriptionKeys('sub-9').record).toBe('known.automation.subscription.v1:sub-9');
  });

  it('carries risk alerts — mode, saved exceptions, list addresses — and brings the lists back not ready (§5.3)', async () => {
    let granted = true;
    vi.stubGlobal('chrome', { ...(globalThis.chrome as object), permissions: { contains: async () => granted } });
    const risk = riskStore();
    await risk.create({ url: 'https://lists.example.org/phish.json', origin: 'https://lists.example.org', refreshIntervalHours: 24 }, NOW);
    await risk.addException('host', 'login.example-bank.com', NOW);
    await risk.setMode('onSaveAndBrowse');
    const out = await handleConfigCommand({ kind: 'known.automation.browser.config.export' });
    if (!out.ok || !('config' in out)) throw new Error('no export');
    const file = JSON.parse(out.config.content) as RulesConfig;
    expect(file.risk).toEqual({ mode: 'onSaveAndBrowse', exceptions: [{ scope: 'host', value: 'login.example-bank.com' }],
      lists: [{ url: 'https://lists.example.org/phish.json', refreshIntervalHours: 24, paused: false }] });
    // Another browser, without the browsing permissions: the lists come back not ready. Added to the list here, the mode here stays.
    vi.stubGlobal('indexedDB', new IDBFactory());
    granted = false;
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: out.config.content, folders: { 30: '30' }, replace: false }))
      .toMatchObject({ ok: true, imported: { rules: 1, riskLists: 1 } });
    const here = riskStore();
    expect(await here.all()).toEqual([expect.objectContaining({ url: 'https://lists.example.org/phish.json', state: 'notReady', lastAttemptAt: null, updatePolicy: 'auto' })]);
    expect(await here.settings()).toMatchObject({ mode: 'off', exceptions: [expect.objectContaining({ scope: 'host', value: 'login.example-bank.com' })] });
    // In place of the list, the file's mode is taken: *while browsing* without the permissions is alerts on for saves.
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: out.config.content, folders: { 30: '30' }, replace: true }))
      .toMatchObject({ ok: true, imported: { rules: 1, riskLists: 0 } });
    expect(await here.settings()).toMatchObject({ mode: 'onSave' });
    expect(await here.all()).toHaveLength(1);
    // Closed like the rest: an unknown key, a public suffix as a domain, an address off https.
    expect(() => parseRulesConfig({ ...file, risk: { ...file.risk, extra: 1 } })).toThrow('config_invalid');
    expect(() => parseRulesConfig({ ...file, risk: { ...file.risk!, exceptions: [{ scope: 'domain', value: 'github.io' }] } })).toThrow('config_invalid');
    expect(() => parseRulesConfig({ ...file, risk: { ...file.risk!, lists: [{ url: 'http://lists.example.org/a.json', refreshIntervalHours: 24, paused: false }] } }))
      .toThrow('config_invalid');
    // A file from before risk alerts were in it still reads.
    const { risk: _risk, ...older } = file;
    expect(parseRulesConfig(older)).not.toHaveProperty('risk');
  });

  it('refuses an import past the list’s limits, whole', async () => {
    const many: RulesConfig = { format: 'known-rules-config/v1', exportedAt: NOW, folders: [], list: { enabled: true, entries: Array.from({ length: 200 }, (_, index) => ({
      kind: 'rule' as const, rule: { id: `r${index}`, enabled: true, name: `R${index}`, combinator: 'all' as const, conditions: [{ kind: 'siteIs' as const, value: `s${index}.example` }],
        action: { kind: 'keepHere' as const } } })) } };
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: JSON.stringify(many), folders: {}, replace: false }))
      .toEqual({ ok: false, error: 'limit' });
    expect((await browserRuleStore().load()).entries).toHaveLength(1);
    expect(await handleConfigCommand({ kind: 'known.automation.browser.config.import', text: JSON.stringify(many), folders: {}, replace: true }))
      .toMatchObject({ ok: true, imported: { rules: 200 } });
  });
});
