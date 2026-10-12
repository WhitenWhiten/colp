import { createIcon } from './icons.js';
import { t } from './i18n.js';
import { ANNOTATION_LIMITS, normalizeAnnotationTags, type TagCount } from './popup-annotations.js';

/** Where a chip came from: typed or picked by the user, or accepted from an AI suggestion. */
export type TagOrigin = 'user' | 'ai';

export interface TagInputHost {
  /** The `.tag-input` field the chips and the text input live in. */
  readonly field: HTMLElement;
  readonly input: HTMLInputElement;
  /** Row of `.chip--suggest` buttons under the field. */
  readonly suggest: HTMLElement;
  /** Chips or the pending text changed. */
  readonly onChange: () => void;
}

export interface TagInput {
  tags(): string[];
  /** Chips accepted from an AI suggestion and still present. */
  aiTags(): string[];
  setTags(tags: readonly string[], origin?: TagOrigin): void;
  add(tag: string, origin?: TagOrigin): boolean;
  remove(tag: string): void;
  /** Text typed but not yet committed. */
  pending(): string;
  /** Turns the pending text into chips (used when the user moves on without pressing Enter). */
  commitPending(): void;
  setExisting(counts: readonly TagCount[]): void;
  setAiSuggestions(tags: readonly string[]): void;
  focus(): void;
}

const MAX_MATCHES = 5;

/**
 * Chips inline with a text input. Enter, comma or Tab commits the typed tag;
 * Backspace on an empty input removes the last chip; pasting "a, b" splits
 * into two. While typing, up to five existing tags that match are offered as
 * suggestion chips, next to any AI-suggested tags.
 */
export function createTagInput(host: TagInputHost): TagInput {
  const chips: { tag: string; origin: TagOrigin }[] = [];
  let existing: readonly TagCount[] = [];
  let ai: readonly string[] = [];
  const key = (tag: string) => tag.toLocaleLowerCase();
  const has = (tag: string) => chips.some((chip) => key(chip.tag) === key(tag));
  const emptyPlaceholder = host.input.placeholder;
  host.input.maxLength = ANNOTATION_LIMITS.tagLength;

  function render(): void {
    for (const node of Array.from(host.field.querySelectorAll('.chip'))) node.remove();
    for (const { tag } of chips) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.tag = tag;
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.setAttribute('aria-label', t('popup_removeTag', 'Remove tag $1', tag));
      remove.append(createIcon('cross', 10));
      remove.addEventListener('click', () => { api.remove(tag); host.input.focus(); });
      chip.append(label, remove);
      host.field.insertBefore(chip, host.input);
    }
    host.input.placeholder = chips.length ? '' : emptyPlaceholder;
    renderSuggestions();
  }

  function suggestions(): { tag: string; origin: TagOrigin }[] {
    const typed = host.input.value.trim();
    const needle = key(typed);
    const matches = typed === '' ? [] : existing.map((entry) => entry.tag)
      .filter((tag) => !has(tag) && key(tag).includes(needle) && key(tag) !== needle)
      .sort((a, b) => Number(key(b).startsWith(needle)) - Number(key(a).startsWith(needle)))
      .slice(0, MAX_MATCHES);
    const out: { tag: string; origin: TagOrigin }[] = matches.map((tag) => ({ tag, origin: 'user' }));
    for (const tag of ai) if (!has(tag) && !out.some((entry) => key(entry.tag) === key(tag))) out.push({ tag, origin: 'ai' });
    return out;
  }

  function renderSuggestions(): void {
    const next = suggestions();
    host.suggest.replaceChildren(...next.map(({ tag, origin }) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--suggest';
      chip.dataset.suggest = origin;
      chip.title = tag;
      const label = document.createElement('span');
      label.textContent = tag;
      chip.append(createIcon('plus', 13), label);
      chip.setAttribute('aria-label', t('popup_addTag', 'Add tag $1', tag));
      // Keep the typed text in place: a click must not blur the input first.
      chip.addEventListener('mousedown', (event) => { event.preventDefault(); });
      chip.addEventListener('click', () => {
        host.input.value = '';
        // Vocabulary members are canonical labels, including commas or leading '#'.
        if (origin === 'user' && existing.some(entry => entry.tag === tag)) {
          if (!has(tag) && chips.length < ANNOTATION_LIMITS.tags) {
            chips.push({ tag, origin }); render(); host.onChange();
          }
        } else api.add(tag, origin);
        host.input.focus();
      });
      return chip;
    }));
    host.suggest.hidden = next.length === 0;
  }

  /** A comma inside a tag splits it, exactly as the store does. */
  function commit(raw: string, origin: TagOrigin = 'user'): boolean {
    let added = false;
    for (const tag of normalizeAnnotationTags([raw])) {
      if (has(tag) || chips.length >= ANNOTATION_LIMITS.tags) continue;
      chips.push({ tag, origin });
      added = true;
    }
    return added;
  }

  function commitMany(raws: readonly string[]): void {
    let changed = false;
    for (const raw of raws) changed = commit(raw) || changed;
    host.input.value = '';
    render();
    if (changed) host.onChange();
  }

  host.field.addEventListener('click', (event) => {
    if (event.target === host.field) host.input.focus();
  });
  host.input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const value = host.input.value;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (value.trim()) commitMany([value]);
    } else if (event.key === 'Tab' && !event.shiftKey && value.trim()) {
      event.preventDefault();
      commitMany([value]);
    } else if (event.key === 'Backspace' && value === '' && chips.length) {
      event.preventDefault();
      api.remove(chips[chips.length - 1]!.tag);
    }
  });
  host.input.addEventListener('input', () => {
    // A comma typed through an input method or inserted by autofill splits like a paste.
    if (host.input.value.includes(',')) {
      const parts = host.input.value.split(',');
      const rest = parts.pop() ?? '';
      commitMany(parts);
      host.input.value = rest;
    }
    renderSuggestions();
    host.onChange();
  });
  host.input.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[,\n\r]/u.test(text)) return;
    event.preventDefault();
    const parts = `${host.input.value}${text}`.split(/[,\n\r]+/u);
    const rest = parts.pop() ?? '';
    commitMany(parts);
    host.input.value = rest;
    renderSuggestions();
  });

  const api: TagInput = {
    tags: () => chips.map((chip) => chip.tag),
    aiTags: () => chips.filter((chip) => chip.origin === 'ai').map((chip) => chip.tag),
    setTags(tags, origin = 'user') {
      chips.length = 0;
      // Saved cloud members may contain commas or differ only by case; do not rewrite them on display.
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.length > 0
          && !chips.some(chip => chip.tag === tag)) chips.push({ tag, origin });
      }
      render();
    },
    add(tag, origin = 'user') {
      const added = commit(tag, origin);
      host.input.value = '';
      render();
      if (added) host.onChange();
      return added;
    },
    remove(tag) {
      const at = chips.findIndex((chip) => chip.tag === tag);
      if (at < 0) return;
      chips.splice(at, 1);
      render();
      host.onChange();
    },
    pending: () => host.input.value.trim(),
    commitPending() { if (host.input.value.trim()) commitMany([host.input.value]); },
    setExisting(counts) { existing = counts; renderSuggestions(); },
    setAiSuggestions(tags) { ai = normalizeAnnotationTags(tags); renderSuggestions(); },
    focus: () => { host.input.focus(); },
  };
  render();
  return api;
}
