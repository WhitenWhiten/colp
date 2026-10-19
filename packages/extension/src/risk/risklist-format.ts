import { normalizeHost } from '@know-n/colp/automation';
import { record } from '../automation/closed-value.js';
import { registrableDomain } from '../automation/public-suffix.js';

/**
 * `colp.risklist/v1` (doc 17 §5.2, RS-18.5): a publisher's list of sites to warn about, read in this
 * browser only. Closed like the rule-set format: a key outside it is a problem, and one bad entry
 * refuses the whole file, with up to ten problems named by JSON pointer. A `host` names one host, a
 * `domain` a registrable domain and every host under it — never a public suffix, which would flag
 * sites of many owners — and a `urlPrefix` a page address and what is under it, without query or
 * fragment. Nothing in a list can change where a page is filed (R17).
 */
export const RISKLIST_FORMAT = 'colp.risklist/v1';
export const RISKLIST_MAX_BYTES = 4 * 1024 * 1024;
/** At ninety-odd bytes an entry, 4 MB holds fewer than 50,000: the size is the bound a file meets first. */
export const RISKLIST_LIMITS = { entries: 50_000, problems: 10 } as const;
const IDENT = /^[A-Za-z0-9._-]{1,64}$/u;

export type RiskKind = 'phishing' | 'scam' | 'malware' | 'other';
export type RiskScope = 'host' | 'domain' | 'urlPrefix';
export interface RiskEntry {
  readonly scope: RiskScope;
  readonly value: string;
  readonly kind: RiskKind;
  readonly since: string;
  readonly expires: string | null;
  readonly evidenceUrl: string | null;
}
export interface RiskList {
  readonly format: typeof RISKLIST_FORMAT;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly updatedAt?: string;
  readonly publisher?: { readonly name: string; readonly url: string | null; readonly feedbackUrl: string | null };
  readonly license?: string;
  readonly entries: readonly RiskEntry[];
}
export type RiskProblemCode = 'json' | 'tooLarge' | 'format' | 'unknownKey' | 'required' | 'type' | 'tooLong' | 'pattern' | 'tooMany'
  | 'invalidHost' | 'publicSuffix' | 'notRegistrable' | 'invalidUrl' | 'invalidDate';
export interface RiskProblem { readonly pointer: string; readonly code: RiskProblemCode }
export type ParsedRiskList = { readonly ok: true; readonly list: RiskList } | { readonly ok: false; readonly problems: readonly RiskProblem[] };

class Problems extends Error {}
const KINDS = new Set<string>(['phishing', 'scam', 'malware', 'other']);
const date = (value: string) => value.length <= 64 && Number.isFinite(Date.parse(value));

/** A page address a prefix may be: http(s), no user name, query or fragment; normalized as the URL parser writes it. */
function prefixOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) return null;
    return url.href;
  } catch { return null; }
}

