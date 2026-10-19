import type { RiskEntry, RiskKind, RiskList } from './risklist-format.js';

/**
 * A risk list as this browser looks things up in it (doc 17 §4.4): hosts, registrable domains and URL
 * prefixes (filed under their host), each with what the list says about it. Built once when a version
 * arrives and stored; checks read only this (RS-16.2). The first entry for a value is kept.
 */
export interface RiskFlag { readonly kind: RiskKind; readonly since: string; readonly expires: string | null; readonly evidenceUrl: string | null }
export interface RiskIndex {
  readonly hosts: Readonly<Record<string, RiskFlag>>;
  readonly domains: Readonly<Record<string, RiskFlag>>;
  readonly prefixes: Readonly<Record<string, readonly { readonly prefix: string; readonly flag: RiskFlag }[]>>;
}

const flagOf = (entry: RiskEntry): RiskFlag => ({ kind: entry.kind, since: entry.since, expires: entry.expires, evidenceUrl: entry.evidenceUrl });

export function buildRiskIndex(list: Pick<RiskList, 'entries'>): RiskIndex {
  const hosts: Record<string, RiskFlag> = Object.create(null), domains: Record<string, RiskFlag> = Object.create(null);
  const prefixes: Record<string, { prefix: string; flag: RiskFlag }[]> = Object.create(null);
  for (const entry of list.entries) {
    if (entry.scope === 'host') { hosts[entry.value] ??= flagOf(entry); continue; }
    if (entry.scope === 'domain') { domains[entry.value] ??= flagOf(entry); continue; }
    const host = new URL(entry.value).hostname, filed = prefixes[host] ??= [];
    if (!filed.some((item) => item.prefix === entry.value)) filed.push({ prefix: entry.value, flag: flagOf(entry) });
  }
  return { hosts: { ...hosts }, domains: { ...domains }, prefixes: { ...prefixes } };
}

/** An index read back from storage, or null when it is not one. */
export function parseRiskIndex(value: unknown): RiskIndex | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const map = (item: unknown) => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
  return Object.keys(raw).length === 3 && map(raw.hosts) && map(raw.domains) && map(raw.prefixes) ? raw as unknown as RiskIndex : null;
}
