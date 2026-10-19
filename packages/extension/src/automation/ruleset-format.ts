import { automationDigest, compilePredicate, normalizeHost, validateM1Rule, type Predicate, type RuleDefinition } from '@know-n/colp/automation';
import { editorConditions } from './browser-rules.js';
import { record } from './closed-value.js';
import { CONDITION_LIMIT, NAME_LIMIT, checkRuleDraft, definitionFor, type RuleCondition } from './rule-conditions.js';
import type { LocalRule, LocalSet } from './rule-list-store.js';

/**
 * `colp.ruleset/v1` (doc 17 §5.1, RS-02): a publisher's rule set, imported here as a set of the Owner's
 * own. The document is closed — a key outside the format is a problem, so it cannot carry a folder, a
 * credential or a task — and one bad entry refuses the whole import, with up to ten problems named by
 * JSON pointer. A site entry expands to explicit host conditions (revoked addresses never match; more
 * than 32 are grouped, since the shared core takes 32 items per group and 128 nodes per predicate, so a
 * site takes 48 plain addresses but 41 with path prefixes, each of those being three nodes); a
 * `match` entry is the finite M1 predicate. Roles name kinds of folder; the Owner binds each to a folder
 * here, and an entry without a role is matching data only and is not added. After the import nothing
 * refers back to the file.
 */
export const RULESET_FORMAT = 'colp.ruleset/v1';
export const RULESET_MAX_BYTES = 2 * 1024 * 1024;
export const RULESET_LIMITS = { entries: 2_000, sites: 500, addresses: 48, roles: 32, problems: 10 } as const;
const IDENT = /^[A-Za-z0-9._-]{1,64}$/u, GROUP = 32;

export type RulesetProblemCode = 'json' | 'tooLarge' | 'format' | 'unknownKey' | 'required' | 'type' | 'tooLong' | 'pattern' | 'duplicate'
  | 'tooMany' | 'oneOf' | 'unknownRole' | 'unknownSite' | 'invalidHost' | 'invalidPath' | 'invalidUrl' | 'invalidMatch';
export interface RulesetProblem { readonly pointer: string; readonly code: RulesetProblemCode }

export interface RulesetAddress {
  readonly host: string;
  readonly scope: 'exact' | 'domain';
  readonly status: 'current' | 'historical' | 'revoked';
  readonly since?: string;
  readonly until?: string;
  readonly pathPrefix?: string;
}
export interface RulesetSite { readonly id: string; readonly name: string; readonly addresses: readonly RulesetAddress[] }
export interface RulesetEntry { readonly id: string; readonly name?: string; readonly site?: string; readonly match?: Predicate; readonly role?: string }
export interface RulesetPublisher { readonly name: string; readonly url?: string | null; readonly feedbackUrl?: string | null }
export interface Ruleset {
  readonly format: typeof RULESET_FORMAT;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly updatedAt?: string;
  readonly publisher?: RulesetPublisher;
  readonly license?: string;
  readonly roles: readonly { readonly key: string; readonly description: string }[];
  readonly sites: readonly RulesetSite[];
  readonly entries: readonly RulesetEntry[];
}
/** An entry ready to become a rule: its definition, and the editor's conditions when they can say the same. */
export interface CompiledEntry {
  readonly entry: RulesetEntry;
  readonly name: string;
  readonly definition: RuleDefinition;
  readonly conditions: { readonly combinator: 'all' | 'any'; readonly conditions: readonly RuleCondition[] } | null;
}
export type ParsedRuleset = { readonly ok: true; readonly ruleset: Ruleset; readonly compiled: readonly CompiledEntry[];
  /** Entries with no role (matching data only), and site entries whose addresses are all revoked. */
  readonly left: { readonly matchingOnly: number; readonly inactive: number } }
  | { readonly ok: false; readonly problems: readonly RulesetProblem[] };

