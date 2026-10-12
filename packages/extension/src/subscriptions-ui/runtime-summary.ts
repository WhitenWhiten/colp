import { t } from '../i18n.js';
import type { LocalMapping } from '../bookmark-subscriptions/local-types.js';
import { el, facts } from './dom.js';
export type LocalSummary = LocalMapping & { mountPath?: string[]; bookmarkCount?: number; ackPending?: boolean; recoveryPending?: boolean };
export function runtimeFacts(local: LocalSummary): [string, string][] {
  const rows: [string, string][] = [];
  if (local.mountPath?.length) rows.push([t('subscription_mountPath', 'Location'), local.mountPath.join(' › ')]);
  if (typeof local.bookmarkCount === 'number') rows.push([t('subscription_bookmarkCount', 'Bookmarks'), String(local.bookmarkCount)]);
  return rows;
}
export function appendRuntimeNotes(host: HTMLElement, local: LocalSummary) {
  if (local.ackPending) host.append(el('p', t('subscription_ackPending', 'Removed here. Waiting for Know-N to confirm.'), 'subscription-note'));
  if (local.recoveryPending) host.append(el('p', t('subscription_recoveryPending', 'Recovery details are kept. Check this subscription or its diagnostics before making more changes.'), 'subscription-note'));
}
export function appendRuntimeSummary(host: HTMLElement, local: LocalSummary) {
  const rows = runtimeFacts(local); if (rows.length) host.append(facts(rows)); appendRuntimeNotes(host, local);
}
export function runtimeChanging(local: LocalSummary | null | undefined): boolean { return !!local && (['initializing','applying','terminating'].includes(local.state) || local.ackPending === true); }
