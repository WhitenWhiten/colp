// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationStateView, BrowserListEntryView, BrowserListView, BrowserPreviewPageView, BrowserPreviewSampleRow, BrowserPreviewView, BrowserRuleView,
  BrowserSetView } from '../src/automation/messages.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set<string>() }));

import { bindAutomationsPane } from '../src/automation/options-pane.js';

/**
 * Doc 17 RW-04 (RS-01, RS-03): Options shows this browser's rules as one ordered list of rules, sets and
 * subscriptions, reorders it with Move up, Move down and dragging, and changes it only through the worker.
 */
const NOW = Date.parse('2026-10-18T08:00:00.000Z');
const rule = (id: string, over: Partial<BrowserRuleView> = {}): BrowserRuleView => ({ id, name: `Rule ${id}`, enabled: true, active: true, setId: null,
  keepHere: false, match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: `${id}.example` }] },
  draft: { name: `Rule ${id}`, combinator: 'all', conditions: [{ kind: 'siteIs', value: `${id}.example` }], action: { kind: 'file', folderNativeId: 'f-papers' } },
  folder: { nativeId: 'f-papers', title: 'Papers', path: ['Bookmarks bar', 'Papers'] }, folderMissing: false, account: null, move: null, localOnly: false,
  moving: false, movingStale: false, ...over });
const set = (id: string, rules: BrowserRuleView[], over: Partial<BrowserSetView> = {}): BrowserListEntryView =>
  ({ kind: 'set', set: { id, name: `Set ${id}`, enabled: true, origin: { kind: 'custom' }, rules: rules.map((item) => ({ ...item, setId: id })), ...over } });
const one = (item: BrowserRuleView): BrowserListEntryView => ({ kind: 'rule', rule: item });

function view(entries: BrowserListEntryView[], list: Partial<BrowserListView> = {}): AutomationStateView {
  const browserRules = entries.flatMap((entry) => entry.kind === 'rule' ? [entry.rule] : entry.kind === 'set' ? entry.set.rules : []);
  return { account: 'signedOut', state: 'none', rules: [], placements: [], browserRules, browserList: { revision: 3, enabled: true, entries, orderNotice: null, ...list },
    pausedAt: null, pausedBy: null, expiresAt: null, lastRefreshAt: null, problem: null, webUrl: null, server: null, saving: { mode: 'manual', ai: null, suggestInForm: false } };
}
const standard = () => view([one(rule('a')), set('s', [rule('b'), rule('c')]), one(rule('d')), { kind: 'subscription', id: 'sub', enabled: true }]);

let sent: Record<string, unknown>[] = [];
let reply: (message: Record<string, unknown>) => unknown;
let current: AutomationStateView;
let changed: ((changes: Record<string, unknown>, area: string) => void) | undefined;
const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim();

