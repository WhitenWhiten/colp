/**
 * UI copy. Each call names a _locales key and carries its English text, so the
 * code reads as English and still works without chrome.i18n (unit tests, a key
 * the catalog lacks). scripts/i18n-catalog.mjs extracts these calls, plus the
 * data-i18n attributes in the HTML pages, into _locales/en/messages.json.
 *
 * Values fill Chrome's positional $1…$9; "$$" is a literal "$". Keys and
 * English must be literals so the extractor can read them.
 */
type Value = string | number;
type I18n = { getMessage(key: string, substitutions?: string[]): string };

function catalog(): I18n | undefined {
  return typeof chrome === 'undefined' ? undefined : (chrome as { i18n?: I18n }).i18n;
}

function fill(english: string, values: readonly string[]): string {
  return english.replace(/\$(\$|[1-9])/gu, (_, slot: string) => slot === '$' ? '$' : values[Number(slot) - 1] ?? '');
}

/* Manual language choice, stored per browser: 'auto' leaves the catalog Chrome
   resolved; a supported value pins that _locales directory, fetched once per
   context and kept as an override catalog t() reads first. */
export const UI_LANGUAGE_KEY = 'known.ui-language.v1';
export const UI_LANGUAGE_AUTO = 'auto';
/** The catalogs shipped under _locales/, as stored preference → directory name. */
export const UI_LANGUAGES: ReadonlyArray<{ value: string; dir: string }> = [
  { value: 'en', dir: 'en' },
  { value: 'zh-CN', dir: 'zh_CN' },
];

let override: Readonly<Record<string, string>> | undefined;
const languageListeners = new Set<() => void>();
const copyAssigners: Array<() => void> = [];
let watching = false, ready: Promise<boolean> | undefined;

function languageFor(value: unknown): { value: string; dir: string } | undefined {
  return typeof value === 'string' ? UI_LANGUAGES.find(language => language.value === value) : undefined;
}

async function fetchMessages(dir: string): Promise<Record<string, string> | undefined> {
  const response = await fetch(chrome.runtime.getURL(`_locales/${dir}/messages.json`)).catch(() => undefined);
  if (!response?.ok) return undefined;
  const messages: Record<string, string> = {};
  for (const [key, entry] of Object.entries(await response.json() as Record<string, { message?: unknown }>)) {
    if (typeof entry?.message === 'string') messages[key] = entry.message;
  }
  return messages;
}

function notifyLanguageChanged(): void {
  for (const listener of languageListeners) { try { listener(); } catch { /* One listener must not starve the rest. */ } }
}

async function applyPreference(value: unknown): Promise<boolean> {
  const language = languageFor(value);
  override = language ? await fetchMessages(language.dir).catch(() => undefined) : undefined;
  rules = undefined;
  for (const assign of copyAssigners) { try { assign(); } catch { /* One stale label must not block the rest. */ } }
  return override !== undefined;
}

function watchStoredLanguage(): void {
  if (watching || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  watching = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(UI_LANGUAGE_KEY in changes)) return;
    void applyPreference(changes[UI_LANGUAGE_KEY]?.newValue).then(notifyLanguageChanged);
  });
}

/**
 * Resolves the stored language once per context. Pages re-localize when it
 * resolves true; the worker re-titles its menus through onUiLanguageChanged.
 */
export function initI18n(): Promise<boolean> {
  ready ??= (async () => {
    watchStoredLanguage();
    try { return await applyPreference((await chrome.storage.local.get(UI_LANGUAGE_KEY))[UI_LANGUAGE_KEY]); }
    catch { return false; }
  })();
  return ready;
}

/** Fires when the stored language changes after initI18n — pages re-localize, the worker re-titles menus. */
export function onUiLanguageChanged(listener: () => void): void {
  languageListeners.add(listener);
}

/** The stored choice for the preferences select; 'auto' when unset or unreadable. */
export async function readUiLanguage(): Promise<string> {
  try { return languageFor((await chrome.storage.local.get(UI_LANGUAGE_KEY))[UI_LANGUAGE_KEY])?.value ?? UI_LANGUAGE_AUTO; }
  catch { return UI_LANGUAGE_AUTO; }
}

export async function setUiLanguage(value: string): Promise<void> {
  await chrome.storage.local.set({ [UI_LANGUAGE_KEY]: languageFor(value)?.value ?? UI_LANGUAGE_AUTO });
}

/**
 * Module-level copy (`export let LABEL: string; localized(() => { LABEL = t(…); })`).
 * Imports evaluate before the pinned catalog is fetched, so a plain
 * `const LABEL = t(…)` would stay in Chrome's language; the assignments run
 * again whenever the pinned language resolves or changes, and importers read
 * the live binding. Copy derived from another constant belongs in the same
 * callback (or a later one) so it follows too.
 */
export function localized(assign: () => void): void {
  assign();
  copyAssigners.push(assign);
}

export function t(key: string, english: string, ...values: Value[]): string {
  const strings = values.map(String);
  const manual = override?.[key];
  if (manual !== undefined) return fill(manual, strings);
  return catalog()?.getMessage(key, strings) || fill(english, strings);
}

/** The language of the catalog Chrome resolved (not the browser's): plural rules and <html lang> follow the copy shown. */
export function uiLanguage(): string {
  return t('locale', 'en');
}

/**
 * A moment in the extension's language, the way History writes it: "Oct 12, 2026, 7:55 AM", or only its date or
 * time. The browser's locale may differ from the copy shown, and seconds and all-number dates read as machine output.
 */
export function formatMoment(value: number | string | Date, part: 'both' | 'date' | 'time' = 'both'): string {
  const at = value instanceof Date ? value : new Date(value);
  const options: Intl.DateTimeFormatOptions = part === 'date' ? { dateStyle: 'medium' } : part === 'time' ? { timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  try { return at.toLocaleString(uiLanguage(), options); } catch { return at.toLocaleString(); }
}

let rules: Intl.PluralRules | undefined;
/** Count copy: `key_one` / `key_other`; $1 is the count. Languages without a singular form only use `_other`. */
export function tn(key: string, count: number, one: string, other: string, ...values: Value[]): string {
  rules ??= new Intl.PluralRules(uiLanguage());
  return rules.select(count) === 'one'
    ? t(`${key}_one`, one, count, ...values)
    : t(`${key}_other`, other, count, ...values);
}

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'data-tip'] as const;

/**
 * Localizes static HTML: data-i18n replaces an element's text, data-i18n-<attr>
 * one attribute. The English already in the markup is the fallback.
 */
export function localizePage(root: ParentNode = document): void {
  if (root === document) document.documentElement.lang = uiLanguage();
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    node.textContent = t(node.dataset.i18n!, node.textContent ?? '');
  }
  for (const attribute of ATTRIBUTES) {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`))) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)!, node.getAttribute(attribute) ?? ''));
    }
  }
}

/** "a, b, c" in English, "a、b、c" in Chinese. */
export function listCopy(parts: readonly string[]): string {
  return new Intl.ListFormat(uiLanguage(), { type: 'conjunction', style: 'narrow' }).format(parts);
}
