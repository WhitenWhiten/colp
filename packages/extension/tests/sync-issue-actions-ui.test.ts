// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test, vi } from 'vitest';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { describeSyncAttention, issueActionOutcomeCopy, syncAttentionInput } from '../src/sync-attention-view.js';
import { syncIssueBulk, syncIssueRows } from '../src/sync-issue-rows.js';
import type { PublicSyncAttention, SyncIssueActionResponse, SyncIssueDiagnostic, SyncIssueLocalAction } from '../src/types.js';

/**
 * K5, B-07/C-04, A-F8/B-12: the Status card's Try again and Dismiss, per item and for every item of a kind,
 * and the line before sync stops for too many open items.
 */
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
  nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: true };
const item = (n: number, localActions: readonly SyncIssueLocalAction[], over: Partial<SyncIssueDiagnostic> = {}): SyncIssueDiagnostic =>
  ({ issueId: `issue${n}`, direction: 'push', code: 'push_rejected', title: `Bookmark ${n}`, count: 1, firstSeenAt: Date.parse('2026-10-24T08:00:00Z'),
    lastSeenAt: Date.parse('2026-10-24T08:00:00Z'), ...(localActions.length ? { localActions } : {}), ...over });
const attention = (issues: SyncIssueDiagnostic[], over: Partial<PublicSyncAttention> = {}): PublicSyncAttention =>
  ({ ...calm, issueCount: issues.length, issues, ...over });

describe('what the view says', () => {
  test('rows carry their own actions, and the bulk lists name every item that offers one, window or not', () => {
    const issues = [...Array.from({ length: 22 }, (_, i) => item(i, ['dismiss'])), item(100, ['retry']), item(101, ['retry']), item(102, [])];
    const { rows, more } = syncIssueRows(issues);
    assert.equal(rows.length, 20); assert.equal(more, 5);
    assert.deepEqual(rows[0]!.actions, ['dismiss']);
    const bulk = syncIssueBulk(issues);
    assert.equal(bulk.dismiss.length, 22, 'including the ones the window does not show');
    assert.deepEqual(bulk.retry, ['issue100', 'issue101']);
    assert.deepEqual(syncIssueBulk(undefined), { retry: [], dismiss: [] });
    assert.deepEqual(syncIssueBulk([{ direction: 'push', code: 'x', localActions: ['retry'] }]), { retry: [], dismiss: [] }, 'an item without an id cannot be named');
  });

  test('says what Retry sync does not do, only when an item offers Try again', () => {
    const withRetry = describeSyncAttention(syncAttentionInput(attention([item(1, ['retry'])]), undefined));
    assert.match(withRetry.issues.hint, /Retry sync checks the server again\. To release a held item, use Try again on it\./u);
    assert.equal(describeSyncAttention(syncAttentionInput(attention([item(1, ['dismiss'])]), undefined)).issues.hint, '');
  });

  test('warns before the ceiling, and leaves it to the stop card once sync has stopped', () => {
    const warned = describeSyncAttention(syncAttentionInput(attention([item(1, ['dismiss'])], { issueCeiling: { open: 163, limit: 200 } }), undefined));
    assert.deepEqual(warned.notes.lines.filter(line => /stops/u.test(line)),
      ['Sync stops when 200 items are open, and 163 are open now. Try again or dismiss some of them before it does.']);
    const stopped = describeSyncAttention(syncAttentionInput(attention([item(1, ['dismiss'])],
      { issueCeiling: { open: 201, limit: 200 }, lastError: 'sync_issue_ceiling', terminal: true, terminalCode: 'sync_issue_ceiling', recoveryFrozen: true, retryAutomatic: false }), undefined));
    assert.equal(stopped.notes.lines.some(line => /stops when/u.test(line)), false);
    assert.match(stopped.terminal.copy, /Try again or dismiss some of the items below, or all of one kind/u);
  });

  test('the outcome names what was done, what was not, and why', () => {
    const ok = (over: Partial<Extract<SyncIssueActionResponse, { ok: true }>>): SyncIssueActionResponse => ({ ok: true, done: 0, skipped: 0, failed: 0, ...over });
    assert.equal(issueActionOutcomeCopy('dismiss', ok({ done: 1 }), 1), 'Dismissed 1 item. This browser keeps its version.');
    assert.equal(issueActionOutcomeCopy('dismiss', ok({ done: 38 }), 38), 'Dismissed 38 items. This browser keeps its versions.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 2, woke: true }), 2), 'Tried again. 2 items are back in the upload queue.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 1, failed: 2, code: 'operation_schema_invalid' }), 3),
      'Tried again. 1 item is back in the upload queue. 2 items could not be tried again (operation_schema_invalid). They stay as they were.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ failed: 1, code: 'recovery_identity_unproven' }), 1),
      '1 item could not be tried again (recovery_identity_unproven). It stays as it was.');
    assert.equal(issueActionOutcomeCopy('dismiss', ok({ skipped: 1 }), 1), 'Nothing changed: the item is gone or no longer offers this.');
    assert.match(issueActionOutcomeCopy('dismiss', ok({ done: 250 }), 400), /More items are left\. Press again for the rest\.$/u);
    assert.equal(issueActionOutcomeCopy('retry', { ok: false, error: 'not_connected' }, 1), 'Could not do that (not_connected). The items stay as they were.');
    assert.equal(issueActionOutcomeCopy('retry', undefined, 1), 'Sync did not answer. Try again in a moment.');
  });
});

