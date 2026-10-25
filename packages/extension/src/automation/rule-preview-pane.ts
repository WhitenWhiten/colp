import { t, tn } from '../i18n.js';
import { button, el, selectOf, selectPill, setPill } from '../library-dom.js';
import type { AutomationStateView, BrowserPreviewEntryView, BrowserPreviewPageView, BrowserPreviewSampleRow, BrowserPreviewView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';

/**
 * Options › Rules in this browser › Try a page (doc 17 RS-08): a link and a title, or one of the recent
 * bookmarks, tried against the whole list by the worker; nothing is written. The answer names the entry
 * that would decide, the entries passed over and the later ones it hides, and calls out a winner that
 * takes a whole public suffix. *Try my recent bookmarks* runs the list over the latest bookmarks; the
 * card keeps that answer and, each time the list moves on, says which of them would now go elsewhere
 * (RS-08.3). An answer made from an older list is dropped rather than shown as current (RS-08.4).
 */
export interface RulePreview {
  /** The same card across repaints, so what it shows outlives them. */
  readonly element: HTMLElement;
  /** The page drew the list at this revision. */
  update(view: AutomationStateView): void;
}

const SHOWN_MOVES = 5, PICKS = 50;

/** "Rule “Papers” in “Research”": the entry with the set or subscription (and version) it is part of. */
export function entryLabel(entry: BrowserPreviewEntryView): string {
  if (entry.kind === 'setRule' && entry.sourceName) return t('automation_previewSetRule', '“$1” in “$2”', entry.name, entry.sourceName);
  if (entry.kind === 'subscriptionEntry' && entry.sourceName) {
    return entry.contentVersion ? t('automation_previewListRuleVersion', '“$1” from “$2”, version $3', entry.name, entry.sourceName, entry.contentVersion)
      : t('automation_previewListRule', '“$1” from “$2”', entry.name, entry.sourceName);
  }
  return t('automation_previewRule', '“$1”', entry.name);
}

function verdict(page: BrowserPreviewPageView): string {
  const winner = page.winner ? entryLabel(page.winner) : '';
  switch (page.outcome) {
    case 'placed': return t('automation_previewPlaced', 'Goes to $1, by $2.', page.folder?.title ?? '', winner);
    case 'kept': return t('automation_previewKept', 'Stays where you save it, by $1.', winner);
    case 'blocked': return page.reason === 'evaluation' ? t('automation_previewBlockedError', '$1 couldn’t be checked, so the page stays where you save it.', winner)
      : t('automation_previewBlockedFolder', '$1 matches, but its folder isn’t here, so the page stays where you save it.', winner);
    case 'none': return t('automation_previewNone', 'No rule matches. The page stays where you save it.');
  }
}

function entries(title: string, list: readonly BrowserPreviewEntryView[]): HTMLElement {
  const block = el('div', undefined, 'automation-preview-entries');
  const items = el('ul');
  for (const entry of list) items.append(el('li', entryLabel(entry)));
  block.append(el('p', title, 'form-label'), items);
  return block;
}

export function pageResult(preview: BrowserPreviewView): HTMLElement {
  const page = preview.page!;
  const result = el('div', undefined, 'automation-preview-result');
  if (preview.stopped === 'listOff') result.append(el('p', t('automation_previewListOff', 'The list is switched off, so saves aren’t filed now. Switched on, it would do this:'), 'detail'));
  const line = el('p', verdict(page), 'automation-preview-verdict');
  result.append(line);
  if (page.broad) {
    const broad = el('p', tn('automation_previewBroad', page.broadShadows ?? 0, 'Broad: it takes every site under a public suffix, and shadows $1 later entry in your sample.',
      'Broad: it takes every site under a public suffix, and shadows $1 later entries in your sample.'), 'automation-preview-broad');
    broad.dataset.tone = 'warning';
    result.append(broad);
  }
  if (page.skipped.length) result.append(entries(t('automation_previewSkipped', 'Passed over: this page lacks what they ask about'), page.skipped));
  if (page.shadowed.length) result.append(entries(t('automation_previewShadowed', 'Also match, but come later, so they never get it'), page.shadowed));
  return result;
}

/** What changed between two answers for the recent bookmarks: those whose folder or outcome is not the same (RS-08.3). */
export function movedInSample(before: readonly BrowserPreviewSampleRow[], after: readonly BrowserPreviewSampleRow[]):
  { readonly row: BrowserPreviewSampleRow; readonly was: BrowserPreviewSampleRow }[] {
  const earlier = new Map(before.map((row) => [row.nativeId || row.url, row]));
  return after.flatMap((row) => {
    const was = earlier.get(row.nativeId || row.url);
    return was && (was.outcome !== row.outcome || was.folder !== row.folder) ? [{ row, was }] : [];
  });
}

function sampleSummary(preview: BrowserPreviewView): HTMLElement {
  const sample = preview.sample!;
  const count = (outcome: BrowserPreviewSampleRow['outcome']) => sample.rows.filter((row) => row.outcome === outcome).length;
  const block = el('div', undefined, 'automation-preview-result');
  if (preview.stopped === 'listOff') block.append(el('p', t('automation_previewListOff', 'The list is switched off, so saves aren’t filed now. Switched on, it would do this:'), 'detail'));
  block.append(el('p', sample.size ? t('automation_previewSampleSummary', 'Of your $1 most recent bookmarks, rules would file $2 and keep $3 where they are; $4 match no rule.',
    sample.size, count('placed'), count('kept') + count('blocked'), count('none')) : t('automation_previewSampleEmpty', 'There are no bookmarks to try yet.'), 'automation-preview-verdict'));
  for (const entry of sample.broad) {
    const line = el('p', tn('automation_previewSampleBroad', entry.shadows, '$2 is broad: it takes every site under a public suffix, and shadows $1 later entry in your sample.',
      '$2 is broad: it takes every site under a public suffix, and shadows $1 later entries in your sample.', entryLabel(entry)), 'automation-preview-broad');
    line.dataset.tone = 'warning';
    block.append(line);
  }
  return block;
}

const where = (row: BrowserPreviewSampleRow) => row.outcome === 'placed' && row.folder ? row.folder : t('automation_previewWhereSaved', 'where you save it');

function compareBlock(moved: ReturnType<typeof movedInSample>, size: number): HTMLElement {
  const block = el('div');
  block.append(el('p', moved.length ? tn('automation_previewMoved', moved.length, 'After this change, $1 of your $2 recent bookmarks would go elsewhere.',
    'After this change, $1 of your $2 recent bookmarks would go elsewhere.', size)
    : t('automation_previewUnmoved', 'After this change, your $1 recent bookmarks would go where they did before.', size), 'detail'));
  if (moved.length) {
    const list = el('ul');
    for (const { row, was } of moved.slice(0, SHOWN_MOVES)) {
      list.append(el('li', t('automation_previewMovedRow', '$1: $2 → $3', row.title || row.url, where(was), where(row))));
    }
    block.append(list);
  }
  return block;
}

export function createRulePreview(): RulePreview {
  const card = el('section', undefined, 'set-card automation-preview');
  card.setAttribute('aria-labelledby', 'automation-preview-heading');
  const heading = el('h3', t('automation_previewTitle', 'Try a page')); heading.id = 'automation-preview-heading';
  const head = el('div', undefined, 'automation-preview-head');
  head.append(heading, el('p', t('automation_previewHint', 'See which rule would decide a page. Nothing is saved.'), 'detail'));
  const form = el('form', undefined, 'automation-preview-form'); form.noValidate = true;
  const field = (label: string, input: HTMLInputElement) => {
    const wrap = el('div', undefined, 'form-field');
    input.id = `automation-preview-${crypto.randomUUID()}`; input.className = 'field-quiet'; input.autocomplete = 'off';
    const caption = el('label', label, 'form-label'); caption.htmlFor = input.id;
    wrap.append(caption, input);
    return wrap;
  };
  const url = el('input'); url.type = 'url'; url.maxLength = 4_096; url.placeholder = 'https://arxiv.org/abs/2410.00001';
  const title = el('input'); title.type = 'text'; title.maxLength = 1_024; title.placeholder = t('automation_previewTitlePlaceholder', 'Optional');
  const go = button(t('automation_previewTry', 'Try'), 'btn btn-secondary btn-sm'); go.type = 'submit';
  const picks = selectOf([['', t('automation_previewPickNone', 'none')]]);
  const pick = selectPill(t('automation_previewPick', 'Or a recent bookmark'), picks); pick.hidden = true;
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const recent = button(t('automation_previewSample', 'Try my recent bookmarks'), 'btn btn-ghost btn-sm');
  const more = el('div', undefined, 'automation-preview-more'); more.append(recent, pick);
  form.append(field(t('automation_previewLink', 'Link'), url), field(t('automation_previewPageTitle', 'Title'), title), go, error, more);
  const output = el('div', undefined, 'automation-preview-output'); output.setAttribute('aria-live', 'polite');
  const compare = el('div', undefined, 'automation-preview-compare'); compare.setAttribute('aria-live', 'polite');
  card.append(head, form, output, compare);

  let revision: number | null = null, turn = 0, sampling = false;
  /** What the output holds, and from which revision of the list. */
  let shown: { readonly kind: 'page' | 'sample'; readonly revision: number } | null = null;
  let baseline: { readonly revision: number; readonly rows: readonly BrowserPreviewSampleRow[] } | null = null;

  function fail(copy: string): void { error.textContent = copy; error.hidden = false; }
  async function show(message: Record<string, unknown>): Promise<void> {
    const mine = ++turn; error.hidden = true; go.disabled = true;
    const reply = await send({ kind: 'known.automation.browser.preview', ...message } as never);
    go.disabled = false;
    if (mine !== turn) return;
    if (!reply.ok || !('preview' in reply) || !reply.preview.page) {
      output.replaceChildren(); shown = null;
      fail(!reply.ok && reply.error === 'invalidUrl' ? t('automation_previewBadLink', 'Use a web link, such as https://arxiv.org/abs/1.')
        : !reply.ok && reply.error === 'noAccess' ? t('automation_previewNoAccess', 'Know-N needs access to your bookmarks to try pages against your rules.')
          : !reply.ok && reply.error === 'notFound' ? t('automation_previewPickGone', 'That bookmark is gone.') : t('automation_previewFailed', 'Couldn’t try this page. Try again.'));
      return;
    }
    shown = { kind: 'page', revision: reply.preview.listRevision };
    output.replaceChildren(pageResult(reply.preview));
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = url.value.trim();
    if (!raw) { fail(t('automation_previewNeedLink', 'Paste a link to try.')); url.focus(); return; }
    setPill(picks, '');
    void show({ url: /^[a-z][\w+.-]*:/iu.test(raw) ? raw : `https://${raw}`, title: title.value.trim() });
  });
  picks.addEventListener('change', () => { if (picks.value) void show({ nativeId: picks.value }); });
  url.addEventListener('input', () => { error.hidden = true; });

  /**
   * The recent bookmarks' answers at this revision: shown when asked for (or when they are what the card
   * shows), and compared with the last ones the card kept once the list has moved on.
   */
  async function sample(asked: boolean): Promise<void> {
    if (sampling) return;
    sampling = true; recent.disabled = true;
    if (asked) { error.hidden = true; turn += 1; }
    const reply = await send({ kind: 'known.automation.browser.preview', sample: true });
    sampling = false; recent.disabled = false;
    if (!reply.ok || !('preview' in reply) || !reply.preview.sample) {
      if (asked) fail(!reply.ok && reply.error === 'noAccess' ? t('automation_previewNoAccess', 'Know-N needs access to your bookmarks to try pages against your rules.')
        : t('automation_previewSampleFailed', 'Couldn’t try your recent bookmarks. Try again.'));
      return;
    }
    const { listRevision, sample: rows } = reply.preview;
    if (baseline && baseline.revision !== listRevision) compare.replaceChildren(compareBlock(movedInSample(baseline.rows, rows.rows), rows.size));
    if (asked || shown?.kind === 'sample') { output.replaceChildren(sampleSummary(reply.preview)); shown = { kind: 'sample', revision: listRevision }; }
    baseline = { revision: listRevision, rows: rows.rows };
    const current = picks.value;
    picks.replaceChildren(...[['', t('automation_previewPickNone', 'none')] as const, ...rows.rows.slice(0, PICKS).map((row) => [row.nativeId, row.title || row.url] as const)]
      .map(([value, label]) => { const option = el('option', label); option.value = value; return option; }));
    setPill(picks, rows.rows.some((row) => row.nativeId === current) ? current : ''); pick.hidden = rows.rows.length === 0;
    // The list moved on while this ran: measure again against what was just kept.
    if (revision !== null && revision !== listRevision) void sample(false);
  }
  recent.addEventListener('click', () => void sample(true));

  return {
    element: card,
    update(view) {
      const next = view.browserList.revision;
      if (next === revision) return;
      revision = next;
      // A page's answer from an older list is not this list's answer (RS-08.4).
      if (shown?.kind === 'page' && shown.revision !== next) {
        shown = null; turn += 1;
        output.replaceChildren(el('p', t('automation_previewStale', 'Your list changed. Try again to see what it does now.'), 'detail'));
      }
      // Only a card that was asked about the recent bookmarks measures each change against them.
      if (baseline) void sample(false);
    },
  };
}
