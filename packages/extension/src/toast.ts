import { createIcon, type IconName } from './icons.js';
import { t } from './i18n.js';

export type ToastTone = 'ok' | 'error' | 'info';

export interface ToastOptions {
  /**
   * The toast is the only place this message appears (e.g. a sign-in
   * failure), so it must be a live region. Leave it off when an inline live
   * region already speaks the same result; the toast is then visual only, to
   * avoid double speech.
   */
  readonly announce?: boolean;
}

/* Same slot rules as the web AppToast: one toast at a time, the newest
   replaces the last, every variant auto-dismisses. Long copy earns reading
   time on top of the variant floor, capped so nothing parks on screen. */
const VARIANTS: Record<ToastTone, { readonly icon: IconName; readonly className: string; readonly duration: number }> = {
  info: { icon: 'info', className: '', duration: 5_000 },
  ok: { icon: 'check', className: 'toast--success', duration: 6_000 },
  /* `cross` is the dismiss control; a second one in the status slot reads as a dead close button. */
  error: { icon: 'alert', className: 'toast--error', duration: 8_000 },
};
const READING_MS_PER_CHAR = 60;
const MAX_DURATION_MS = 12_000;

let active: { readonly el: HTMLElement; readonly close: () => void } | undefined;

export function toastDwell(copy: string, tone: ToastTone): number {
  return Math.min(MAX_DURATION_MS, Math.max(VARIANTS[tone].duration, copy.length * READING_MS_PER_CHAR));
}

/** Web-style pill toast (web AppToast + overlays.css recipe). */
export function showToast(copy: string, tone: ToastTone, options: ToastOptions = {}): void {
  active?.close();
  const variant = VARIANTS[tone];
  const el = document.createElement('div');
  el.className = variant.className ? `toast ${variant.className}` : 'toast';
  if (options.announce) {
    el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon(variant.icon));
  const message = document.createElement('span');
  message.className = 'toast-message';
  message.textContent = copy;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-close';
  dismiss.setAttribute('aria-label', t('common_dismissNotification', 'Dismiss notification'));
  /* A visual-only toast stays out of the tab order as well as the a11y tree. */
  if (!options.announce) dismiss.tabIndex = -1;
  dismiss.append(createIcon('cross'));
  el.append(icon, message, dismiss);

  let remaining = toastDwell(copy, tone);
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => close(), remaining);
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };
  const resume = () => {
    if (timer !== undefined || closed) return;
    startedAt = Date.now();
    timer = setTimeout(() => close(), remaining);
  };
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (active?.el === el) active = undefined;
    el.classList.add('is-closing');
    el.inert = true;
    el.addEventListener('animationend', () => el.remove(), { once: true });
    /* Removal still happens when no exit animation runs (reduced motion). */
    setTimeout(() => el.remove(), 400);
  }
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);
  dismiss.addEventListener('click', () => close());
  document.body.append(el);
  active = { el, close };
}

/** Clears the visible toast, e.g. once the action it reported has succeeded. */
export function dismissToast(): void {
  active?.close();
}
