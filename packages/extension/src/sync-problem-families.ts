import { SYNC_FAILURE_TABLE, normalizeSyncFailureCode, type SyncFailureEntry } from './sync-failure-class.js';

/** The table's own entry: its class is what the code is *about* (an item), not the blast radius it has without a subject. */
const entryOf = (code: string): SyncFailureEntry | undefined => (SYNC_FAILURE_TABLE as Readonly<Record<string, SyncFailureEntry>>)[code];

/**
 * Which kind of problem a sync code is, for words and for the exits offered.
 *
 * `SYNC_FAILURE_TABLE` says how much a failure stops (class) and what ends it
 * (exit). That is enough to say something true about any code, including one
 * whose author wrote no words: the family below is read off the entry, and for
 * a code the table does not know yet (a server Problem code, a synthesised
 * `snapshot_<status>_<code>`, a Chrome or JavaScript name) off its spelling.
 * A new table key therefore always lands in a family with a readable sentence;
 * `tests/sync-problem-catalog.test.ts` walks the table to keep it that way.
 */
export type SyncProblemFamily =
  /** Transient. */
  | 'offline' | 'server_busy' | 'waiting' | 'permission'
  /** The Session, cursor or sign-in must be renewed. */
  | 'authority' | 'sign_in' | 'retired'
  /** A frozen Pull page or Snapshot that failed a safety check. */
  | 'integrity_pull' | 'integrity_snapshot' | 'item_mapping'
  /** Only a Reset, a decision or an answer ends it. */
  | 'rebuild' | 'decide' | 'confirm' | 'codec'
  /** An internal check failed; retrying gives the same result. */
  | 'stop_upload' | 'stop_download' | 'stop_first_sync' | 'stop_feature' | 'stop_local'
  /** The watchdog's: a stall nothing classified (`sync-watchdog.ts`). */
  | 'stalled'
  /** A code nobody registered. */
  | 'unknown';

/** Where a problem is: what the person should expect not to work meanwhile. */
export type SyncProblemLane = 'upload' | 'download' | 'device';

const OFFLINE = new Set(['network_unavailable', 'push_network_failed', 'pull_transport_unavailable', 'indexeddb_unavailable']);
const SERVER_BUSY = new Set(['server_unavailable', 'rate_limited', 'service_unavailable', 'internal_error', 'push_batch_timeout',
  'push_batch_response_unknown', 'request_failed', 'pull_failed', 'push_dispatch_failed', 'push_server_unavailable']);
const PERMISSION = new Set(['permission_required', 'permission_revoked']);
const SIGN_IN = new Set(['credential_revoked', 'authentication_required', 'insufficient_scope']);
/** `resource_not_found` is not here: it is what the server says of a Session that expired or was replaced, and a new one ends it. */
const RETIRED = new Set(['replica_retired']);
/** Told by the watchdog, not by the engine: no table entry exists, and nothing short of looking into it helps. */
const STALLED = new Set(['sync_stuck', 'sync_not_completing']);
/** Synthesised by the extension itself, so no table entry exists, but only a Reset ends it. */
const REBUILD = new Set(['replica_rebuild_pending']);

/** Areas of the stop codes that carry no other meaning, read off the code's first word. */
const STOP_AREAS: readonly (readonly [SyncProblemFamily, RegExp])[] = [
  ['stop_upload', /^(?:push_|queue_|attempt_|authoritative_|bookmark_event_|recapture_|receipt_|op_id_|operation_|sequence_|set_aside_)/u],
  ['stop_download', /^(?:pull_|ack_|effect_|cursor_|page_chain|recovery_|replay_|reorder_|projection_|provisional_|observation_|attention_page|intent_|native_result|node_kind|resource_revision|snapshot_|separator_|private_ancestry)/u],
  ['stop_first_sync', /^(?:bootstrap_|advanced_|import_|preview_|first_run|pause_|preformal|root_|selected_roots|private_roots|discovered_roots|mount_|legacy_store)/u],
  ['stop_feature', /^(?:batch_|command_|remote_delete_|ingress_|native_wait_|exclusion_)/u],
];

/** The synthesised shapes `snapshotFailure` and `stableError` produce for codes the table cannot list. */
const SYNTHESISED_SNAPSHOT = /^snapshot_(?:\d{3}_|http_\d{3}$)/u;

