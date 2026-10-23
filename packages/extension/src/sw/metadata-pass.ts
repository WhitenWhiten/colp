import type { SyncScope } from '../sync-state-store.js';
import { scopeKey } from '../sync-state/scope-key.js';

/** Remote notes travel outside the sync cursor, so a quiet browser still checks them this often. */
export const METADATA_QUIET_REFRESH_MS = 5 * 60_000;
const METADATA_PASS_KEY = 'known.sync.metadata-pass.v1';

interface MetadataPass { readonly scopeKey: string; readonly cursor: string; readonly at: number }

/**
 * Tag, note, pin and description edits wake a manual pass, and remote changes
 * arrive with a new acknowledged cursor. An alarm pass that moved neither need
 * not read the whole native tree and every mapping again.
 */
export async function metadataPassDue(scope: SyncScope, reason: string, cursor: string | undefined,
  now = Date.now()): Promise<boolean> {
  if (reason !== 'alarm' || !cursor) return true;
  try {
    const last = (await chrome.storage.session.get(METADATA_PASS_KEY))[METADATA_PASS_KEY] as Partial<MetadataPass> | undefined;
    return last?.scopeKey !== scopeKey(scope) || last.cursor !== cursor || typeof last.at !== 'number'
      || now < last.at || now - last.at >= METADATA_QUIET_REFRESH_MS;
  } catch { return true; }
}

/** Only a pass that left nothing staged may let the next quiet alarm skip. */
export async function recordMetadataPass(scope: SyncScope, cursor: string, now = Date.now()): Promise<void> {
  const pass: MetadataPass = { scopeKey: scopeKey(scope), cursor, at: now };
  await chrome.storage.session.set({ [METADATA_PASS_KEY]: pass }).catch(() => undefined);
}