async function render(state: AutomationStateView): Promise<HTMLElement> {
  current = state;
  document.body.innerHTML = '<section><a data-automations-web hidden></a><button data-automations-new type="button">New rule</button><div data-automations-body></div></section>';
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://known/${path}`, sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      if (message.kind === 'known.automation.state') return { ok: true, state: current };
      if (message.kind === 'known.risk.state') return { ok: true, state: { mode: 'off', lists: [], exceptions: [] } };
      sent.push(message); return reply(message);
    }) },
    storage: { onChanged: { addListener: vi.fn((listener: typeof changed) => { changed = listener; }) } },
    permissions: { contains: async () => true, request: async () => true },
    bookmarks: { getTree: async () => [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [{ id: 'f-papers', title: 'Papers', children: [] }] }] }] },
  });
  bindAutomationsPane(document.querySelector('section')!).activate();
  await vi.waitFor(() => expect(document.querySelector('.rule-list, .automation-browser .empty')).not.toBeNull());
  return document.querySelector<HTMLElement>('[data-automations-body]')!;
}
/** The worker kept a change: the page reads the state again, as it does on the automation marker. */
async function repaint(state: AutomationStateView): Promise<void> {
  current = state;
  changed?.({ 'known.automation.changed.v1': { newValue: Date.now() } }, 'local');
  await vi.waitFor(() => expect(document.querySelector('.rule-list')).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-entry-id="${id}"] > .list-row`)!;
const control = (id: string, name: 'up' | 'down') => row(id).querySelector<HTMLButtonElement>(`[data-move="${name}"]`)!;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog.capture-dialog')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  sent = []; reply = () => ({ ok: true, revision: 4 }); changed = undefined;
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('the list on the page', () => {
  it('shows rules, sets and subscriptions in the order saves try them, each set over its own rules', async () => {
    const body = await render(standard());
    const list = body.querySelector('.rule-list')!;
    expect(Array.from(list.children).map((item) => (item as HTMLElement).dataset.entryId)).toEqual(['a', 's', 'd', 'sub']);
    expect(Array.from(list.querySelectorAll('[data-entry-id="s"] .rule-set-rules > li')).map((item) => (item as HTMLElement).dataset.entryId)).toEqual(['b', 'c']);
    expect(text(row('s').querySelector('.list-row-meta'))).toBe('2 rules · Your set');
    expect(text(row('sub'))).toContain('This browser can’t read this subscription, so it files nothing.');
    expect(text(body.querySelector('#automation-browser-heading'))).toBe('Rules in this browser4');
    expect(text(body.querySelector('.automation-browser .detail'))).toContain('Tried from the top, and the first that matches decides.');
  });

  it('dims what takes no part in saves: a rule in a switched-off set, the whole list switched off', async () => {
    await render(view([set('s', [rule('b', { active: false })], { enabled: false }), one(rule('a'))]));
    expect(row('s').dataset.off).toBe('');
    expect(row('b').dataset.off).toBe('');
    expect(row('a').dataset.off).toBeUndefined();
    await repaint(view([one(rule('a', { active: false }))], { enabled: false }));
    expect(text(document.querySelector('.automation-browser .detail'))).toBe('Switched off: pages you save keep the folder you save them to.');
    expect(document.querySelector('.automation-list-switch')!.getAttribute('aria-checked')).toBe('false');
  });

  it('switches a set, a subscription and the whole list through the worker', async () => {
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    row('sub').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    document.querySelector<HTMLButtonElement>('.automation-list-switch')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.enable', id: 's', enabled: false, entry: 'set' },
      { kind: 'known.automation.browser.enable', id: 'sub', enabled: false, entry: 'subscription' },
      { kind: 'known.automation.browser.list.enable', enabled: false }]);
  });
});

describe('moving entries', () => {
  it('moves an entry of the list up or down with the whole order, and not past either end', async () => {
    await render(standard());
    expect(control('a', 'up').disabled).toBe(true);
    expect(control('sub', 'down').disabled).toBe(true);
    control('d', 'up').click();
    control('s', 'down').click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.reorder', order: ['a', 'd', 's', 'sub'] },
      { kind: 'known.automation.browser.reorder', order: ['a', 'd', 's', 'sub'] }]);
  });

  it('moves a rule within its set, and out of it past either end', async () => {
    await render(standard());
    control('b', 'down').click();
    control('b', 'up').click();
    control('c', 'down').click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'b', into: 's', index: 1 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'b', into: null, index: 1 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'c', into: null, index: 2 }]);
  });

  it('keeps focus on the moved entry once the list repaints', async () => {
    await render(standard());
    control('d', 'up').click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await repaint(view([one(rule('a')), one(rule('d')), set('s', [rule('b'), rule('c')]), { kind: 'subscription', id: 'sub', enabled: true }]));
    expect(document.activeElement).toBe(control('d', 'up'));
  });

  it('says why a rule cannot leave its set', async () => {
    reply = () => ({ ok: false, error: 'unbound' });
    await render(standard());
    control('b', 'up').click();
    await vi.waitFor(() => expect(text(document.querySelector('.toast'))).toBe('Its set has no folder for it. Choose a folder first.'));
  });

  const drag = (from: HTMLElement, to: HTMLElement, clientY: number) => {
    from.dispatchEvent(new Event('dragstart', { bubbles: true }));
    to.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY }));
    to.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY }));
    from.dispatchEvent(new Event('dragend', { bubbles: true }));
  };

  it('drags with the same commands: into a set, out of one, and along the list', async () => {
    await render(standard());
    // Rows here measure 40px: the middle of a set's head takes a rule into it, its top and bottom place beside it.
    drag(row('a'), row('s'), 20);
    drag(row('c'), row('d'), 35);
    drag(row('d'), row('a'), 5);
    drag(row('s'), row('b'), 5);
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'a', into: 's', index: 2 },
      { kind: 'known.automation.browser.moveRule', ruleId: 'c', into: null, index: 3 },
      { kind: 'known.automation.browser.reorder', order: ['d', 'a', 's', 'sub'] }]);
  });

  it('drops a rule into an empty set through its hint row', async () => {
    await render(view([one(rule('a')), set('s', [])]));
    const hint = document.querySelector<HTMLElement>('.rule-set-empty')!;
    expect(text(hint)).toBe('No rules yet. Drag rules here, or add one.');
    drag(row('a'), hint, 10);
    expect(sent).toEqual([{ kind: 'known.automation.browser.moveRule', ruleId: 'a', into: 's', index: 0 }]);
  });
});

describe('sets', () => {
  it('are made with a name, and a nameless one is refused at once', async () => {
    reply = () => ({ ok: true, set: { id: 'n', name: 'Research' } });
    await render(standard());
    document.querySelector<HTMLButtonElement>('.automation-list-tools .btn')!.click();
    const form = dialog().querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(text(dialog().querySelector('.form-error'))).toBe('Give the set a name.');
    dialog().querySelector<HTMLInputElement>('input')!.value = '  Research ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sent).toEqual([{ kind: 'known.automation.browser.set.save', name: 'Research' }]);
  });

  it('ask whether their rules stay when deleted, and say why the worker could not keep them', async () => {
    reply = () => ({ ok: false, error: 'unbound' });
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('button[aria-label="Delete set"]')!.click();
    expect(text(dialog().querySelector('h3'))).toBe('Delete “Set s”?');
    const choices = Array.from(dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(choices.map((input) => [input.value, input.checked])).toEqual([['keep', true], ['delete', false]]);
    dialog().querySelector<HTMLButtonElement>('.btn-danger')!.click();
    await vi.waitFor(() => expect(text(dialog().querySelector('.form-error'))).toContain('Choose them, or delete the rules with the set.'));
    choices[1]!.click();
    dialog().querySelector<HTMLButtonElement>('.btn-danger')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.set.remove', id: 's', keepRules: true },
      { kind: 'known.automation.browser.set.remove', id: 's', keepRules: false }]);
  });

  it('start a new rule inside themselves, and copy a rule or a set below the original', async () => {
    await render(standard());
    row('s').querySelector<HTMLButtonElement>('button[aria-label="New rule in this set"]')!.click();
    const editor = document.querySelector<HTMLDialogElement>('dialog.automation-rule-editor')!;
    expect(editor.querySelector<HTMLSelectElement>('.automation-in-set select')!.value).toBe('s');
    editor.close();
    row('b').querySelector<HTMLButtonElement>('button[aria-label="Duplicate rule"]')!.click();
    row('s').querySelector<HTMLButtonElement>('button[aria-label="Duplicate set"]')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.duplicate', id: 'b', entry: 'rule', name: 'Rule b (copy)' },
      { kind: 'known.automation.browser.duplicate', id: 's', entry: 'set', name: 'Set s (copy)' }]);
  });
});

describe('the one-time note about order (R2)', () => {
  it('names the rules whose order now decides, until it is read', async () => {
    await render(view([one(rule('a')), one(rule('b'))], { orderNotice: [{ upper: 'Rule a', lower: 'Rule b' }] }));
    const notice = document.querySelector('.automation-browser .inline-alert')!;
    expect(text(notice)).toContain('the upper one files it now: “Rule a” before “Rule b”.');
    notice.querySelector<HTMLButtonElement>('button')!.click();
    expect(sent).toEqual([{ kind: 'known.automation.browser.notice.dismiss' }]);
  });
});

describe('Try a page (RS-08)', () => {
  const page = (over: Partial<BrowserPreviewPageView> = {}): BrowserPreviewPageView => ({ url: 'https://arxiv.org/abs/1', title: 'A paper', outcome: 'placed',
    winner: { id: 'b', name: 'Rule b', kind: 'setRule', ruleId: 'b', setId: 's', sourceName: 'Set s' }, folder: { nativeId: 'f-papers', title: 'Papers' },
    broad: false, skipped: [{ id: 'a', name: 'Rule a', kind: 'rule', ruleId: 'a', sourceName: null }],
    shadowed: [{ id: 'd', name: 'Rule d', kind: 'rule', ruleId: 'd', sourceName: null },
      { id: 'e-1', name: 'Trackers', kind: 'subscriptionEntry', subscriptionId: 'sub', entryId: 'e-1', contentVersion: '2026.10.1', sourceName: 'Community list' }],
    ...over });
  const answer = (preview: Partial<BrowserPreviewView>): BrowserPreviewView => ({ listRevision: 3, contentVersions: {}, stopped: null, ...preview });
  const sampleRow = (nativeId: string, folder: string | null): BrowserPreviewSampleRow => ({ nativeId, title: `Bookmark ${nativeId}`, url: `https://${nativeId}.example/`,
    outcome: folder ? 'placed' : 'none', winnerId: folder ? 'a' : null, winnerName: folder ? 'Rule a' : null, folder });
  const card = () => document.querySelector<HTMLElement>('.automation-preview')!;
  const field = (label: string) => Array.from(card().querySelectorAll<HTMLInputElement>('input')).find((input) => card().querySelector(`label[for="${input.id}"]`)?.textContent === label)!;
  const submit = () => card().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

  it('asks the worker about a link and a title, and names the winner, what it passed over and what it shadows', async () => {
    reply = (message) => message.kind === 'known.automation.browser.preview' ? { ok: true, preview: answer({ page: page() }) } : { ok: true, revision: 4 };
    await render(standard());
    field('Link').value = 'arxiv.org/abs/1'; field('Title').value = ' A paper ';
    submit();
    await vi.waitFor(() => expect(card().querySelector('.automation-preview-result')).not.toBeNull());
    expect(sent).toEqual([{ kind: 'known.automation.browser.preview', url: 'https://arxiv.org/abs/1', title: 'A paper' }]);
    expect(text(card().querySelector('.automation-preview-verdict'))).toBe('Goes to Papers, by “Rule b” in “Set s”.');
    expect(Array.from(card().querySelectorAll('.automation-preview-entries')).map((block) => [text(block.querySelector('p')),
      ...Array.from(block.querySelectorAll('li')).map((item) => text(item))])).toEqual([
      ['Passed over: this page lacks what they ask about', '“Rule a”'],
      ['Also match, but come later, so they never get it', '“Rule d”', '“Trackers” from “Community list”, version 2026.10.1']]);
    expect(card().querySelector('.automation-preview-broad')).toBeNull();
  });

  it('labels a broad winner with what it shadows in the sample, and says what nothing matching means', async () => {
    let next = answer({ page: page({ winner: { id: 'a', name: 'Rule a', kind: 'rule', ruleId: 'a', sourceName: null }, broad: true, broadShadows: 3, skipped: [], shadowed: [] }) });
    reply = (message) => message.kind === 'known.automation.browser.preview' ? { ok: true, preview: next } : { ok: true, revision: 4 };
    await render(standard());
    field('Link').value = 'https://colp.io/';
    submit();
    await vi.waitFor(() => expect(card().querySelector('.automation-preview-broad')).not.toBeNull());
    expect(text(card().querySelector('.automation-preview-broad'))).toBe('Broad: it takes every site under a public suffix, and shadows 3 later entries in your sample.');
    next = answer({ page: page({ outcome: 'none', winner: null, folder: null, skipped: [], shadowed: [] }), stopped: 'listOff' });
    submit();
    await vi.waitFor(() => expect(text(card().querySelector('.automation-preview-verdict'))).toBe('No rule matches. The page stays where you save it.'));
    expect(text(card().querySelector('.automation-preview-result .detail'))).toBe('The list is switched off, so saves aren’t filed now. Switched on, it would do this:');
  });

  it('drops an answer once the list moves on (RS-08.4), and keeps the card across repaints', async () => {
    reply = (message) => message.kind === 'known.automation.browser.preview' ? { ok: true, preview: answer({ page: page() }) } : { ok: true, revision: 4 };
    await render(standard());
    const before = card();
    field('Link').value = 'https://arxiv.org/abs/1';
    submit();
    await vi.waitFor(() => expect(card().querySelector('.automation-preview-result')).not.toBeNull());
    await repaint({ ...standard(), browserList: { ...standard().browserList, revision: 3 } });
    expect([card() === before, card().querySelector('.automation-preview-result') !== null]).toEqual([true, true]);
    await repaint({ ...standard(), browserList: { ...standard().browserList, revision: 4 } });
    expect(card().querySelector('.automation-preview-result')).toBeNull();
    expect(text(card().querySelector('.automation-preview-output'))).toBe('Your list changed. Try again to see what it does now.');
    expect(field('Link').value).toBe('https://arxiv.org/abs/1');
  });

  it('tries the recent bookmarks, and after a change names those that would now go elsewhere (RS-08.3)', async () => {
    let rows = [sampleRow('one', 'Papers'), sampleRow('two', null)], revision = 3;
    reply = (message) => message.kind === 'known.automation.browser.preview' && 'sample' in message
      ? { ok: true, preview: answer({ listRevision: revision, sample: { size: rows.length, rows, broad: [] } }) }
      : message.kind === 'known.automation.browser.preview' ? { ok: true, preview: answer({ page: page() }) } : { ok: true, revision: 4 };
    await render(standard());
    card().querySelector<HTMLButtonElement>('.automation-preview-more .btn')!.click();
    await vi.waitFor(() => expect(card().querySelector('.automation-preview-verdict')).not.toBeNull());
    expect(text(card().querySelector('.automation-preview-verdict'))).toBe('Of your 2 most recent bookmarks, rules would file 1 and keep 0 where they are; 1 match no rule.');
    // The sample's bookmarks can be tried one by one.
    const picks = card().querySelector<HTMLSelectElement>('.automation-preview-more select')!;
    expect(Array.from(picks.options).map((option) => option.textContent)).toEqual(['none', 'Bookmark one', 'Bookmark two']);
    picks.value = 'two'; picks.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.preview', nativeId: 'two' }));
    // A move: the card asks again and compares.
    rows = [sampleRow('one', 'Reading'), sampleRow('two', null)]; revision = 4;
    await repaint({ ...standard(), browserList: { ...standard().browserList, revision: 4 } });
    await vi.waitFor(() => expect(text(card().querySelector('.automation-preview-compare'))).not.toBe(''));
    expect([text(card().querySelector('.automation-preview-compare p')), text(card().querySelector('.automation-preview-compare li'))])
      .toEqual(['After this change, 1 of your 2 recent bookmarks would go elsewhere.', 'Bookmark one: Papers → Reading']);
    expect(sent.filter((message) => 'sample' in message)).toHaveLength(2);
  });
});