describe('the Status card', () => {
  async function mount(reads: PublicSyncAttention[], answer: SyncIssueActionResponse | 'silence' = { ok: true, done: 1, skipped: 0, failed: 0 }) {
    vi.useFakeTimers();
    let index = 0; const acted: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn(async (message: { kind: string }) => {
      if (message.kind === 'known.sync.attention.get') return { ok: true, attention: reads[Math.min(index++, reads.length - 1)] };
      if (message.kind === 'known.sync.issue.act') { acted.push(message as never); return answer === 'silence' ? undefined : answer; }
      return { ok: false, error: 'not_connected' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const markup = await readFile('options.html', 'utf8');
    const start = markup.indexOf('<section id="sync-attention-settings"');
    document.body.innerHTML = markup.slice(start, markup.indexOf('<section id="native-wait-settings"', start));
    document.body.dataset.pane = 'sync';
    bindSyncAttentionSettings();
    await vi.advanceTimersByTimeAsync(0);
    return { acted };
  }
  const buttons = (selector: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
  const click = async (node: HTMLElement) => { node.click(); await vi.advanceTimersByTimeAsync(0); };
  const feedback = () => document.getElementById('sync-attention-settings-feedback')!.textContent;

  test('each row offers the actions it was given, and nothing else', async () => {
    await mount([attention([item(1, ['retry']), item(2, ['dismiss']), item(3, [])])]);
    const row = (n: number) => document.querySelector(`[data-sync-issue="issue${n}"]`)!;
    assert.deepEqual(Array.from(row(1).querySelectorAll('button')).map(b => b.textContent), ['Try again']);
    assert.deepEqual(Array.from(row(2).querySelectorAll('button')).map(b => b.textContent), ['Dismiss']);
    assert.equal(row(2).querySelector('button')!.title, 'Closes this item and keeps this browser’s version. Nothing is deleted.');
    assert.equal(row(3).querySelectorAll('button').length, 0);
    assert.equal(document.getElementById('sync-attention-settings-issues-hint')!.hidden, false);
  });

  test('Dismiss on one row asks for that item, reads the card again, then says what happened', async () => {
    const { acted } = await mount([attention([item(1, ['dismiss']), item(2, ['dismiss'])]), attention([item(2, ['dismiss'])])],
      { ok: true, done: 1, skipped: 0, failed: 0 });
    await click(document.querySelector<HTMLButtonElement>('[data-sync-issue="issue1"] button')!);
    assert.deepEqual(acted, [{ kind: 'known.sync.issue.act', action: 'dismiss', issueIds: ['issue1'] }]);
    assert.equal(document.querySelectorAll('[data-sync-issue]').length, 1, 'the card follows the new reading');
    assert.equal(feedback(), 'Dismissed 1 item. This browser keeps its version.');
  });

  test('Try again for all names every item that offers it, including ones the window does not show', async () => {
    const issues = Array.from({ length: 24 }, (_, i) => item(i, ['retry']));
    const { acted } = await mount([attention(issues), attention([])], { ok: true, done: 24, skipped: 0, failed: 0, woke: true });
    const bulk = buttons('#sync-attention-settings-issues-bulk button');
    assert.deepEqual(bulk.map(b => b.textContent), ['Try again for all 24']);
    await click(bulk[0]!);
    assert.equal(acted.length, 1);
    assert.deepEqual(acted[0]!.issueIds, issues.map(issue => issue.issueId));
    assert.equal(feedback(), 'Tried again. 24 items are back in the upload queue.');
  });

  test('Dismiss all asks first and acts only on the second press', async () => {
    const issues = [item(1, ['dismiss']), item(2, ['dismiss']), item(3, ['dismiss'])];
    const { acted } = await mount([attention(issues), attention([])], { ok: true, done: 3, skipped: 0, failed: 0 });
    const all = () => buttons('#sync-attention-settings-issues-bulk button')[0]!;
    assert.equal(all().textContent, 'Dismiss all 3');
    await click(all());
    assert.equal(acted.length, 0, 'the first press only asks');
    assert.equal(all().textContent, 'Dismiss all 3? This browser keeps its versions.');
    await click(all());
    assert.equal(acted.length, 1);
    assert.deepEqual(acted[0]!.issueIds, ['issue1', 'issue2', 'issue3']);
    assert.equal(feedback(), 'Dismissed 3 items. This browser keeps its versions.');
  });

  test('the question goes away if nobody answers it', async () => {
    const issues = [item(1, ['dismiss']), item(2, ['dismiss'])];
    const { acted } = await mount([attention(issues)]);
    const all = () => buttons('#sync-attention-settings-issues-bulk button')[0]!;
    await click(all());
    assert.equal(all().textContent, 'Dismiss all 2? This browser keeps its versions.');
    await vi.advanceTimersByTimeAsync(6_000);
    assert.equal(all().textContent, 'Dismiss all 2');
    assert.equal(acted.length, 0);
  });

  test('no bulk buttons for a single item, and none when the worker said nothing offers an action', async () => {
    await mount([attention([item(1, ['dismiss']), item(2, [])])]);
    assert.equal(document.getElementById('sync-attention-settings-issues-bulk')!.hidden, true);
    assert.equal(buttons('#sync-attention-settings-issues-bulk button').length, 0);
  });

  test('a worker that does not answer is said, not read as success', async () => {
    await mount([attention([item(1, ['dismiss'])])], 'silence');
    const press = document.querySelector<HTMLButtonElement>('[data-sync-issue="issue1"] button')!;
    press.click();
    await vi.advanceTimersByTimeAsync(25_000);
    assert.equal(feedback(), 'Sync did not answer. Try again in a moment.');
  });
});
