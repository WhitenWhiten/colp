import { compilePredicate, preparePredicateInput } from '@know-n/colp/automation';
import { describe, expect, it } from 'vitest';
import { BROWSER_COLLECTION, type FolderLookup } from '../src/automation/browser-rules.js';
import { preSaveFacts } from '../src/automation/pre-save.js';
import { checkRuleDraft } from '../src/automation/rule-conditions.js';
import { decideList } from '../src/automation/rule-list-decide.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import type { LocalSet } from '../src/automation/rule-list-store.js';
import { exportRuleset, parseRuleset, rulesetSet, sitePredicate } from '../src/automation/ruleset-format.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 §5.1, RS-02: a closed rule-set format; one bad entry refuses the whole file; sites expand to host conditions. */
const example = () => ({
  format: 'colp.ruleset/v1', id: 'community-tech', name: 'Community technology sites', version: '2026.10.18-1', updatedAt: '2026-10-18T00:00:00Z',
  publisher: { name: 'Example Collective', url: 'https://example.org', feedbackUrl: 'https://example.org/issues' }, license: 'CC-BY-4.0',
  roles: [{ key: 'papers', description: 'Academic papers' }, { key: 'code', description: 'Source code' }],
  sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] },
    { id: 'mirror', name: 'Example mirror set', addresses: [{ host: 'example-mirror.org', scope: 'domain', status: 'current', since: '2024-01-01' },
      { host: 'example-mirror.xyz', scope: 'domain', status: 'revoked', since: '2023-01-01', until: '2024-01-01' }] }],
  entries: [{ id: 'e-arxiv', name: 'arXiv', site: 'arxiv', role: 'papers' },
    { id: 'e-gh', name: 'GitHub repositories', match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'github.com' }, role: 'code' },
    { id: 'e-mirror', site: 'mirror' }],
}) as unknown as Record<string, unknown> & { sites: { addresses: Record<string, unknown>[] }[]; entries: Record<string, unknown>[] };
const parse = (doc: unknown) => parseRuleset(JSON.stringify(doc));
const matches = (predicate: Parameters<typeof compilePredicate>[0], url: string) => {
  const compiled = compilePredicate(predicate);
  if (!compiled.valid) throw new Error('invalid');
  const facts = preSaveFacts({ url, title: '' }, BROWSER_COLLECTION, { ancestors: [] }, 'userDefault', NOW);
  return compiled.evaluate(facts, { inputSnapshot: preparePredicateInput(facts) }).outcome === 'matched';
};
const folders: Record<string, { id: string; title: string }> = { 30: { id: '30', title: 'Papers' }, 32: { id: '32', title: 'Code' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;

describe('parsing', () => {
  it('reads the design pack’s example: role entries become rules, an entry without a role is matching data only', () => {
    const parsed = parse(example());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    expect(parsed.ruleset).toMatchObject({ id: 'community-tech', version: '2026.10.18-1', publisher: { name: 'Example Collective' }, license: 'CC-BY-4.0' });
    expect(parsed.left).toEqual({ matchingOnly: 1, inactive: 0 });
    expect(parsed.compiled.map((item) => [item.entry.id, item.name, item.conditions])).toEqual([
      ['e-arxiv', 'arXiv', { combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'arxiv.org' }] }],
      ['e-gh', 'GitHub repositories', { combinator: 'all', conditions: [{ kind: 'siteIs', value: 'github.com' }] }]]);
  });

  it('is closed: a key outside the format is a problem wherever it is, so no folder, credential or task can ride along', () => {
    const doc = example();
    doc.folder = 'Bookmarks bar/Papers';
    doc.entries[0]!.folderId = '30';
    doc.sites[0]!.addresses[0]!.token = 'x';
    const parsed = parse(doc);
    expect(parsed).toEqual({ ok: false, problems: [{ pointer: '/folder', code: 'unknownKey' }, { pointer: '/sites/0/addresses/0/token', code: 'unknownKey' },
      { pointer: '/entries/0/folderId', code: 'unknownKey' }] });
  });

  it('refuses the whole file for one bad entry, and names where', () => {
    const doc = example();
    doc.entries.push({ id: 'e-bad', match: { kind: 'field', field: 'bookmark.url.host', op: 'matches', value: '.*' }, role: 'code' });
    expect(parse(doc)).toEqual({ ok: false, problems: [{ pointer: '/entries/3/match', code: 'invalidMatch' }] });
    const other = example();
    other.entries.push({ id: 'e-arxiv', site: 'nowhere', match: { kind: 'all', items: [] }, role: 'video' });
    expect(parse(other)).toEqual({ ok: false, problems: [{ pointer: '/entries/3/role', code: 'unknownRole' }, { pointer: '/entries/3', code: 'oneOf' }] });
  });

  it('takes 48 addresses for a site, grouped under the core’s limits, and refuses 49', () => {
    const site = (count: number) => ({ ...example(), sites: [{ id: 'many', name: 'Many', addresses: Array.from({ length: count }, (_, index) =>
      ({ host: `site-${index}.example`, scope: index % 2 ? 'exact' : 'domain', status: 'current' })) }],
      entries: [{ id: 'e-many', site: 'many', role: 'papers' }] });
    const parsed = parse(site(48));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const [only] = parsed.compiled;
    expect(only!.conditions).toBeNull();
    expect(compilePredicate(only!.definition.match).valid).toBe(true);
    expect(matches(only!.definition.match, 'https://docs.site-46.example/x')).toBe(true);
    expect(matches(only!.definition.match, 'https://docs.site-47.example/x')).toBe(false);
    expect(matches(only!.definition.match, 'https://site-47.example/x')).toBe(true);
    expect(parse(site(49))).toEqual({ ok: false, problems: [{ pointer: '/sites/0/addresses', code: 'tooMany' }] });
    // An address with a path prefix is three nodes: 41 fit the core's 128, 42 do not, and the file says so at the site.
    const prefixed = (count: number) => ({ ...example(), sites: [{ id: 'many', name: 'Many', addresses: Array.from({ length: count }, (_, index) =>
      ({ host: `site-${index}.example`, scope: 'domain', status: 'current', pathPrefix: '/docs' })) }], entries: [{ id: 'e-many', site: 'many', role: 'papers' }] });
    const ok = parse(prefixed(41));
    expect(ok.ok && compilePredicate(ok.compiled[0]!.definition.match).valid).toBe(true);
    expect(parse(prefixed(42))).toEqual({ ok: false, problems: [{ pointer: '/sites/0/addresses', code: 'tooMany' }] });
  });

  it('names a missing required key once', () => {
    const { id: _id, ...noId } = example();
    expect(parse(noId)).toEqual({ ok: false, problems: [{ pointer: '/id', code: 'required' }] });
  });

  it('never matches a revoked address, keeps a path prefix to its host, and counts a site with only retired addresses', () => {
    const doc = example();
    doc.sites.push({ id: 'old', name: 'Old', addresses: [{ host: 'old.example', scope: 'domain', status: 'revoked' }] } as never);
    doc.sites.push({ id: 'docs', name: 'Docs', addresses: [{ host: 'example.com', scope: 'exact', status: 'historical', pathPrefix: '/docs/' }] } as never);
    doc.entries.push({ id: 'e-old', site: 'old', role: 'papers' }, { id: 'e-docs', site: 'docs', role: 'code' });
    const parsed = parse(doc);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    expect(parsed.left).toEqual({ matchingOnly: 1, inactive: 1 });
    const mirror = sitePredicate(parsed.ruleset.sites[1]!)!;
    expect([matches(mirror, 'https://example-mirror.org/a'), matches(mirror, 'https://example-mirror.xyz/a')]).toEqual([true, false]);
    const docs = parsed.compiled.find((item) => item.entry.id === 'e-docs')!;
    expect(docs.conditions).toBeNull();
    expect([matches(docs.definition.match, 'https://example.com/docs/a'), matches(docs.definition.match, 'https://example.com/blog'),
      matches(docs.definition.match, 'https://other.example/docs/a')]).toEqual([true, false, false]);
  });

  it('names its problems by JSON pointer, ten at most, and says when the file is not this format at all', () => {
    const doc = example();
    doc.entries = Array.from({ length: 14 }, (_, index) => ({ id: `e ${index}`, site: 'arxiv' }));
    const parsed = parse(doc);
    expect(parsed.ok ? [] : parsed.problems).toHaveLength(10);
    expect(parsed.ok ? null : parsed.problems[0]).toEqual({ pointer: '/entries/0/id', code: 'pattern' });
    expect(parseRuleset('{')).toEqual({ ok: false, problems: [{ pointer: '', code: 'json' }] });
    expect(parse({ ...example(), format: 'colp.risklist/v1' })).toEqual({ ok: false, problems: [{ pointer: '/format', code: 'format' }] });
    expect(parseRuleset(' '.repeat(2 * 1024 * 1024 + 1))).toEqual({ ok: false, problems: [{ pointer: '', code: 'tooLarge' }] });
    const host = example();
    host.sites[0]!.addresses[0]!.host = 'http://arxiv.org/abs';
    expect(parse(host)).toEqual({ ok: false, problems: [{ pointer: '/sites/0/addresses/0/host', code: 'invalidHost' }] });
  });
});

