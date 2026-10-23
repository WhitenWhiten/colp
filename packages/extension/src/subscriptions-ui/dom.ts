import { formatMoment, relativeText, t } from '../i18n.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node;
}
export function button(label: string, action: () => void, primary = false): HTMLButtonElement {
  const node = el('button', label, primary ? 'btn btn-primary' : 'btn btn-secondary'); node.type = 'button'; node.addEventListener('click', action); return node;
}
export function link(label: string, href: string): HTMLAnchorElement {
  const node = el('a', label, 'btn btn-ghost');
  if (href.startsWith('#')) node.href = href;
  else { try { const url = new URL(href); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) { node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } } catch { /* Invalid source URLs remain inert. */ } }
  return node;
}
export function field(label: string, control: HTMLInputElement | HTMLSelectElement): HTMLDivElement {
  const row = el('div', undefined, 'field'); const title = el('label', label); control.id ||= 'subscription-input-' + crypto.randomUUID(); title.htmlFor = control.id; row.append(title, control); return row;
}
export function select(values: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const node = el('select'); for (const [id, label] of values) { const option = el('option', label); option.value = id; node.append(option); } node.value = value; return node;
}
export function status(): HTMLParagraphElement { const node = el('p', '', 'feedback'); node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); return node; }
export function date(value: number | string | undefined | null): string { return value ? formatMoment(value) : t('subscription_notChecked', 'Not yet'); }
/** Relative time for scanning ("5 minutes ago"); the exact time stays in the tooltip. */
export function when(value: number | string | undefined | null): HTMLTimeElement {
  const node = el('time'); if (!value) { node.textContent = t('subscription_notChecked', 'Not yet'); return node; }
  const at = new Date(value);
  node.textContent = relativeText(at);
  node.dateTime = at.toISOString(); node.title = formatMoment(at); return node;
}
/** Count copy with its number in <strong>, wherever the translation places it. */
export function counted(copy: string, count: number): (string | HTMLElement)[] {
  const value = String(count), at = copy.indexOf(value);
  return at < 0 ? [copy] : [copy.slice(0, at), el('strong', value), copy.slice(at + value.length)];
}
export type Tone = 'success' | 'danger' | 'warning' | 'accent' | 'muted';
/** The kit's badge: only problems and caution wear a color; work in flight and settled states stay neutral. */
export function pill(label: string, tone: Tone): HTMLSpanElement {
  const node = el('span', label, 'badge'); if (tone === 'danger' || tone === 'warning' || tone === 'success') node.dataset.tone = tone; return node;
}
export function heading(level: 'h3' | 'h4', title: string, ...trailing: Node[]): HTMLDivElement {
  const row = el('div', undefined, 'subscription-card-head'); row.append(el(level, title), ...trailing); return row;
}
/** Label/value pairs as one definition list instead of "Label: value" paragraphs. */
export function facts(rows: readonly (readonly [string, string | Node])[], className = 'subscription-facts'): HTMLDListElement {
  const list = el('dl', undefined, className);
  for (const [label, value] of rows) { const row = el('div'), dd = el('dd'); dd.append(value); row.append(el('dt', label), dd); list.append(row); }
  return list;
}
/** The rss mark every subscription row wears where a bookmark would wear its favicon. */
export function rssTile(): HTMLElement { const mark = el('span', undefined, 'favicon-tile'); mark.append(createIcon('rss', 16)); return mark; }
export function section(title: string, className = 'subscription-section'): HTMLElement { const node = el('section', undefined, className); node.append(el('h3', title)); return node; }
export function errorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : 'subscription_runtime_unavailable';
  const labels: Record<string, string> = {
    subscription_runtime_unavailable: t('subscription_error_subscription_runtime_unavailable', 'Subscriptions are unavailable. Check the extension and server, then retry.'),
    sign_in_required: t('subscription_error_sign_in_required', 'Sign in to your Know-N account to continue.'), permission_required: t('subscription_error_permission_required', 'Allow bookmark access, then retry.'),
    revision_conflict: t('subscription_error_revision_conflict', 'Settings changed somewhere else. Reload and check them before confirming.'), precondition_failed: t('subscription_error_precondition_failed', 'The preview changed. Refresh and review it before confirming.'),
    snapshot_expired: t('subscription_error_snapshot_expired', 'The preview expired. Refresh it; your choices are retained.'), target_missing: t('subscription_error_target_missing', 'The selected folder no longer exists. Choose a location again.'),
    resolve_exit_policy: t('subscription_error_resolve_exit_policy', 'Your defaults for leaving a subscription are still syncing. Try again in a moment.'),
    preview_changed: t('subscription_error_preview_changed', 'Local content changed after the preview. Review again before confirming.'), preview_expired: t('subscription_error_preview_expired', 'The preview expired. Review again; your choices are retained.'), preview_invalid: t('subscription_error_preview_invalid', 'This preview no longer belongs to the current session. Review again.'), apply_epoch_changed: t('subscription_error_apply_epoch_changed', 'This subscription changed while the action was running. Check its current state.'), generation_mismatch: t('subscription_error_generation_mismatch', 'This subscription folder was replaced. Go back to the list and open the current one.'), recovery_target_required: t('subscription_error_recovery_target_required', 'Choose a folder you can edit for the restored subscription.'), recovery_target_invalid: t('subscription_error_recovery_target_invalid', 'Choose a backup folder you can edit, outside every subscription folder.'), local_copy_incomplete: t('subscription_error_local_copy_incomplete', "The copy isn't complete yet. Nothing was removed; recheck recovery to continue."), local_copy_changed: t('subscription_error_local_copy_changed', 'The copy changed while it was being checked. Review recovery again.'), local_copy_missing: t('subscription_error_local_copy_missing', 'The backup copy is missing. Review recovery again.'), storage_unavailable: t('subscription_error_storage_unavailable', "Browser storage is unavailable. Nothing is removed until it's back."), subscription_scope_changed: t('subscription_error_subscription_scope_changed', 'Your account or this page changed. Open the subscription again.'), cleanup_pending: t('subscription_error_cleanup_pending', 'Cleanup is still running. Recheck recovery before changing this subscription.'),
    content_disabled: t('subscription_error_content_disabled', 'Know-N has paused new content. What you already have stays, and you can still remove subscriptions.'),
  };
  return labels[code] ?? t('subscription_error_unconfirmed', 'The action is not confirmed. Refresh to check its current state.');
}
export function modal(title: string, trigger: HTMLElement | null = document.activeElement as HTMLElement | null) {
  const { dialog, body, actions } = createDialog(title, 'subscription-dialog'); const cancel = dialogButton(t('common_cancel', 'Cancel')); cancel.addEventListener('click', () => dialog.close()); actions.append(cancel);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); }); document.body.append(dialog); dialog.showModal(); cancel.focus();
  return { dialog, body, actions, cancel };
}
