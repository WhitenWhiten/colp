import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYNC_ISSUE_LIMIT, SYNC_ISSUE_WARNING, isRealInstant, issueLimitNote, issueSummary, issueTitle, problemFamily, resultReason, stopNext, stopReason, type ProblemFamily } from './problems'

/**
 * C-12 / C-19: the words a browser's stop gets on this page are checked against the extension's own failure
 * table, read as text (this package cannot import the extension's TypeScript). A code added there that this
 * page has no family for fails here, instead of reaching an owner as “it reported x”.
 */
const extensionSource = (file: string) => readFileSync(resolve(import.meta.dirname, '../../../../extension/src', file), 'utf8')

interface TableRow { readonly code: string; readonly kind: string }
function readTable(): readonly TableRow[] {
  const source = extensionSource('sync-failure-class.ts')
  const body = source.slice(source.indexOf('export const SYNC_FAILURE_TABLE'), source.indexOf('} satisfies Record<string, SyncFailureEntry>'))
  const rows: TableRow[] = []
  for (const line of body.split('\n')) {
    const match = /^\s{2}(?:'([^']+)'|([A-Za-z_0-9]+)): entry\('(\w+)', '(\w+)'/u.exec(line)
    if (match) rows.push({ code: (match[1] ?? match[2])!, kind: `${match[3]}/${match[4]}` })
  }
  return rows
}
/** A report carries `name:detail` as `name_detail`: one lowercase word. */
const reported = (code: string) => code.replace(/:/gu, '_')

const FAMILIES_BY_KIND: Readonly<Record<string, readonly ProblemFamily[]>> = {
  'transient/retry': ['offline', 'server_busy', 'waiting', 'permission'],
  // A sign-in the server stopped accepting is told as a sign-in; the browser still renews it by itself.
  'authority/refresh': ['authority', 'sign_in'],
  'item/confirm': ['confirm'],
  'item/decide': ['decide'],
  'item/rebuild': ['rebuild'],
  'item/refresh': ['item_mapping'],
  'item/stop': ['codec'],
  'replica/rebuild': ['rebuild'],
  'replica/refresh': ['integrity_pull', 'integrity_snapshot'],
  'replica/stop': ['stop_upload', 'stop_download', 'stop_first_sync', 'stop_feature', 'stop_local', 'retired'],
}

