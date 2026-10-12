// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWizard } from '../src/subscriptions-ui/wizard.js';
import { createNativePicker } from '../src/subscriptions-ui/native-picker.js';
import { contentSettings } from '../src/subscriptions-ui/content-settings.js';
import { createSubscriptionList, sortLocalMappings, type MappingRow } from '../src/subscriptions-ui/list.js';
import { createSubscriptionsShell } from '../src/subscriptions-ui/shell.js';
import { parseHubRoute } from '../src/options-router.js';
import { validateCommand } from '../src/bookmark-subscriptions/commands.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';
const source = { sourceType: 'digest_series', sourceId: 'series-one', title: 'Shared digest', owner: null, visibility: 'private', relations: ['shared'], sourceRole: 'viewer', openUrl: 'https://know-n.com/library/digests/series-one/read', updatedAt: '2026-09-20T00:00:00Z', allowedMappingModes: ['readonly'] };
const preview = { descriptor: { counts: { nodes: 1, bookmarks: 0, editions: 0, skipped: 0 }, skippedByReason: [], editions: [], expiresAt: new Date(Date.now() + 60000).toISOString() }, nodes: [{ key: 'root', parentKey: null, kind: 'folder', title: 'Shared digest' }] };
let host: HTMLElement;
const click = (name: string) => { const node = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === name); expect(node, name).toBeTruthy(); node!.click(); };
beforeEach(() => { document.body.replaceChildren(); host = document.createElement('div'); document.body.append(host); vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, preferences: {} })) }, permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) } }); });
afterEach(() => vi.unstubAllGlobals());
it('runs all four steps and performs no mount mutation before final confirmation', async () => {
  const calls: SubscriptionCommand[] = [], navigate = vi.fn();
  const send = (async (command: SubscriptionCommand) => {
    expect(validateCommand({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command })).toBe(true); calls.push(command);
    switch (command.kind) {
      case 'list': return { mappings: { items: [], nextCursor: null } };
      case 'sources': return { items: [source], nextCursor: null };
      case 'source': return source;
      case 'draft': case 'wizardDraft': return null;
      case 'directoryDefaults': return {};
      case 'sourcePreview': return preview;
      case 'folders': return { nodes: [{ id: '1', title: 'Bookmarks bar', disabled: false }, { id: 'managed', title: 'Managed folder', disabled: true, reason: 'managed' }] };
      case 'mountPreview': return { ...preview, token: '12345678-1234-4123-8123-123456789abc', expiresAt: Date.now()+60000, input: command };
      case 'mountConfirm': return { mapping: { mappingId: '12345678-1234-4123-8123-123456789abc' }, local: { state: 'initializing' } };
      default: throw new Error('Unexpected command ' + command.kind);
    }
  }) as Send;
  const wizard = createWizard(host, send, navigate);
  await vi.waitFor(() => expect(host.textContent).toContain('Shared digest')); click('Choose');
  await vi.waitFor(() => expect(host.querySelector('[aria-current=step]')?.textContent).toContain('Choose content'));
  const mode = host.querySelector('select')!; mode.value = 'recent'; mode.dispatchEvent(new Event('change')); expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Next')?.disabled).toBe(true); click('Refresh preview'); await vi.waitFor(() => expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Next')?.disabled).toBe(false));
  click('Next'); await vi.waitFor(() => expect(host.textContent).toContain('Bookmarks bar'));
  expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Managed folder')?.disabled).toBe(true);
  click('Bookmarks bar'); const parentLabel = Array.from(host.querySelectorAll('label')).find(node => node.textContent === 'New folder inside it (optional)')!; const parentInput = document.getElementById(parentLabel.htmlFor) as HTMLInputElement; parentInput.value = 'Private reading'; parentInput.dispatchEvent(new Event('input')); click('Next'); await vi.waitFor(() => expect(host.querySelector('[aria-current=step]')?.textContent).toContain('Review and add'));
  expect(calls.some(command => command.kind === 'mountConfirm')).toBe(false); expect(calls.find(command => command.kind === 'mountPreview')).toMatchObject({ parentDraft: { title: 'Private reading' } }); click('Add folder');
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('#subscriptions/detail?mapping=12345678-1234-4123-8123-123456789abc'));
  expect(calls.filter(command => command.kind === 'mountConfirm')).toHaveLength(1); wizard.dispose();
});
it('rejects invalid recent limits but latest always supplies one', () => {
  const read = contentSettings(host, true, { digestMode: 'recent', editionLimit: 10, checkIntervalMinutes: null, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'inherit' } }, () => undefined);
  const input = host.querySelector('input')!; for (const value of ['0', '21', '1.5']) { input.value = value; expect(read()).toBeNull(); expect(input.getAttribute('aria-invalid')).toBe('true'); }
  input.value = '20'; expect(read()?.editionLimit).toBe(20); host.querySelector('select')!.value = 'latest'; expect(read()?.editionLimit).toBe(1);
});
it('requests permissions in the button event then reads only through the worker', async () => {
  vi.mocked(chrome.permissions.contains).mockResolvedValue(false); const request = vi.mocked(chrome.permissions.request), send = vi.fn(async () => ({ nodes: [] })) as Send;
  const picker = createNativePicker(host, send, vi.fn()); expect(send).not.toHaveBeenCalled(); click('Allow bookmark access'); expect(request).toHaveBeenCalledWith({ permissions: ['bookmarks'] }); await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ kind: 'folders' })); picker.dispose();
});
it('fences a late private source list after clearing account state', async () => {
  host.innerHTML = '<div data-subscriptions-content></div><div data-subscription-diagnostics></div>';
  let resolve!: (value: unknown) => void; const pending = new Promise(value => { resolve = value; }); const shell = createSubscriptionsShell(host, vi.fn(), (async () => pending) as Send);
  shell.activate(parseHubRoute('#subscriptions/list')); shell.clear(); resolve({ profileId: 'p', mappings: { items: [], nextCursor: null }, subscriptions: { items: [{ source }], nextCursor: null }, capabilities: { protocolVersion: 1, contentEnabled: true } }); await Promise.resolve(); await Promise.resolve(); expect(host.textContent).not.toContain('Shared digest');
});
it('sorts full local lists by attention then running then creation and stable id', () => {
  const row = (id: string, state: string) => ({ mappingId: id, createdAt: '2026-09-01', status: 'active', local: { state } }) as MappingRow;
  expect(sortLocalMappings([row('b','current'),row('d','applying'),row('a','current'),row('c','local_change')]).map(item => item.mappingId)).toEqual(['c','d','a','b']);
});

it('removes a restored insertion index when the user chooses bottom', async () => {
  const changed = vi.fn(), picker = createNativePicker(host, (async () => ({ nodes: [] })) as Send, changed, { id: '1', path: 'Saved parent', index: 4 });
  const position = host.querySelector('select')!; position.value = 'bottom'; position.dispatchEvent(new Event('change'));
  expect(changed).toHaveBeenLastCalledWith({ id: '1', path: 'Saved parent' }); picker.dispose();
});

it('replaces the list controls with a sign-in step when the account is missing', async () => {
  const settings = document.createElement('div'); settings.id = 'subscription-defaults'; document.body.append(settings);
  const list = createSubscriptionList(host, (async () => { throw new Error('sign_in_required'); }) as Send, vi.fn(), new URLSearchParams());
  await vi.waitFor(() => expect(host.textContent).toContain('Sign in to use subscriptions'));
  expect(settings.hidden).toBe(true); settings.remove();
  expect(host.querySelector<HTMLFormElement>('form.subscription-filter-form')?.hidden).toBe(true);
  expect(host.querySelector<HTMLAnchorElement>('.connect-card a')?.getAttribute('href')).toBe('#account');
  list.dispose();
});