export function parseRiskList(text: string): ParsedRiskList {
  if (new TextEncoder().encode(text).length > RISKLIST_MAX_BYTES) return { ok: false, problems: [{ pointer: '', code: 'tooLarge' }] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, problems: [{ pointer: '', code: 'json' }] }; }
  if (!record(value) || value.format !== RISKLIST_FORMAT) return { ok: false, problems: [{ pointer: record(value) ? '/format' : '', code: 'format' }] };
  const problems: RiskProblem[] = [];
  const fail = (pointer: string, code: RiskProblemCode): undefined => {
    problems.push({ pointer, code });
    if (problems.length >= RISKLIST_LIMITS.problems) throw new Problems();
    return undefined;
  };
  const closed = (raw: Record<string, unknown>, pointer: string, required: readonly string[], optional: readonly string[] = []) => {
    for (const key of Object.keys(raw)) if (!required.includes(key) && !optional.includes(key)) fail(`${pointer}/${key}`, 'unknownKey');
    for (const key of required) if (!(key in raw)) fail(`${pointer}/${key}`, 'required');
  };
  const field = (raw: unknown, pointer: string, limit: number, pattern?: RegExp): string | undefined => {
    if (raw === undefined) return undefined; // named as required already
    if (typeof raw !== 'string' || /\u0000/u.test(raw)) return fail(pointer, 'type');
    if (raw.length > limit) return fail(pointer, 'tooLong');
    if (pattern && !pattern.test(raw)) return fail(pointer, 'pattern');
    return raw;
  };
  const link = (raw: unknown, pointer: string): string | null | undefined => {
    if (raw === null) return null;
    const given = field(raw, pointer, 2_048);
    if (given === undefined) return undefined;
    try { const url = new URL(given); if (url.protocol === 'https:' || url.protocol === 'http:') return given; } catch { /* below */ }
    return fail(pointer, 'invalidUrl');
  };
  try {
    closed(value, '', ['format', 'id', 'name', 'version', 'entries'], ['updatedAt', 'publisher', 'license']);
    const id = field(value.id, '/id', 64, IDENT), name = field(value.name, '/name', 200), version = field(value.version, '/version', 64);
    const updatedAt = value.updatedAt === undefined ? undefined : field(value.updatedAt, '/updatedAt', 64);
    const license = value.license === undefined ? undefined : field(value.license, '/license', 64);
    let publisher: RiskList['publisher'];
    if (value.publisher !== undefined) {
      if (!record(value.publisher)) fail('/publisher', 'type');
      else {
        closed(value.publisher, '/publisher', ['name'], ['url', 'feedbackUrl']);
        const pname = field(value.publisher.name, '/publisher/name', 200);
        const url = value.publisher.url === undefined ? null : link(value.publisher.url, '/publisher/url');
        const feedbackUrl = value.publisher.feedbackUrl === undefined ? null : link(value.publisher.feedbackUrl, '/publisher/feedbackUrl');
        if (pname !== undefined && url !== undefined && feedbackUrl !== undefined) publisher = { name: pname, url, feedbackUrl };
      }
    }
    const entries: RiskEntry[] = [];
    if (!Array.isArray(value.entries)) fail('/entries', 'type');
    else if (value.entries.length > RISKLIST_LIMITS.entries) fail('/entries', 'tooMany');
    else for (const [index, item] of value.entries.entries()) {
      const pointer = `/entries/${index}`;
      if (!record(item)) { fail(pointer, 'type'); continue; }
      closed(item, pointer, ['scope', 'value', 'kind', 'since', 'expires', 'evidenceUrl']);
      const raw = field(item.value, `${pointer}/value`, 2_048);
      const since = field(item.since, `${pointer}/since`, 64);
      if (since !== undefined && !date(since)) fail(`${pointer}/since`, 'invalidDate');
      const expires = item.expires === null ? null : field(item.expires, `${pointer}/expires`, 64);
      if (typeof expires === 'string' && !date(expires)) fail(`${pointer}/expires`, 'invalidDate');
      const evidenceUrl = link(item.evidenceUrl, `${pointer}/evidenceUrl`);
      if (item.kind !== undefined && (typeof item.kind !== 'string' || !KINDS.has(item.kind))) fail(`${pointer}/kind`, 'pattern');
      if (item.scope !== 'host' && item.scope !== 'domain' && item.scope !== 'urlPrefix') { if (item.scope !== undefined) fail(`${pointer}/scope`, 'pattern'); continue; }
      if (raw === undefined) continue;
      let normalized: string | null;
      if (item.scope === 'urlPrefix') {
        normalized = prefixOf(raw);
        if (!normalized) { fail(`${pointer}/value`, 'invalidUrl'); continue; }
      } else {
        normalized = normalizeHost(raw) ?? null;
        if (!normalized) { fail(`${pointer}/value`, 'invalidHost'); continue; }
        // A domain entry is a registrable domain: a public suffix would flag sites of many owners (RS-18.5); a subdomain is a host entry.
        const registrable = item.scope === 'domain' ? registrableDomain(normalized) : normalized;
        if (registrable !== normalized) { fail(`${pointer}/value`, registrable === null ? 'publicSuffix' : 'notRegistrable'); continue; }
      }
      if (since === undefined || expires === undefined || evidenceUrl === undefined || typeof item.kind !== 'string' || !KINDS.has(item.kind)) continue;
      entries.push({ scope: item.scope, value: normalized, kind: item.kind as RiskKind, since, expires, evidenceUrl });
    }
    if (problems.length || id === undefined || name === undefined || version === undefined) {
      return { ok: false, problems: problems.length ? problems : [{ pointer: '', code: 'required' }] };
    }
    return { ok: true, list: { format: RISKLIST_FORMAT, id, name, version, ...(updatedAt ? { updatedAt } : {}), ...(publisher ? { publisher } : {}),
      ...(license ? { license } : {}), entries } };
  } catch (error) {
    if (error instanceof Problems) return { ok: false, problems };
    throw error;
  }
}