class Problems extends Error {}
const at = (pointer: string, key: string | number) => `${pointer}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;

function reader() {
  const problems: RulesetProblem[] = [];
  const fail = (pointer: string, code: RulesetProblemCode): undefined => {
    problems.push({ pointer, code });
    if (problems.length >= RULESET_LIMITS.problems) throw new Problems();
    return undefined;
  };
  const object = (value: unknown, pointer: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined => {
    if (!record(value)) return fail(pointer, 'type');
    for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(at(pointer, key), 'unknownKey');
    for (const key of required) if (!(key in value)) fail(at(pointer, key), 'required');
    return value;
  };
  // A required key that is missing was named by `object`; a reader says nothing more about it.
  const text = (value: unknown, pointer: string, limit: number, pattern?: RegExp): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || /\u0000/u.test(value)) return fail(pointer, 'type');
    if (value.length > limit) return fail(pointer, 'tooLong');
    if (pattern && !pattern.test(value)) return fail(pointer, 'pattern');
    return value;
  };
  const link = (value: unknown, pointer: string): string | null | undefined => {
    if (value === null || value === undefined) return value as null | undefined;
    const raw = text(value, pointer, 2_048);
    if (raw === undefined) return undefined;
    try { const url = new URL(raw); if (url.protocol === 'https:' || url.protocol === 'http:') return raw; } catch { /* below */ }
    return fail(pointer, 'invalidUrl');
  };
  const list = (value: unknown, pointer: string, limit: number): unknown[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return fail(pointer, 'type');
    if (value.length > limit) return fail(pointer, 'tooMany');
    return value;
  };
  return { problems, fail, object, text, link, list };
}

/** Up to 32 alternatives per group, as the shared core takes them. */
function anyOf(items: readonly Predicate[]): Predicate {
  if (items.length === 1) return items[0]!;
  if (items.length <= GROUP) return { kind: 'any', items: [...items] };
  const groups: Predicate[] = [];
  for (let index = 0; index < items.length; index += GROUP) groups.push(anyOf(items.slice(index, index + GROUP)));
  return anyOf(groups);
}

/** A site's addresses as one predicate: exact → host `eq`, domain → `hostSuffix`, a path prefix → and the path starts with it. */
export function sitePredicate(site: RulesetSite): Predicate | null {
  const items = site.addresses.filter((address) => address.status !== 'revoked').map((address): Predicate => {
    const host: Predicate = { kind: 'field', field: 'bookmark.url.host', op: address.scope === 'exact' ? 'eq' : 'hostSuffix', value: address.host };
    return address.pathPrefix ? { kind: 'all', items: [host, { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: address.pathPrefix }] } : host;
  });
  return items.length ? anyOf(items) : null;
}

export function parseRuleset(text: string): ParsedRuleset {
  if (new TextEncoder().encode(text).length > RULESET_MAX_BYTES) return { ok: false, problems: [{ pointer: '', code: 'tooLarge' }] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, problems: [{ pointer: '', code: 'json' }] }; }
  if (!record(value) || value.format !== RULESET_FORMAT) return { ok: false, problems: [{ pointer: record(value) ? '/format' : '', code: 'format' }] };
  const read = reader();
  try {
    const root = read.object(value, '', ['format', 'id', 'name', 'version', 'entries'], ['updatedAt', 'publisher', 'license', 'roles', 'sites'])!;
    const id = read.text(root.id, '/id', 64, IDENT), name = read.text(root.name, '/name', NAME_LIMIT), version = read.text(root.version, '/version', 64);
    const updatedAt = root.updatedAt === undefined ? undefined : read.text(root.updatedAt, '/updatedAt', 64);
    const license = root.license === undefined ? undefined : read.text(root.license, '/license', 64);
    let publisher: RulesetPublisher | undefined;
    if (root.publisher !== undefined) {
      const raw = read.object(root.publisher, '/publisher', ['name'], ['url', 'feedbackUrl']);
      if (raw) {
        const pname = read.text(raw.name, '/publisher/name', NAME_LIMIT), url = read.link(raw.url, '/publisher/url'), feedbackUrl = read.link(raw.feedbackUrl, '/publisher/feedbackUrl');
        if (pname !== undefined) publisher = { name: pname, ...(url !== undefined ? { url } : {}), ...(feedbackUrl !== undefined ? { feedbackUrl } : {}) };
      }
    }
    const roles: { key: string; description: string }[] = [];
    for (const [index, item] of (root.roles === undefined ? [] : read.list(root.roles, '/roles', RULESET_LIMITS.roles) ?? []).entries()) {
      const pointer = at('/roles', index), raw = read.object(item, pointer, ['key', 'description']);
      if (!raw) continue;
      const key = read.text(raw.key, `${pointer}/key`, 64, IDENT), description = read.text(raw.description, `${pointer}/description`, 512);
      if (key === undefined || description === undefined) continue;
      if (roles.some((role) => role.key === key)) { read.fail(`${pointer}/key`, 'duplicate'); continue; }
      roles.push({ key, description });
    }
    const sites: RulesetSite[] = [], overBudget = new Set<string>();
    for (const [index, item] of (root.sites === undefined ? [] : read.list(root.sites, '/sites', RULESET_LIMITS.sites) ?? []).entries()) {
      const pointer = at('/sites', index), raw = read.object(item, pointer, ['id', 'name', 'addresses']);
      if (!raw) continue;
      const siteId = read.text(raw.id, `${pointer}/id`, 64, IDENT), siteName = read.text(raw.name, `${pointer}/name`, NAME_LIMIT);
      const addresses: RulesetAddress[] = [];
      for (const [slot, entry] of (read.list(raw.addresses, `${pointer}/addresses`, RULESET_LIMITS.addresses) ?? []).entries()) {
        const where = at(`${pointer}/addresses`, slot), address = read.object(entry, where, ['host', 'scope', 'status'], ['since', 'until', 'pathPrefix']);
        if (!address) continue;
        const host = typeof address.host === 'string' ? normalizeHost(address.host) : undefined;
        if (!host) { read.fail(`${where}/host`, 'invalidHost'); continue; }
        if (address.scope !== 'exact' && address.scope !== 'domain') { read.fail(`${where}/scope`, 'pattern'); continue; }
        if (address.status !== 'current' && address.status !== 'historical' && address.status !== 'revoked') { read.fail(`${where}/status`, 'pattern'); continue; }
        const since = address.since === undefined ? undefined : read.text(address.since, `${where}/since`, 64);
        const until = address.until === undefined ? undefined : read.text(address.until, `${where}/until`, 64);
        const pathPrefix = address.pathPrefix === undefined ? undefined : read.text(address.pathPrefix, `${where}/pathPrefix`, 512, /^\//u);
        if (address.pathPrefix !== undefined && pathPrefix === undefined) continue;
        addresses.push({ host, scope: address.scope, status: address.status, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(pathPrefix ? { pathPrefix } : {}) });
      }
      if (siteId === undefined || siteName === undefined) continue;
      if (sites.some((site) => site.id === siteId)) { read.fail(`${pointer}/id`, 'duplicate'); continue; }
      const site: RulesetSite = { id: siteId, name: siteName, addresses };
      // An address with a path prefix is three nodes, not one, so fewer of them fit the core's 128 (§5.1). The site is kept so its entries resolve.
      const predicate = sitePredicate(site);
      if (predicate && !compilePredicate(predicate).valid) { read.fail(`${pointer}/addresses`, 'tooMany'); overBudget.add(siteId); }
      sites.push(site);
    }
    const entries: RulesetEntry[] = [], compiled: CompiledEntry[] = [];
    let matchingOnly = 0, inactive = 0;
    for (const [index, item] of (read.list(root.entries, '/entries', RULESET_LIMITS.entries) ?? []).entries()) {
      const pointer = at('/entries', index), raw = read.object(item, pointer, ['id'], ['name', 'site', 'match', 'role']);
      if (!raw) continue;
      const entryId = read.text(raw.id, `${pointer}/id`, 64, IDENT);
      const entryName = raw.name === undefined ? undefined : read.text(raw.name, `${pointer}/name`, NAME_LIMIT);
      const role = raw.role === undefined ? undefined : read.text(raw.role, `${pointer}/role`, 64, IDENT);
      if (role !== undefined && !roles.some((item) => item.key === role)) read.fail(`${pointer}/role`, 'unknownRole');
      if ((raw.site === undefined) === (raw.match === undefined)) { read.fail(pointer, 'oneOf'); continue; }
      if (entryId === undefined) continue;
      if (entries.some((entry) => entry.id === entryId)) { read.fail(`${pointer}/id`, 'duplicate'); continue; }
      let predicate: Predicate | null, site: RulesetSite | undefined;
      if (raw.site !== undefined) {
        const siteId = read.text(raw.site, `${pointer}/site`, 64, IDENT);
        site = sites.find((item) => item.id === siteId);
        if (!site) { if (siteId !== undefined) read.fail(`${pointer}/site`, 'unknownSite'); continue; }
        if (overBudget.has(site.id)) continue; // named at the site already
        predicate = sitePredicate(site);
      } else predicate = raw.match as Predicate;
      const entry: RulesetEntry = { id: entryId, ...(entryName !== undefined ? { name: entryName } : {}), ...(site ? { site: site.id } : { match: raw.match as Predicate }),
        ...(role !== undefined ? { role } : {}) };
      entries.push(entry);
      if (!predicate) { inactive += 1; continue; }
      const checked = compilePredicate(predicate);
      const ruleName = (entryName ?? site?.name ?? entryId).slice(0, NAME_LIMIT);
      const definition = checked.valid ? { ...definitionFor(ruleName, checked.normalizedPredicate) } : null;
      if (!checked.valid || !definition || validateM1Rule(definition).length) { read.fail(`${pointer}/${site ? 'site' : 'match'}`, 'invalidMatch'); continue; }
      if (role === undefined) { matchingOnly += 1; continue; }
      compiled.push({ entry, name: ruleName, definition, conditions: editable(site, definition) });
    }
    if (read.problems.length || id === undefined || name === undefined || version === undefined) {
      return { ok: false, problems: read.problems.length ? read.problems : [{ pointer: '', code: 'required' }] };
    }
    const ruleset: Ruleset = { format: RULESET_FORMAT, id, name, version, ...(updatedAt ? { updatedAt } : {}), ...(publisher ? { publisher } : {}),
      ...(license ? { license } : {}), roles, sites, entries };
    return { ok: true, ruleset, compiled, left: { matchingOnly, inactive } };
  } catch (error) {
    if (error instanceof Problems) return { ok: false, problems: read.problems };
    throw error;
  }
}

/** The editor's conditions for an entry, when they say exactly what it matches and fit the editor; else the definition alone is kept. */
function editable(site: RulesetSite | undefined, definition: RuleDefinition): CompiledEntry['conditions'] {
  if (site) {
    const live = site.addresses.filter((address) => address.status !== 'revoked');
    if (live.length > CONDITION_LIMIT || live.some((address) => address.pathPrefix)) return null;
    return { combinator: 'any', conditions: live.map((address) => ({ kind: address.scope === 'exact' ? 'siteIs' : 'siteEndsWith', value: address.host })) };
  }
  const read = editorConditions(definition);
  return read && read.conditions.length <= CONDITION_LIMIT ? read : null;
}

/** The set an import adds: its rules filing by role, the roles bound to the folders the Owner chose (or left unbound). */
export function rulesetSet(parsed: Extract<ParsedRuleset, { ok: true }>, bindings: Readonly<Record<string, string>>, newId: () => string, now: number): LocalSet {
  const { ruleset } = parsed;
  const origin = { kind: 'import' as const, sourceId: ruleset.id, sourceName: ruleset.name, sourceVersion: ruleset.version, importedAt: now };
  const rules = parsed.compiled.map((item): LocalRule => {
    const action = { kind: 'file' as const, role: item.entry.role! };
    // Conditions the editor can write are kept as the truth, compiled the way the editor compiles them.
    const checked = item.conditions ? checkRuleDraft({ name: item.name, ...item.conditions, action }) : null;
    return { id: newId(), enabled: true, name: item.name, combinator: checked?.ok ? item.conditions!.combinator : 'all',
      conditions: checked?.ok ? checked.conditions : [], action, definition: checked?.ok ? checked.definition : item.definition,
      compiledFrom: { contentVersions: {} }, createdAt: now, updatedAt: now, origin };
  });
  return { id: newId(), name: ruleset.name, enabled: true, createdAt: now, updatedAt: now,
    origin: { kind: 'import', sourceId: ruleset.id, sourceName: ruleset.name, sourceVersion: ruleset.version, publisher: ruleset.publisher?.name ?? null, importedAt: now },
    roles: ruleset.roles, bindings: Object.fromEntries(Object.entries(bindings).filter(([role]) => ruleset.roles.some((item) => item.key === role))), rules };
}

/**
 * A set of the Owner's as a `colp.ruleset/v1` document to share: a role for each folder its rules file
 * into (named after the folder), a role bound in the set kept as it is, and *keep here* rules as
 * matching data. Folder ids and anything about this browser stay out.
 */
export function exportRuleset(set: LocalSet, folderTitle: (nativeId: string) => string | null, now: number): Ruleset {
  const roles: { key: string; description: string }[] = set.roles.map((role) => ({ ...role }));
  const byFolder = new Map<string, string>();
  const keyFor = (nativeId: string): string => {
    const known = byFolder.get(nativeId);
    if (known) return known;
    const title = folderTitle(nativeId) ?? 'Folder';
    const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 56) || 'folder';
    let key = base;
    for (let n = 2; roles.some((role) => role.key === key); n += 1) key = `${base}-${n}`;
    roles.push({ key, description: title.slice(0, 512) });
    byFolder.set(nativeId, key);
    return key;
  };
  const entries = set.rules.map((rule): RulesetEntry => {
    const role = rule.action.kind === 'keepHere' ? undefined : 'role' in rule.action ? rule.action.role : keyFor(rule.action.folderNativeId);
    return { id: rule.id.slice(0, 64), name: rule.name, match: rule.definition.match, ...(role ? { role } : {}) };
  });
  const slug = set.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'rule-set';
  const day = new Date(now).toISOString();
  return { format: RULESET_FORMAT, id: slug, name: set.name, version: day, updatedAt: day, roles: roles.filter((role) => entries.some((entry) => entry.role === role.key)),
    sites: [], entries };
}

/**
 * Whether a new version may apply by itself under *Automatic* (doc 17 R10): the same rule set, with the
 * same folder roles. Limits, roles that entries name and the format are already the parser's to refuse,
 * and a rule set names no task, grant or address to call, so nothing else can widen. Else it waits.
 */
export type ScopeReason = 'roles' | 'document';
export function withinScope(current: Ruleset, next: Ruleset): { readonly ok: boolean; readonly reasons: readonly ScopeReason[] } {
  const keys = (ruleset: Ruleset) => ruleset.roles.map((role) => role.key).sort().join('\n');
  const reasons: ScopeReason[] = [];
  if (next.id !== current.id) reasons.push('document');
  if (keys(next) !== keys(current)) reasons.push('roles');
  return { ok: reasons.length === 0, reasons };
}

export interface EntryDiff {
  readonly added: readonly { readonly id: string; readonly name: string }[];
  readonly removed: readonly { readonly id: string; readonly name: string }[];
  /** The same id with other conditions, role, name or site addresses. */
  readonly changed: readonly { readonly id: string; readonly name: string }[];
  readonly roles: { readonly added: Ruleset['roles']; readonly removed: Ruleset['roles'] };
}
/** Two versions' entries by id (§8 Policy): what is added, removed and changed, and which folder roles come and go. */
export function entryDiff(current: Ruleset, next: Ruleset): EntryDiff {
  const shape = (ruleset: Ruleset) => new Map(ruleset.entries.map((entry) => {
    const site = entry.site ? ruleset.sites.find((item) => item.id === entry.site) : undefined;
    return [entry.id, { name: entry.name ?? site?.name ?? entry.id, digest: automationDigest({ entry, site: site ?? null }) }] as const;
  }));
  const before = shape(current), after = shape(next);
  const named = (map: typeof before, id: string) => ({ id, name: map.get(id)!.name });
  const keys = (ruleset: Ruleset) => new Set(ruleset.roles.map((role) => role.key));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)).map((id) => named(after, id)),
    removed: [...before.keys()].filter((id) => !after.has(id)).map((id) => named(before, id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id)!.digest !== after.get(id)!.digest).map((id) => named(after, id)),
    roles: { added: next.roles.filter((role) => !keys(current).has(role.key)), removed: current.roles.filter((role) => !keys(next).has(role.key)) },
  };
}
