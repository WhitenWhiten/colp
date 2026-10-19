import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import type { BrowserConfigCommand, BrowserRuleResponse } from '../automation/messages.js';
import { buildRulesConfig, CONFIG_MAX_BYTES, configEntries, foldersUsed, parseRulesConfig } from '../automation/rules-config-format.js';
import { newSubscription, subscriptionKeyList, subscriptionKeys } from '../automation/subscription-store.js';
import { browserRuleStore, browserSubscriptionStore, folderView, listSources, nativeFolderLookup } from './automation-browser.js';
import { hasBookmarkPermission } from './runtime.js';

/**
 * Export and import of this browser's rule configuration (doc 17 §5.3, RS-19.3). Export names each
 * folder by title and path; import takes the Owner's choice of folder here for every folder in the file,
 * checks each is a folder of theirs (never a bookmark subscription's), and adds the entries to the list
 * or replaces it. No folder is created, no folder id from the file is used, and nothing is fetched: a
 * subscription comes back not ready, and its first fetch waits for its origin to be allowed here.
 */
async function exportConfig(): Promise<BrowserRuleResponse> {
  const now = Date.now(), list = await browserRuleStore().load(), sources = await listSources(list);
  const config = await buildRulesConfig(list, folderView, now, (id) => sources.get(id) ?? null);
  const day = new Date(now).toISOString().slice(0, 10);
  return { ok: true, config: { content: `${JSON.stringify(config, null, 2)}\n`, filename: `known-rules-config-${day}.json` } };
}

/** A folder of the Owner's here: it exists, is a folder, and no bookmark subscription keeps it. */
export async function ownFolder(nativeId: string): Promise<boolean> {
  const node = await nativeFolderLookup(nativeId);
  if (!node || node.url !== undefined) return false;
  try { await assertBookmarkFolderAllowed(nativeId); return !await isSubscriptionExcluded(nativeId); } catch { return false; }
}

async function importConfig(command: Extract<BrowserConfigCommand, { kind: 'known.automation.browser.config.import' }>): Promise<BrowserRuleResponse> {
  if (new TextEncoder().encode(command.text).length > CONFIG_MAX_BYTES) return { ok: false, error: 'tooLarge' };
  let config;
  try { config = parseRulesConfig(JSON.parse(command.text)); } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === 'config_version_unsupported' ? 'unsupported' : 'invalid' };
  }
  // Only the file's own folders are mapped, each to a folder of the Owner's here.
  const used = foldersUsed(config).all;
  const remap: Record<string, string | null> = {};
  for (const id of used) {
    const chosen = command.folders[id] ?? null;
    if (chosen !== null && !await ownFolder(chosen)) return { ok: false, error: 'folderGone' };
    remap[id] = chosen;
  }
  const now = Date.now(), made = configEntries(config, remap, () => crypto.randomUUID(), now);
  if ('error' in made) return { ok: false, error: made.error };
  // A subscription already here stays as it is; added to the list, one to an address already subscribed to is left out.
  const here = await browserSubscriptionStore().all(), writes: Record<string, unknown> = {}, left = new Set<string>();
  for (const { config: subscription, local } of made.subscriptions) {
    if (here.some((item) => item.id === subscription.id && item.record)) continue;
    if (!command.replace && here.some((item) => item.record?.url === subscription.url)) { left.add(subscription.id); continue; }
    const keys = subscriptionKeys(subscription.id);
    writes[keys.record] = newSubscription(subscription.id, { ...subscription, origin: new URL(subscription.url).origin }, now);
    writes[keys.local] = local;
  }
  const entries = made.entries.filter((entry) => entry.kind !== 'subscription' || !left.has(entry.subscriptionId));
  const result = await browserRuleStore().importEntries(entries, command.replace, { writes, dropped: subscriptionKeyList });
  if (!result.ok) return result;
  const count = (kind: string) => entries.filter((entry) => entry.kind === kind).length;
  const rules = entries.reduce((sum, entry) => sum + (entry.kind === 'rule' ? 1 : entry.kind === 'set' ? entry.set.rules.length : 0), 0);
  return { ok: true, imported: { revision: result.revision, rules, sets: count('set'), subscriptions: count('subscription'), skipped: made.skipped + left.size } };
}

export async function handleConfigCommand(command: BrowserConfigCommand): Promise<BrowserRuleResponse> {
  if (command.kind === 'known.automation.browser.config.export') return exportConfig();
  // Choosing folders here needs the bookmarks; exporting reads them only for names.
  return await hasBookmarkPermission() ? importConfig(command) : { ok: false, error: 'noAccess' };
}