describe('the rules file (doc 17 §5.3)', () => {
  const file = { format: 'known-rules-config/v1', exportedAt: NOW, folders: [{ nativeId: '30', title: 'Papers', path: ['Bookmarks bar', 'Papers'] },
    { nativeId: '31', title: 'Elsewhere', path: ['Other bookmarks', 'Elsewhere'] }], list: { enabled: true, entries: [
    { kind: 'rule', rule: { id: 'r1', enabled: true, name: 'Papers', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
      action: { kind: 'file', folderNativeId: '30' } } },
    { kind: 'rule', rule: { id: 'r2', enabled: true, name: 'Other', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'other.example' }],
      action: { kind: 'file', folderNativeId: '31' } } }] } };
  async function choose(content: string): Promise<HTMLDialogElement> {
    const card = document.querySelector<HTMLElement>('.automation-config')!;
    const input = card.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'rules.json', { type: 'application/json' })] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('dialog.automation-config-dialog')).not.toBeNull());
    return document.querySelector<HTMLDialogElement>('dialog.automation-config-dialog')!;
  }

  it('asks for a folder here for each folder in the file, suggesting the same path, and sends only the choices', async () => {
    reply = () => ({ ok: true, imported: { revision: 4, rules: 2, sets: 0, subscriptions: 0, skipped: 0 } });
    await render(standard());
    const dialog = await choose(JSON.stringify(file));
    expect(text(dialog.querySelector('.automation-preview-verdict'))).toBe('“rules.json” has 2 rules');
    await vi.waitFor(() => expect(text(dialog.querySelector('.folder-pill'))).toContain('Papers'));
    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    expect(text(dialog.querySelector('.form-error'))).toBe('Choose a folder here for “Elsewhere”.');
    expect(sent).toEqual([]);
    const pills = dialog.querySelectorAll<HTMLButtonElement>('.folder-pill');
    pills[1]!.click();
    pills[1]!.closest('.folder-picker')!.querySelector<HTMLElement>('.folder-opt[data-folder-id="f-papers"]')!.click();
    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ kind: 'known.automation.browser.config.import', text: JSON.stringify(file), folders: { 30: 'f-papers', 31: 'f-papers' }, replace: false });
  });

  it('says plainly when a file is not a rules file', async () => {
    await render(standard());
    const input = document.querySelector<HTMLInputElement>('.automation-config input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['{"format":"known-browser-backup"}'], 'backup.json')] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(text(document.querySelector('.toast'))).toContain('This isn’t a Know-N rules file, or it is damaged.'));
    expect(document.querySelector('dialog.automation-config-dialog')).toBeNull();
  });
});