describe('the set an import adds', () => {
  it('files by role, keeps the editor’s conditions where they fit, and blocks a match while its role has no folder (RS-02.3)', async () => {
    const parsed = parse(example());
    if (!parsed.ok) throw new Error('invalid');
    let n = 0;
    const set = rulesetSet(parsed, { papers: '30', video: '99' }, () => `id-${++n}`, NOW);
    expect(set).toMatchObject({ name: 'Community technology sites', bindings: { papers: '30' },
      origin: { kind: 'import', sourceId: 'community-tech', sourceName: 'Community technology sites', sourceVersion: '2026.10.18-1', publisher: 'Example Collective' },
      rules: [{ name: 'arXiv', action: { kind: 'file', role: 'papers' }, conditions: [{ kind: 'siteEndsWith', value: 'arxiv.org' }], origin: { kind: 'import' } },
        { name: 'GitHub repositories', action: { kind: 'file', role: 'code' } }] });
    const checked = checkRuleDraft({ name: 'arXiv', combinator: 'any', conditions: [{ kind: 'siteEndsWith', value: 'arxiv.org' }], action: { kind: 'file', role: 'papers' } });
    expect(checked.ok && checked.definition).toEqual(set.rules[0]!.definition);
    const flat = flattenList({ version: 3, revision: 1, enabled: true, entries: [{ kind: 'set', set }] });
    expect((await decideList(flat.items, { url: 'https://export.arxiv.org/abs/1', title: '', explicit: false }, lookup, NOW)).decision)
      .toMatchObject({ outcome: 'placed', folder: { nativeId: '30' } });
    expect((await decideList(flat.items, { url: 'https://github.com/know-n', title: '', explicit: false }, lookup, NOW)).decision)
      .toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', item: { name: 'GitHub repositories' } });
  });
});