describe('every code the extension can report reads as a sentence (C-12, C-19)', () => {
  const table = readTable()

  it('walks the extension table at test time', () => {
    expect(table.length).toBeGreaterThan(300)
  })

  it('puts each table entry in a family that matches its class and exit, so the words match what ends it', () => {
    const wrong = table.filter(({ code, kind }) => !(FAMILIES_BY_KIND[kind] ?? []).includes(problemFamily(reported(code))))
      .map(({ code, kind }) => `${code} (${kind}) is ${problemFamily(reported(code))}`)
    expect(wrong).toEqual([])
    // A snapshot code is about the server's copy; every other refresh code is about a Pull page.
    for (const { code, kind } of table.filter(row => row.kind === 'replica/refresh')) {
      expect(problemFamily(code), code).toBe(code.startsWith('snapshot_') ? 'integrity_snapshot' : 'integrity_pull')
    }
  })

  it('gives every table code a reason and a next step, and never the bare “it reported x”', () => {
    for (const { code } of table) {
      const reason = stopReason(reported(code))
      expect(reason, code).not.toMatch(/^it reported “/u)
      expect(reason, code).toMatch(/^[a-z].{20,}\.$/u)
      expect(stopNext(reported(code), ['retry']), code).toMatch(/\.$/u)
    }
  })

  it('shows the code in brackets when the code has no words of its own', () => {
    expect(stopReason('queue_state_invalid')).toBe('its record of changes waiting to upload failed an internal check (queue_state_invalid).')
    expect(stopReason('ack_invalid')).toBe('its record of changes from your library failed an internal check (ack_invalid).')
    expect(stopReason('pull_event_conflict')).toBe('changes it downloaded from your library failed a safety check, so it stopped taking them in (pull_event_conflict).')
    expect(stopReason('snapshot_node_duplicate')).toContain('(snapshot_node_duplicate)')
    expect(stopReason('network_unavailable')).toBe('it couldn’t reach the server several times in a row (network_unavailable).')
  })

  it('a code nobody has seen yet still reads as a sentence with the code in brackets', () => {
    expect(stopReason('brand_new_code')).toBe('it reported a problem that has no description yet (brand_new_code).')
    expect(problemFamily('brand_new_code')).toBe('unknown')
    expect(stopReason(null)).toBe('it didn’t say why.')
    expect(stopReason('snapshot_404_some_other_code')).toContain('(snapshot_404_some_other_code)')
    expect(problemFamily('snapshot_http_502')).toBe('integrity_snapshot')
  })

  it('names what the server and the sign-in did, which no table entry covers', () => {
    expect(stopReason('replica_retired')).toBe('this browser was stopped, so it no longer syncs.')
    expect(stopReason('resource_not_found')).toBe('the server no longer knows its sync session: it expired or was replaced.')
    expect(stopReason('credential_revoked')).toBe('the server stopped accepting its sign-in.')
    expect(stopReason('sync_stopped')).toBe('it stopped and didn’t record why.')
  })

  it('words the codes the extension watchdog reports, which no table entry covers', () => {
    expect(problemFamily('sync_stuck')).toBe('stalled')
    expect(problemFamily('sync_not_completing')).toBe('stalled')
    expect(stopReason('sync_stuck')).toBe('the oldest change waiting to upload hasn’t moved for a while.')
    expect(stopNext('sync_stuck', ['retry'])).toContain('Retry below tries now')
  })

  it('points a rebuild, a sign-in or a permission at the exit that ends it', () => {
    expect(stopNext('mapping_identity_conflict', ['retry', 'rebuild'])).toContain('Reset sync below to continue')
    expect(stopNext('mapping_identity_conflict', [])).toBe('Open the extension on that browser to reset its sync.')
    expect(stopNext('credential_revoked', [])).toBe('It signs in again by itself. If it keeps failing, open the extension on that browser and sign in again.')
    expect(stopNext('permission_required', ['retry'])).toBe('Open the extension on that browser and allow bookmark access.')
    expect(stopNext('network_unavailable', ['retry'])).toBe('It tries again by itself; Retry below tries now.')
    expect(stopNext('create_placement_unproven', [])).toBe('Open the extension on that browser to fix it.')
    expect(stopNext('queue_state_invalid', ['retry'])).toBe('It checks again by itself every so often; Retry below checks now.')
  })

  it('says a stopped browser looks again by itself, and when only a Reset ends it, where that button is', () => {
    expect(stopNext('queue_state_invalid', [])).toBe('It checks again by itself every so often.')
    expect(stopNext('storage_record_rejected', ['retry', 'rebuild'])).toContain('Retry below checks now')
    expect(stopNext('storage_record_rejected', ['retry', 'rebuild'])).toContain('Reset sync below clears it')
    // A Pull-time integrity stop waits for a person's Retry: it does not promise a recheck.
    expect(stopNext('pull_page_invalid', ['retry'])).toBe('Try the options below, or open the extension on that browser.')
  })
})

describe('the codes the push lane and browser storage added (stream 2)', () => {
  it('puts each in the family its class and exit give it, so the words match what ends it', () => {
    for (const code of ['push_server_unavailable']) expect(problemFamily(code), code).toBe('server_busy')
    for (const code of ['storage_blocked', 'storage_unavailable', 'indexeddb_failure', 'queue_not_drained', 'scope_not_writable',
      'sync_step_failed', 'push_attempt_missing']) expect(problemFamily(code), code).toBe('waiting')
    for (const code of ['push_request_refused', 'queue_row_unreadable', 'subscription_upload_excluded', 'push_attempt_bind_failed',
      'push_media_type_invalid', 'bootstrap_upload_excluded', 'bootstrap_boundary_unavailable']) expect(problemFamily(code), code).toBe('decide')
    for (const code of ['push_response_unrecognized', 'push_response_invalid', 'queue_head_unreadable', 'push_attempt_operation_changed']) {
      expect(problemFamily(code), code).toBe('stop_upload')
    }
    expect(problemFamily('storage_record_rejected')).toBe('stop_local')
  })

  it('words a stop of browser storage, an unreadable answer and a change that cannot be read', () => {
    expect(stopReason('future_schema')).toContain('newer version of the extension')
    expect(stopReason('diagnostic_read_only')).toContain('damaged')
    expect(stopReason('storage_record_rejected')).toContain('trying again gives the same answer')
    expect(stopReason('quota_exceeded')).toContain('no room left')
    expect(stopReason('push_response_invalid')).toContain('answer about a change couldn’t be understood')
    expect(stopReason('queue_head_unreadable')).toContain('can’t be read on that browser')
    expect(stopReason('push_attempt_operation_changed')).toContain('couldn’t be sent again')
  })

  it('reads a held request, a withdrawn consent and an unreadable change as items, never as the generic fallback', () => {
    const item = (code: string, direction: 'push' | 'local' = 'push') => issueSummary({ code, direction, actions: [] })
    expect(item('push_request_refused')).toContain('firewall or network filter')
    expect(item('metadata_sync_disabled')).toContain('tags or a description, which you chose not to sync')
    expect(item('queue_row_unreadable')).toContain('Retry saves it again')
    expect(item('queue_head_unreadable')).toContain('Resetting sync on that browser clears it')
    expect(item('push_server_unavailable')).toContain('isn’t answering this change')
    expect(item('subscription_upload_excluded')).toContain('subscribed folder')
    expect(item('sync_step_failed', 'local')).toContain('keeps failing')
  })

  it('titles an item that is not about one bookmark by what it is about', () => {
    expect(issueTitle({ code: 'sync_step_failed' })).toBe('Part of syncing')
    expect(issueTitle({ code: 'queue_head_unreadable' })).toBe('A saved change')
    expect(issueTitle({ code: 'queue_row_unreadable', nodeId: 'node-1' })).toBe('A bookmark in your library')
    expect(issueTitle({ code: 'push_request_refused', title: 'Reading list' })).toBe('Reading list')
    expect(issueTitle({ code: 'push_request_refused' })).toBe('A bookmark on that browser')
  })

  it('says why a request to a browser could not run: offline, a refused reset, a browser that was not running', () => {
    expect(resultReason('offline')).toContain('needs a connection')
    expect(resultReason('fence_refused')).toContain('Nothing was changed')
    expect(resultReason('scope_not_writable')).toContain('not running')
  })
})