describe('rule sets from a file (doc 17 RS-02)', () => {
  const summary = { id: 'community-tech', name: 'Community technology sites', version: '2026.10.18-1', publisher: 'Example Collective', license: 'CC-BY-4.0',
    roles: [{ key: 'papers', description: 'Academic papers', rules: 1 }, { key: 'code', description: 'Source code', rules: 1 }], rules: 2, matchingOnly: 1, inactive: 0,
    sample: { size: 2_000, limit: 2_000, matched: 37, byRole: [{ role: 'papers', count: 30 }, { role: 'code', count: 7 }] } };
  async function pick(content: string): Promise<void> {
    document.querySelector<HTMLButtonElement>('[data-import-set]')!.click();
    const input = document.querySelector<HTMLInputElement>('body > input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'community.json', { type: 'application/json' })] });
    input.dispatchEvent(new Event('change'));
  }

  it('shows what the file adds, binds each role to a folder here, and adds the set', async () => {
    reply = (message) => message.kind === 'known.automation.browser.import.check' ? { ok: true, ruleset: summary } : { ok: true, set: {} };
    await render(standard());
    await pick('{"format":"colp.ruleset/v1"}');
    await vi.waitFor(() => expect(document.querySelector('dialog.automation-config-dialog')).not.toBeNull());
    const dialog = document.querySelector<HTMLDialogElement>('dialog.automation-config-dialog')!;
    expect(text(dialog.querySelector('h3'))).toBe('Import “Community technology sites”');
    expect(text(dialog.querySelector('.automation-preview-verdict'))).toBe('2 rules · version 2026.10.18-1 · Example Collective · CC-BY-4.0');
    expect(text(dialog.querySelector('.detail'))).toBe('Its rules would file 37 of your last 2000 bookmarks.');
    expect(Array.from(dialog.querySelectorAll('.automation-run-folders li')).map((item) => text(item))).toEqual(['Academic papers: 30 bookmarks', 'Source code: 7 bookmarks']);
    await vi.waitFor(() => expect(dialog.querySelectorAll('.folder-picker .folder-opt').length).toBeGreaterThan(0));
    const first = dialog.querySelectorAll<HTMLElement>('.folder-picker')[0]!;
    first.querySelector<HTMLButtonElement>('.folder-pill')!.click();
    first.querySelector<HTMLElement>('.folder-opt[data-folder-id="f-papers"]')!.click();
    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([{ kind: 'known.automation.browser.import.check', text: '{"format":"colp.ruleset/v1"}' },
      { kind: 'known.automation.browser.import', text: '{"format":"colp.ruleset/v1"}', bindings: { papers: 'f-papers', code: null } }]);
  });

  it('answers a refused file with where each problem is', async () => {
    reply = () => ({ ok: false, error: 'invalid', rulesetProblems: [{ pointer: '/entries/1/match', code: 'invalidMatch' }, { pointer: '/folder', code: 'unknownKey' }] });
    await render(standard());
    await pick('{}');
    await vi.waitFor(() => expect(document.querySelector('dialog.automation-ruleset-problems')).not.toBeNull());
    expect(Array.from(document.querySelectorAll('.automation-ruleset-problem-list li')).map((item) => text(item)))
      .toEqual(['/entries/1/match These conditions can’t be checked here', '/folder Not part of the format']);
  });

  it('marks a rule whose role has no folder yet, and lets the set’s folders be chosen', async () => {
    const waiting = rule('b', { role: 'Source code', needsFolder: true, folder: null, draft: null });
    await render(view([set('s', [waiting], { origin: { kind: 'import', sourceName: 'Community technology sites', sourceVersion: '2026.10.18-1', publisher: null },
      roles: [{ key: 'code', description: 'Source code', folder: null }] })]));
    expect(text(row('b').querySelector('.automation-recipe'))).toContain('no folder yet for “Source code”');
    expect(text(row('b').querySelector('.badge'))).toBe('Needs a folder');
    expect(text(row('s').querySelector('.list-row-meta'))).toBe('1 rule · Imported from Community technology sites, version 2026.10.18-1');
    row('s').querySelector<HTMLButtonElement>('button[aria-label="Choose the set’s folders"]')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.automation-config-dialog')!;
    expect(text(dialog.querySelector('h3'))).toBe('Folders for “Set s”');
    await vi.waitFor(() => expect(dialog.querySelectorAll('.folder-opt').length).toBeGreaterThan(0));
    dialog.querySelector<HTMLButtonElement>('.folder-pill')!.click();
    dialog.querySelector<HTMLElement>('.folder-opt[data-folder-id="f-papers"]')!.click();
    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.automation.browser.set.bind', id: 's', bindings: { code: 'f-papers' } }]));
  });
});

describe('Copy to my rules (RW-11)', () => {
  it('copies a set’s rule above the set, turning the original off unless told not to', async () => {
    await render(standard());
    row('b').querySelector<HTMLButtonElement>('button[aria-label="Copy to my rules"]')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.capture-dialog')!;
    expect(text(dialog.querySelector('h3'))).toBe('Copy “Rule b” to your rules?');
    expect(text(dialog.querySelector('.mgr-hint'))).toBe('The copy goes above “Set s” as a rule of your own, filing into Papers. It is tried before the set, and you can change it.');
    dialog.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(sent).toEqual([{ kind: 'known.automation.browser.copyEntry', ruleId: 'b', disableOriginal: true }]));
    // Rules outside a set are duplicated instead.
    expect(row('a').querySelector('button[aria-label="Copy to my rules"]')).toBeNull();
  });

  it('offers only switch, move and delete for a rule whose conditions the editor cannot write', async () => {
    await render(view([one(rule('a', { draft: null, match: null }))]));
    expect(row('a').querySelector('button[aria-label="Edit rule"]')).toBeNull();
    expect(row('a').querySelector('button[aria-label="Duplicate rule"]')).toBeNull();
    expect(text(row('a').querySelector('.automation-recipe'))).toContain('Matches its conditions');
    row('a').querySelector<HTMLElement>('.list-row-main')!.click();
    expect(document.querySelector('dialog.automation-rule-editor')).toBeNull();
  });
});

