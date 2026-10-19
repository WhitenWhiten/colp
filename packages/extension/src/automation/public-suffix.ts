import { normalizeHost } from '@know-n/colp/automation';
import { PUBLIC_SUFFIX_RULES } from '../generated/public-suffix-list.js';

/**
 * Public suffixes and registrable domains (doc 17 §7, R6), from the generated Public Suffix List
 * with its PRIVATE section, so `user.github.io` is a site of its own. They are used where a value is
 * written (the rule editor, rule-set and risk-list content), never by the evaluator: "the registrable
 * domain is X" is exactly host `hostSuffix X`.
 *
 * Every input goes through the shared core's `normalizeHost` first, so case, IDNA and trailing dots
 * are settled before a lookup, and two hosts that only look alike stay two hosts: nothing here folds
 * confusable characters. An address by number has no suffix, and a single-label host the list does
 * not name (`localhost`, an intranet name) is not treated as one.
 */
let tables: { readonly rules: Set<string>; readonly wildcards: Set<string>; readonly exceptions: Set<string> } | undefined;
function load() {
  if (tables) return tables;
  const rules = new Set<string>(), wildcards = new Set<string>(), exceptions = new Set<string>();
  for (const rule of PUBLIC_SUFFIX_RULES.split('\n')) {
    if (rule.startsWith('!')) exceptions.add(rule.slice(1));
    else if (rule.startsWith('*.')) wildcards.add(rule.slice(2));
    else rules.add(rule);
  }
  tables = { rules, wildcards, exceptions };
  return tables;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
export const isIpAddress = (host: string): boolean => IPV4.test(host) || host.startsWith('[');

/** The longest suffix a rule names (an exception names its parent), else the last label, which no rule lists. */
function suffixOf(host: string): { readonly suffix: string; readonly listed: boolean } {
  const { rules, wildcards, exceptions } = load();
  const labels = host.split('.');
  for (let index = 0; index < labels.length; index++) {
    const candidate = labels.slice(index).join('.');
    if (exceptions.has(candidate)) return { suffix: labels.slice(index + 1).join('.'), listed: true };
    if (rules.has(candidate) || (index + 1 < labels.length && wildcards.has(labels.slice(index + 1).join('.')))) return { suffix: candidate, listed: true };
  }
  return { suffix: labels.at(-1)!, listed: false };
}

const hostName = (raw: string): string | null => {
  const host = normalizeHost(raw.trim());
  return host && !isIpAddress(host) ? host : null;
};

/** `co.uk` for `a.b.co.uk`; null for an address by number or a value that is not a host. */
export function publicSuffix(raw: string): string | null {
  const host = hostName(raw);
  return host ? suffixOf(host).suffix : null;
}

/** `b.co.uk` for `a.b.co.uk`; null when the host is itself a suffix, has a single label, or is an address by number. */
export function registrableDomain(raw: string): string | null {
  const host = hostName(raw);
  if (!host) return null;
  const { suffix } = suffixOf(host);
  if (host === suffix) return null;
  const labels = host.split('.');
  return labels.slice(labels.length - suffix.split('.').length - 1).join('.');
}

/** True for a value the list names as a suffix (`github.io`, `edu`): a rule on it covers sites run by many owners. */
export function isPublicSuffix(raw: string): boolean {
  const host = hostName(raw);
  if (!host) return false;
  const found = suffixOf(host);
  return found.listed && found.suffix === host;
}

/** The host, then each parent up to its registrable domain; just the host when it has none. */
export function parentDomains(raw: string): string[] {
  const host = normalizeHost(raw.trim());
  if (!host) return [];
  const registrable = registrableDomain(host);
  if (!registrable) return [host];
  const labels = host.split('.'), stop = labels.length - registrable.split('.').length;
  return labels.slice(0, stop + 1).map((_, index) => labels.slice(index).join('.'));
}

/** The Unicode form of a host with `xn--` labels, to show beside the ASCII one; null when they are the same. */
export function unicodeHost(host: string): string | null {
  const labels = host.split('.');
  if (!labels.some((label) => label.startsWith('xn--'))) return null;
  const decoded = labels.map((label) => label.startsWith('xn--') ? decodeLabel(label.slice(4)) : label);
  return decoded.every((label): label is string => label !== null) ? decoded.join('.') : null;
}

// RFC 3492 Punycode decoding, for display only.
const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700;
function adapt(delta: number, points: number, first: boolean): number {
  let value = first ? Math.floor(delta / DAMP) : delta >> 1, k = 0;
  value += Math.floor(value / points);
  for (; value > ((BASE - TMIN) * TMAX) >> 1; k += BASE) value = Math.floor(value / (BASE - TMIN));
  return k + Math.floor(((BASE - TMIN + 1) * value) / (value + SKEW));
}
function decodeLabel(input: string): string | null {
  const end = input.lastIndexOf('-'), output: number[] = [];
  for (let index = 0; index < Math.max(end, 0); index++) output.push(input.charCodeAt(index));
  let code = 128, bias = 72, point = 0;
  for (let index = end >= 0 ? end + 1 : 0; index < input.length;) {
    const start = point;
    for (let weight = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const c = input.charCodeAt(index++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE;
      if (digit >= BASE) return null;
      point += digit * weight;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      weight *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(point - start, length, start === 0);
    code += Math.floor(point / length);
    point %= length;
    if (code > 0x10ffff) return null;
    output.splice(point++, 0, code);
  }
  return String.fromCodePoint(...output);
}