function stopFamily(code: string): SyncProblemFamily {
  return STOP_AREAS.find(([, pattern]) => pattern.test(code))?.[0] ?? 'stop_local';
}

/**
 * Refusals a Reset cannot end: the same answer comes back for a new copy, or the limit is the server's. Neither the
 * card nor the Sync center offers a Reset for them, and the Reset itself refuses (`replica-repair-capability.ts`).
 */
const RESET_CANNOT_HELP = new Set(['snapshot_too_large', 'server_version_mismatch', 'origin_not_allowed', 'invalid_query',
  'idempotency_key_reused', 'manifest_unavailable']);

export function problemResetCannotHelp(code: string | undefined): boolean {
  return code !== undefined && RESET_CANNOT_HELP.has(normalizeSyncFailureCode(code));
}

/** The family of one code. Total: every string has one. */
export function syncProblemFamily(full: string | undefined): SyncProblemFamily {
  if (!full) return 'unknown';
  // `name:detail` shapes (a node id after the name) are the family of `name`, unless the table lists the whole.
  // A Snapshot-wrapped server code (`snapshot_503_service_unavailable`) has the family of the code inside.
  const named = entryOf(full) || !full.includes(':') ? full : full.split(':', 1)[0]!;
  const code = normalizeSyncFailureCode(named);
  if (RETIRED.has(code)) return 'retired';
  if (STALLED.has(code)) return 'stalled';
  if (REBUILD.has(code)) return 'rebuild';
  if (SIGN_IN.has(code)) return 'sign_in';
  const policy = entryOf(code);
  if (!policy) {
    if (OFFLINE.has(code)) return 'offline';
    if (SERVER_BUSY.has(code)) return 'server_busy';
    if (PERMISSION.has(code)) return 'permission';
    return SYNTHESISED_SNAPSHOT.test(code) ? 'integrity_snapshot' : 'unknown';
  }
  if (PERMISSION.has(code)) return 'permission';
  switch (policy.class) {
    case 'transient':
      return OFFLINE.has(code) ? 'offline' : SERVER_BUSY.has(code) ? 'server_busy' : 'waiting';
    case 'authority': return 'authority';
    case 'item':
      if (policy.exit === 'confirm') return 'confirm';
      if (policy.exit === 'decide') return 'decide';
      if (policy.exit === 'rebuild') return 'rebuild';
      if (policy.exit === 'stop') return 'codec';
      return 'item_mapping';
    case 'replica':
      if (policy.exit === 'rebuild') return 'rebuild';
      if (policy.exit === 'refresh') return code.startsWith('snapshot_') ? 'integrity_snapshot' : 'integrity_pull';
      return stopFamily(code);
  }
}

/** Uploads wait, downloads wait, or the whole device: used for the lane label, never for control flow. */
export function syncProblemLane(code: string | undefined): SyncProblemLane {
  if (!code) return 'device';
  const family = syncProblemFamily(code);
  if (family === 'stop_upload' || /^(?:push_|queue_|upload_|create_placement|delete_subtree|conflict_)/u.test(code)) return 'upload';
  if (family === 'stop_download' || family === 'integrity_pull' || family === 'integrity_snapshot' || family === 'item_mapping'
      || /^(?:pull_|snapshot_|effect_|anchor_|preflight_|parent_|target_|mapping_missing)/u.test(code)) return 'download';
  return 'device';
}

/** Families that end by themselves: the engine retries them without being asked. */
export function problemRetriesByItself(family: SyncProblemFamily): boolean {
  return family === 'offline' || family === 'server_busy' || family === 'waiting' || family === 'authority'
    || family === 'unknown' || family === 'permission';
}

/**
 * Whether "Retry sync" is worth offering for this code. One rule for the
 * extension card and the Sync center, so the two never answer differently.
 * A manual wake is a cheap probe: it re-checks a frozen identity, re-pulls
 * from the cursor and re-runs a stopped stage, so it is offered for every
 * state except the two where the engine returns before doing anything until
 * something else happens: a Reset (`rebuild`, the frozen terminal states) and
 * a browser the server retired (every request would be refused again).
 * Whether it will help is the card's sentence to say, not a reason to hide it.
 */
export function problemOffersRetry(code: string | undefined): boolean {
  const family = syncProblemFamily(code);
  return family !== 'rebuild' && family !== 'retired';
}