describe('a subscription in the list (doc 17 RW-13, RS-04, RS-05, RS-10)', () => {
  const papers = { nativeId: 'f-papers', title: 'Papers', path: ['Bookmarks bar', 'Papers'] };
  const record = (over: Record<string, unknown> = {}) => ({ id: 'sub', url: 'https://rules.example.org/c.json', origin: 'https://rules.example.org', name: 'Community',
    publisher: { name: 'Example Collective', url: null, feedbackUrl: 'https://example.org/issues' }, license: 'CC-BY-4.0', state: 'ready' as const, updatePolicy: 'review' as const,
    refreshIntervalHours: 24 as const, paused: false, pinned: false, currentVersion: '3', previousVersion: null, candidateVersion: '4', candidateWaits: 'review' as const,
    fetchedAt: NOW - 3_600_000,
    lastAttemptAt: NOW - 60_000, lastSuccessAt: NOW - 60_000, lastFailure: null, ...over });
  const subscription = (over: Record<string, unknown> = {}): BrowserListEntryView => ({ kind: 'subscription', id: 'sub', enabled: true, subscription: record(over),
    detail: { entries: [
      { id: 'e-arxiv', name: 'arXiv', enabled: true, match: { combinator: 'all', conditions: [{ kind: 'siteCollection', value: 'arXiv' }] }, role: 'Papers', folder: papers, needsFolder: false },
      { id: 'e-gh', name: 'GitHub', enabled: false, match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: 'github.com' }] }, role: 'Code', folder: null, needsFolder: true },
      { id: 'e-data', name: 'Data', enabled: true, match: null, role: null, folder: null, needsFolder: false }],
    roles: [{ key: 'papers', description: 'Papers', folder: papers }, { key: 'code', description: 'Code', folder: null }],
    exceptions: [{ id: 'x-1', scope: 'domain', value: 'example.org' }], goneSettings: 1,
    sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' },
      { host: 'xxx.lanl.gov', scope: 'exact', status: 'revoked', until: '2009-01-01' }] }] } });

  it('says where it comes from and how it is, lists its filing entries with their switches, and changes them through the worker', async () => {
    const body = await render(view([one(rule('a')), subscription()]));
    expect(text(row('sub'))).toContain('Community');
    expect(text(row('sub').querySelector('.list-row-meta'))).toBe('2 entries · version 3 · checked 1 minute ago');
    // The waiting version is said once, in its own row under the head with Review update, not as a badge too.
    expect(row('sub').querySelector('.badge')).toBeNull();
    expect(text(document.querySelector('[data-entry-id="sub"] > .automation-sub-waiting'))).toBe('Version 4 is waiting for your review.Review update');
    expect(Array.from(body.querySelectorAll('[data-entry-id="sub"] .rule-set-rules > li')).map((item) => (item as HTMLElement).dataset.entryId ?? text(item)))
      .toEqual(['sub:e-arxiv', 'sub:e-gh', '1 more entry only names a site, for rules of yours.']);
    expect(text(row('sub:e-arxiv').querySelector('.automation-recipe'))).toBe('From any address of arXivPapers');
    expect(text(row('sub:e-gh'))).toContain('no folder yet for “Code”');
    expect(text(row('sub:e-gh').querySelector('.badge'))).toBe('Needs a folder');
    // Its entries that file count in How a page finds its folder, beside the rules of this browser.
    const step = Array.from(document.querySelectorAll('.automation-flow-step')).find((node) => text(node.querySelector('.automation-flow-name')) === 'Rules in this browser');
    expect(text(step!.querySelector('.automation-flow-state'))).toBe('2 on');
    row('sub:e-arxiv').querySelector<HTMLButtonElement>('.automation-rule-switch')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.adjust', id: 'sub', change: { kind: 'entry', entryId: 'e-arxiv', enabled: false } }));
    const about = body.querySelector<HTMLDetailsElement>('.automation-sub-about')!;
    expect(text(about)).toContain('Fetched from rules.example.org over HTTPS');
    expect(text(about)).toContain('Published by Example Collective · Licence: CC-BY-4.0');
    expect(about.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.href).toBe('https://example.org/issues');
    expect(text(about.querySelector('.automation-sub-exceptions'))).toBe('example.org and its subdomains');
    expect(text(about.querySelector('.automation-sub-history'))).toBe('xxx.lanl.gov retired 2009-01-01');
    about.querySelector<HTMLInputElement>('.automation-sub-exception-form input')!.value = 'https://docs.example.net/x/y';
    about.querySelector<HTMLFormElement>('.automation-sub-exception-form')!.requestSubmit();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.adjust', id: 'sub',
      change: { kind: 'exception', scope: 'domain', value: 'docs.example.net' } }));
    Array.from(about.querySelectorAll<HTMLButtonElement>('.inline-alert button')).find((node) => text(node) === 'Clear')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.adjust', id: 'sub', change: { kind: 'clearGone' } }));
  });

  it('a waiting version says why it waits, Review shows what changes, and Apply sends it; pinned, it is not pressed (RS-12)', async () => {
    await render(view([subscription({ candidateWaits: 'roles', previousVersion: '2' })]));
    expect(text(document.querySelector('.automation-sub-waiting'))).toBe('Version 4 waits for your review: it changes the kinds of page it files.Review update');
    reply = (message) => message.kind === 'known.automation.browser.subscription.review' ? { ok: true, review: { id: 'sub', name: 'Community', currentVersion: '3',
      candidateVersion: '4', scope: { ok: false, reasons: ['roles'] }, diff: { added: [{ id: 'e-gh', name: 'GitHub' }], removed: [], changed: [{ id: 'e-arxiv', name: 'arXiv' }],
        roles: { added: [{ key: 'code', description: 'Code' }], removed: [] } }, sample: { size: 40, changed: 3, byFolder: [{ title: 'Papers', count: 2 }, { title: '', count: 1 }] } } }
      : { ok: true, subscription: record({ currentVersion: '4', candidateVersion: null }) };
    document.querySelector<HTMLButtonElement>('[data-review]')!.click();
    const review = await vi.waitFor(() => { const node = document.querySelector<HTMLDialogElement>('dialog.automation-review'); expect(node).not.toBeNull(); return node!; });
    expect(text(review)).toContain('It changes the kinds of page it files, so it always waits for your review.');
    expect(text(review)).toContain('Added (1)GitHub');
    expect(text(review)).toContain('Changed (1)arXiv');
    expect(text(review)).toContain('Of your last 40 bookmarks, 3 would be filed differently:Papers: 2 bookmarksStay where saved: 1 bookmark');
    expect(text(review)).toContain('New kinds of page it files.');
    Array.from(review.querySelectorAll<HTMLButtonElement>('button')).find((node) => text(node) === 'Apply version 4')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.apply', id: 'sub' }));
    // Settings: pin, and go back to the version kept.
    await repaint(view([subscription({ candidateWaits: 'pinned', pinned: true, previousVersion: '2' })]));
    expect(document.querySelector('.automation-sub-waiting')).toBeNull();
    expect(text(row('sub').querySelector('.badge'))).toBe('Pinned');
    row('sub').querySelector<HTMLButtonElement>('[aria-label="Update settings"]')!.click();
    const settings = document.querySelector<HTMLDialogElement>('dialog.automation-config-dialog')!;
    const pin = Array.from(settings.querySelectorAll('label.choice')).find((node) => text(node).startsWith('Pin version 3'))!.querySelector('input')!;
    expect(pin.checked).toBe(true);
    pin.click();
    Array.from(settings.querySelectorAll<HTMLButtonElement>('button')).find((node) => text(node) === 'Save')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ kind: 'known.automation.browser.subscription.update', id: 'sub', pinned: false }));
    row('sub').querySelector<HTMLButtonElement>('[aria-label="Update settings"]')!.click();
    const again = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog.automation-config-dialog')).at(-1)!;
    Array.from(again.querySelectorAll<HTMLButtonElement>('button')).find((node) => text(node) === 'Use previous version')!.click();
    const confirm = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog.capture-dialog')).at(-1)!;
    expect(text(confirm.querySelector('h3'))).toBe('Use version 2 of “Community” again?');
    Array.from(confirm.querySelectorAll<HTMLButtonElement>('button')).find((node) => text(node) === 'Use previous version')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.rollback', id: 'sub' }));
  });

  it('one not allowed to read its site yet says so, and asks in the click before fetching', async () => {
    await render(view([subscription({ state: 'notReady', currentVersion: null, candidateVersion: null, lastSuccessAt: null,
      lastFailure: { code: 'permission', at: NOW - 60_000 } })]));
    expect(text(row('sub'))).toContain('Not ready: This browser isn’t allowed to read rules.example.org yet.');
    expect(text(row('sub').querySelector('.badge'))).toBe('Not ready');
    const request = vi.spyOn(chrome.permissions, 'request');
    reply = () => ({ ok: true, subscription: record() });
    Array.from(document.querySelectorAll<HTMLButtonElement>('.automation-subscription > .inline-alert button')).find((node) => text(node) === 'Allow and fetch')!.click();
    expect(request).toHaveBeenCalledWith({ origins: ['https://rules.example.org/*'] });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.refresh', id: 'sub' }));
  });

  it('Subscribe takes an https address, asks to read its site in the click, checks it, and subscribes with folders and settings', async () => {
    await render(standard());
    const request = vi.spyOn(chrome.permissions, 'request');
    document.querySelector<HTMLButtonElement>('[data-subscribe]')!.click();
    const subscribe = document.querySelector<HTMLDialogElement>('dialog.automation-subscribe')!;
    const field = subscribe.querySelector<HTMLInputElement>('input[type="url"]')!;
    field.value = 'http://rules.example.org/c.json';
    subscribe.querySelector('form')!.requestSubmit();
    expect(text(subscribe.querySelector('.form-error'))).toBe('Use an https address, such as https://example.org/rules.json.');
    expect(request).not.toHaveBeenCalled();
    reply = (message) => message.kind === 'known.automation.browser.subscription.check' ? { ok: true, ruleset: { id: 'community', name: 'Community', version: '3',
      publisher: 'Example Collective', license: null, roles: [{ key: 'papers', description: 'Papers', rules: 1 }], rules: 1, matchingOnly: 1, inactive: 0, sample: null } }
      : { ok: true, subscription: record() };
    field.value = 'https://rules.example.org/c.json';
    subscribe.querySelector('form')!.requestSubmit();
    expect(request).toHaveBeenCalledWith({ origins: ['https://rules.example.org/*'] });
    await vi.waitFor(() => expect(text(subscribe)).toContain('Community · version 3 · Example Collective'));
    expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscription.check', url: 'https://rules.example.org/c.json' });
    expect(text(subscribe)).toContain('1 rule · 1 entry names a site only');
    Array.from(subscribe.querySelectorAll<HTMLButtonElement>('button')).find((node) => text(node) === 'Subscribe')!.click();
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ kind: 'known.automation.browser.subscribe', url: 'https://rules.example.org/c.json', bindings: { papers: null },
      updatePolicy: 'review', refreshIntervalHours: 24 }));
  });
});