describe('export of a set', () => {
  it('writes a file anyone can import: a role per folder named after it, keep-here rules as matching data, no folder ids', () => {
    const parsed = parse(example());
    if (!parsed.ok) throw new Error('invalid');
    const imported = rulesetSet(parsed, { papers: '30' }, () => crypto.randomUUID(), NOW);
    const own = checkRuleDraft({ name: 'Recipes', combinator: 'all', conditions: [{ kind: 'pathUnder', value: '/recipes' }], action: { kind: 'file', folderNativeId: '41' } });
    const keep = checkRuleDraft({ name: 'Listings', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'list.example' }], action: { kind: 'keepHere' } });
    if (!own.ok || !keep.ok) throw new Error('invalid draft');
    const rule = (id: string, checked: typeof own, action: LocalSet['rules'][number]['action']) => ({ id, enabled: true, name: checked.name, combinator: 'all' as const,
      conditions: checked.conditions, action, definition: checked.definition, compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW });
    const set: LocalSet = { ...imported, name: 'My reading', rules: [...imported.rules, rule('r-own', own, { kind: 'file', folderNativeId: '41' }),
      rule('r-keep', keep, { kind: 'keepHere' })] };
    const doc = exportRuleset(set, (id) => id === '41' ? 'Cooking & Recipes' : null, NOW);
    expect(doc.roles).toEqual([{ key: 'papers', description: 'Academic papers' }, { key: 'code', description: 'Source code' },
      { key: 'cooking-recipes', description: 'Cooking & Recipes' }]);
    expect(doc.entries.map((entry) => [entry.name, entry.role ?? null])).toEqual([['arXiv', 'papers'], ['GitHub repositories', 'code'],
      ['Recipes', 'cooking-recipes'], ['Listings', null]]);
    const text = JSON.stringify(doc);
    expect(text.includes('"41"') || text.includes('"30"')).toBe(false);
    const again = parseRuleset(text);
    expect(again.ok && [again.compiled.length, again.left.matchingOnly]).toEqual([3, 1]);
  });
});