describe('the codes the wire added (stream 1)', () => {
  it('puts each in the family its class and exit give it', () => {
    for (const code of ['authentication_required', 'credential_revoked', 'insufficient_scope']) expect(problemFamily(code), code).toBe('sign_in')
    for (const code of ['resource_not_found', 'session_invalid']) expect(problemFamily(code), code).toBe('authority')
    for (const code of ['clock_skew', 'bookmark_api_error', 'bookmark_write_quota', 'native_read_failed', 'server_configuration_failed']) {
      expect(problemFamily(code), code).toBe('waiting')
    }
    for (const code of ['service_unavailable', 'internal_error', 'rate_limited']) expect(problemFamily(code), code).toBe('server_busy')
    for (const code of ['origin_not_allowed', 'invalid_query', 'idempotency_key_reused', 'manifest_unavailable', 'server_version_mismatch',
      'session_replica_unknown']) expect(problemFamily(code), code).toBe('stop_local')
    expect(problemFamily('replica_retired')).toBe('retired')
    expect(problemFamily('snapshot_too_large')).toBe('stop_download')
    expect(problemFamily('pull_apply_move_cycle')).toBe('decide')
    expect(problemFamily('snapshot_native_projection_ambiguous')).toBe('confirm')
  })

  it('a server code the Snapshot client wrapped reads as the code inside, and keeps its spelling when it has no words', () => {
    expect(problemFamily('snapshot_503_service_unavailable')).toBe('server_busy')
    expect(stopReason('snapshot_503_service_unavailable')).toBe('the server had a problem and couldn’t answer.')
    expect(problemFamily('snapshot_http_401')).toBe('sign_in')
    expect(stopReason('snapshot_http_404')).toBe('the server no longer knows its sync session: it expired or was replaced.')
    expect(stopReason('snapshot_500_unlisted')).toContain('(snapshot_500_unlisted)')
  })

  it('says what each means now, and what ends it', () => {
    expect(stopReason('snapshot_too_large')).toBe('this library is too large for the server to send to a new device.')
    expect(stopNext('snapshot_too_large', ['retry'])).toBe('Ask whoever runs your Know-N server to raise its snapshot size limit (SYNC_SNAPSHOT_MAX_BYTES). Retry below checks again. Resetting will not help.')
    expect(stopNext('snapshot_too_large', [])).not.toContain('Retry')
    expect(stopReason('session_invalid')).toBe('it couldn’t start a session with the server.')
    expect(stopReason('session_invalid')).not.toContain('clock')
    expect(stopReason('clock_skew')).toBe('its clock is more than two minutes off the server’s.')
    expect(stopNext('clock_skew', [])).toBe('Set the clock on that computer to automatic time so sign-in and expiry checks stay reliable.')
    expect(stopReason('server_version_mismatch')).toContain('don’t match')
    expect(stopNext('server_version_mismatch', ['retry'])).toBe('Update the extension on that browser, or ask whoever runs your Know-N server to check its version. Retry below checks again.')
    expect(stopNext('origin_not_allowed', [])).toContain('allowed origins')
    expect(stopNext('manifest_unavailable', ['retry'])).toContain('server address')
    expect(stopNext('server_configuration_failed', [])).toContain('Site access')
    expect(stopReason('bookmark_write_quota')).toContain('limits how fast bookmarks can be changed')
    expect(stopReason('native_read_failed')).toContain('couldn’t read its bookmarks')
  })

  it('points a browser the server does not know at Reset when it is offered, and a refusal a Reset cannot end at no Reset at all', () => {
    expect(stopNext('session_replica_unknown', ['retry', 'rebuild'])).toContain('Reset sync below to register that browser again')
    expect(stopNext('session_replica_unknown', ['retry'])).toBe('Open the extension on that browser and sign out and in again to register it.')
    for (const code of ['snapshot_too_large', 'server_version_mismatch', 'origin_not_allowed', 'invalid_query', 'idempotency_key_reused', 'manifest_unavailable']) {
      expect(stopNext(code, ['retry', 'rebuild']), code).not.toMatch(/Reset sync below/u)
    }
    expect(resultReason('rebuild_cannot_help')).toContain('a reset would not help')
  })

  it('reads a folder the library wants inside itself, an identical bookmark and a deleted target as items', () => {
    const item = (code: string) => issueSummary({ code, direction: 'pull', actions: [] })
    expect(item('pull_apply_move_cycle')).toContain('one of its own subfolders')
    expect(item('snapshot_native_projection_ambiguous')).toContain('Delete the extra copy there and Retry')
    expect(item('snapshot_content_target_missing')).toContain('Deleted on that browser while your library still has it')
  })
})

