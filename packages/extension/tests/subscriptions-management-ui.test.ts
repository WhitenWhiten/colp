// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createSubscriptionList, type MappingRow } from '../src/subscriptions-ui/list.js';
import { createMappingDetail } from '../src/subscriptions-ui/detail.js';
import { createSubscriptionDiagnostics } from '../src/subscriptions-ui/diagnostics.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';
import { validateCommand } from '../src/bookmark-subscriptions/commands.js';
const id = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
const source = { sourceType: 'digest_series' as const, sourceId: 'series-1', title: 'Private series', owner: { displayName: 'Visible author' }, openUrl: 'https://know-n.com/library/digests/series-1/read' };
const mapping = { mappingId: id, subscriptionId: 'sub-1', generation: 'g1', status: 'active', createdAt: '2026-09-20', sourceRef: { sourceType: source.sourceType, sourceId: source.sourceId }, source, profileLabel: 'Current browser', digestMode: 'latest', editionLimit: 1, checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'inherit' }, local: { localAlias: 'Reading', state: 'current', enabled: true, rootNativeId: 'native', mountPath: ['Bar','Reading'], bookmarkCount: 12 } } as unknown as MappingRow;
let host: HTMLElement; const disposers: (() => void)[] = [];
const click = (name: string) => { const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === name); expect(button,name).toBeTruthy(); button!.click(); };
function worker(handler: (command: SubscriptionCommand) => Promise<unknown>): Send { return (async (command: SubscriptionCommand) => { expect(validateCommand({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command })).toBe(true); return handler(command); }) as Send; }
beforeEach(() => { document.body.replaceChildren(); host = document.createElement('div'); document.body.append(host); vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, preferences: { subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep' } })) } }); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });
it('drains live pages before state sorting while independently showing unmounted subscriptions', async () => {
  const calls: SubscriptionCommand[] = [];
  const data = { profileId: 'profile', capabilities: { protocolVersion: 1, contentEnabled: true }, subscriptions: { items: [{ subscriptionId: 'not-mounted', source: { ...source, title: 'Independent source' }, status: 'active' }], nextCursor: null } };
  const ui = createSubscriptionList(host, worker(async command => { calls.push(command); if (command.kind !== 'list') throw new Error('Unexpected'); return { ...data, mappings: command.cursor ? { items: [{ ...mapping, mappingId: second, status: 'terminating', local: { ...mapping.local, state: 'terminating' } }], nextCursor: null } : { items: [mapping], nextCursor: 'next-live' } }; }), vi.fn(), new URLSearchParams()); disposers.push(ui.dispose);
  await vi.waitFor(() => expect(host.textContent).toContain('Independent source'));
  expect(calls).toEqual([{ kind: 'list', status: 'live', scope: 'this_browser' }, { kind: 'list', cursor: 'next-live' }]);
  expect(host.querySelector('a[id^=subscription-mapping]')?.id).toBe('subscription-mapping-' + second);
  expect(host.querySelector('.subscription-card-path')?.textContent).toBe('Bar › Reading');
  expect(host.querySelector('.sub-row .list-row-meta')?.textContent).toContain('12 bookmarks');
});
it('keeps remote browser order and labels runtime state without local fabricated summaries', async () => {
  const ui = createSubscriptionList(host, worker(async () => ({ capabilities: { protocolVersion: 1, contentEnabled: true }, mappings: { items: [{ ...mapping, local: null, profileLabel: 'Offline laptop' }], nextCursor: 'remote-next' }, subscriptions: { items: [], nextCursor: null } })), vi.fn(), new URLSearchParams('devices=all_browsers')); disposers.push(ui.dispose);
  await vi.waitFor(() => expect(host.textContent).toContain('Offline laptop')); expect(host.textContent).toContain('That browser reports its own status'); expect(host.textContent).not.toContain('Content updated'); expect(host.querySelector('.subscription-card-path')).toBeNull(); expect(Array.from(host.querySelectorAll('button')).some(node => node.textContent === 'Next page')).toBe(true);
});
it('requires a reviewed changed Digest window before one atomic configuration patch', async () => {
  const calls: SubscriptionCommand[] = [];
  const ui = createMappingDetail(host, worker(async command => { calls.push(command); if (command.kind === 'mapping') return { mapping, local: mapping.local, etag: '"rev1"', sourceRef: mapping.sourceRef }; if (command.kind === 'source') return source; if (command.kind === 'sourcePreview') return { descriptor: { counts: { bookmarks: 12, editions: command.editionLimit, nodes: 0 }, editions: [{ editionId: 'old' }, ...(command.editionLimit === 1 ? [] : [{ editionId: 'new' }])], skippedByReason: [], expiresAt: new Date(Date.now()+60000).toISOString() }, nodes: [] }; if (command.kind === 'patch') return {}; throw new Error('Unexpected ' + command.kind); }), id, vi.fn()); disposers.push(ui.dispose);
  await vi.waitFor(() => expect(host.textContent).toContain('Content and updates'));
  const mode = host.querySelector('select')!; mode.value = 'recent'; mode.dispatchEvent(new Event('change')); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); expect(calls.some(c => c.kind === 'patch')).toBe(false);
  click('Preview content changes'); await vi.waitFor(() => expect(host.textContent).toContain('1 issues added'));
  host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await vi.waitFor(() => expect(calls.some(c => c.kind === 'patch')).toBe(true));
  expect(calls.filter(c => c.kind === 'patch')).toEqual([{ kind: 'patch', mappingId: id, expectedGeneration: 'g1', ifMatch: '"rev1"', patch: { digestMode: 'recent', editionLimit: 10, checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'inherit' } } }]);
});
it('keeps old pending diagnostics visible and clears only selected completed evidence', async () => {
  const calls: SubscriptionCommand[] = [], completed = '33333333-3333-4333-8333-333333333333';
  const ui = createSubscriptionDiagnostics(host, worker(async command => { calls.push(command); if (command.kind === 'list') return { mappings: { items: [mapping], nextCursor: null } }; if (command.kind === 'diagnosticsClear' || command.kind === 'diagnosticLocate') return {}; if (command.kind === 'diagnostics') return [{ id, mappingId: id, reasonCode: 'recovery_identity_uncertain', resolution: 'pending', time: 1, count: 1, repairTaskId: 'recovery' }, { id: completed, mappingId: id, reasonCode: 'readonly_native_created', resolution: 'preserved', time: Date.now(), count: 2, nativeId: 'personal', nativePath: ['Personal', 'Preserved'] }]; throw new Error('Unexpected'); }), new URLSearchParams('status=&days=1')); disposers.push(ui.dispose);
  await vi.waitFor(() => expect(host.textContent).toContain('safely tell which bookmarks are original'));
  expect(host.textContent).toContain('Current location: Personal › Preserved'); click('Show kept bookmark'); await vi.waitFor(() => expect(calls.find(c => c.kind === 'diagnosticLocate')).toEqual({ kind: 'diagnosticLocate', eventId: completed }));
  expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(1); const select = host.querySelector<HTMLInputElement>('input[type=checkbox]')!; select.checked = true; select.dispatchEvent(new Event('change')); click('Clear selected records'); await vi.waitFor(() => expect(calls.some(c => c.kind === 'diagnosticsClear')).toBe(true));
  expect(calls.find(c => c.kind === 'diagnosticsClear')).toEqual({ kind: 'diagnosticsClear', eventIds: [completed] });
});