describe('the item vocabulary is the extension’s (C-12)', () => {
  it('has a sentence of its own for every code the extension names, never the generic fallback', () => {
    const source = extensionSource('sync-issue-copy.ts')
    const block = source.slice(source.indexOf('const ITEM'), source.indexOf('export const ISSUE_SUMMARY_CODES'))
    const codes = [...block.matchAll(/^ {2}([a-z_]+): \(\) =>/gmu)].map(match => match[1]!)
    expect(codes.length).toBeGreaterThan(25)
    const generic = new Set(['The server didn’t accept this change', 'Couldn’t be applied in the browser', 'Couldn’t be prepared for sync'])
    for (const code of codes) {
      expect(generic.has(issueSummary({ code, direction: 'push', actions: [] })), code).toBe(false)
    }
  })

  it('reads a refused browser call as one, and a secret-looking field as a field', () => {
    expect(issueSummary({ code: 'apply_failed_bookmark_api_error', direction: 'pull', actions: [] }))
      .toBe('The browser refused to apply this change from your library, so it was set aside. Everything else keeps syncing')
    expect(issueSummary({ code: 'secret_field_forbidden', direction: 'push', actions: [] })).toContain('password or key')
  })
})

describe('how a request to a browser ended (C-12)', () => {
  it('explains the failures that used to read “it reported x”, each with what to do', () => {
    expect(resultReason('upload_outcome_unsettled')).toContain('no confirmed result yet')
    expect(resultReason('upload_outcome_unsettled')).toContain('Try Retry first')
    expect(resultReason('native_outcome_unsettled')).toContain('waiting for your answer')
    expect(resultReason('rebuild_failed')).toContain('Its bookmarks are untouched')
    expect(resultReason('command_failed')).toContain('unexpected error')
    expect(resultReason('command_context_missing')).toContain('Try again')
  })

  it('a code nobody wrote words for is still a sentence with the code in brackets', () => {
    expect(resultReason('some_new_failure')).toBe('the browser couldn’t carry it out (some_new_failure)')
  })
})

describe('times a browser could not know', () => {
  it('treats the epoch as no time at all', () => {
    expect(isRealInstant('1970-01-01T00:00:00.000Z')).toBe(false)
    expect(isRealInstant('not a date')).toBe(false)
    expect(isRealInstant(null)).toBe(false)
    expect(isRealInstant('2026-10-24T10:00:00.000Z')).toBe(true)
  })
})

describe('how close a browser is to the open-items limit (A-F8 / B-12)', () => {
  it('says nothing below the warning and names the limit and where to clear items from it', () => {
    expect(issueLimitNote(SYNC_ISSUE_WARNING - 1)).toBeUndefined()
    expect(issueLimitNote(SYNC_ISSUE_WARNING)).toBe('This browser has 150 open items. It stops syncing above 200. In the extension, open Sync, then Status, and use Try again or Dismiss to clear some.')
    expect(issueLimitNote(231)).toContain('231 open items')
  })

  it('uses the same numbers as the extension, read from its source', () => {
    const source = extensionSource('sync-issue-ceiling.ts')
    expect(source).toContain(`OPEN_SYNC_ISSUE_CEILING = ${SYNC_ISSUE_LIMIT}`)
    expect(source).toContain(`OPEN_SYNC_ISSUE_WARNING = ${SYNC_ISSUE_WARNING}`)
  })
})
