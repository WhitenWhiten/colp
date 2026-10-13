// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTagInput, type TagInput } from '../src/popup-tags.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

let onChange: ReturnType<typeof vi.fn<() => void>>;
let tags: TagInput;
const input = () => byId<HTMLInputElement>('tag-text');
const chips = () => Array.from(byId('tag-field').querySelectorAll<HTMLElement>('.chip')).map((chip) => chip.dataset.tag);
const suggestions = () => Array.from(byId('tag-suggest').querySelectorAll<HTMLElement>('.chip--suggest')).map((chip) => chip.title);
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  return event;
}
function type(value: string): void { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })); }

beforeEach(() => {
  mountPopupShell();
  onChange = vi.fn();
  tags = createTagInput({ field: byId('tag-field'), input: input(), suggest: byId('tag-suggest'), onChange });
});
afterEach(() => { document.body.replaceChildren(); });

test('Enter, comma and Tab each commit the typed text as a chip', () => {
  type('alpha'); expect(press('Enter').defaultPrevented).toBe(true);
  type('beta'); press(',');
  type('gamma'); press('Tab');
  expect(tags.tags()).toEqual(['alpha', 'beta', 'gamma']);
  expect(chips()).toEqual(['alpha', 'beta', 'gamma']);
  expect(input().value).toBe('');
});

test('Tab with nothing typed, and Shift+Tab, keep moving focus', () => {
  expect(press('Tab').defaultPrevented).toBe(false);
  type('word');
  expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  expect(tags.tags()).toEqual([]);
  expect(tags.pending()).toBe('word');
});

test('Backspace on an empty input removes the last chip, but never while text is typed', () => {
  tags.setTags(['one', 'two']);
  type('x'); press('Backspace');
  expect(tags.tags()).toEqual(['one', 'two']);
  type(''); press('Backspace');
  expect(tags.tags()).toEqual(['one']);
});

test('a comma inside the text splits it into two tags, like the store does', () => {
  type('red, blue,green');
  expect(tags.tags()).toEqual(['red', 'blue']);
  expect(input().value).toBe('green');
  tags.commitPending();
  expect(tags.tags()).toEqual(['red', 'blue', 'green']);
});

test('pasting a list splits it into chips and leaves the last fragment pending', () => {
  const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  paste.clipboardData = { getData: () => 'a, b, c' };
  input().dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  expect(tags.tags()).toEqual(['a', 'b']);
  expect(input().value).toBe(' c');
});

test('duplicates are ignored regardless of case', () => {
  type('News'); press('Enter');
  type('news'); press('Enter');
  expect(tags.tags()).toEqual(['News']);
  expect(onChange).toHaveBeenCalled();
});

test('each chip has a remove button labelled with its tag', () => {
  tags.setTags(['alpha', 'beta']);
  const button = byId('tag-field').querySelector<HTMLButtonElement>('.chip[data-tag="alpha"] .chip-remove')!;
  expect(button.getAttribute('aria-label')).toBe('Remove tag alpha');
  button.click();
  expect(tags.tags()).toEqual(['beta']);
});

test('up to five matching existing tags are offered while typing, best prefix first, and a click adds one', () => {
  tags.setExisting(['rust', 'trust', 'crust', 'frustum', 'thrust', 'ruts', 'unrelated', 'rustic'].map((tag, index) => ({ tag, count: 9 - index })));
  expect(suggestions()).toEqual([]);
  type('rus');
  expect(suggestions()).toHaveLength(5);
  expect(suggestions()).not.toContain('unrelated');
  expect(suggestions()[0]).toMatch(/^rus/u);
  byId('tag-suggest').querySelector<HTMLButtonElement>('.chip--suggest')!.click();
  expect(tags.tags()).toHaveLength(1);
  expect(input().value).toBe('');
});

test('tags already on the bookmark and an exact match are not suggested again', () => {
  tags.setExisting([{ tag: 'rust', count: 3 }, { tag: 'rusty', count: 2 }]);
  tags.setTags(['rusty']);
  type('rust');
  expect(suggestions()).toEqual([]);
});

test('AI suggestions are chips that become AI-origin tags once accepted', () => {
  tags.setAiSuggestions(['ai-one', 'ai-two']);
  expect(suggestions()).toEqual(['ai-one', 'ai-two']);
  expect(byId('tag-suggest').hidden).toBe(false);
  byId('tag-suggest').querySelector<HTMLButtonElement>('[data-suggest="ai"]')!.click();
  expect(tags.tags()).toEqual(['ai-one']);
  expect(tags.aiTags()).toEqual(['ai-one']);
  expect(suggestions()).toEqual(['ai-two']);
  tags.remove('ai-one');
  expect(suggestions()).toEqual(['ai-one', 'ai-two']);
});

test('chips are capped at the store limit and the placeholder returns when empty', () => {
  const placeholder = input().placeholder;
  expect(placeholder).not.toBe('');
  tags.setTags(['x']);
  expect(input().placeholder).toBe('');
  tags.setTags([]);
  expect(input().placeholder).toBe(placeholder);
  for (const tag of Array.from({ length: 100 }, (_, index) => `t${index}`)) tags.add(tag);
  expect(tags.tags().length).toBe(64);
});

test('saved cloud tag members are displayed and removed without rewriting case or commas', () => {
  tags.setTags(['News', 'news', 'a,b']);
  expect(tags.tags()).toEqual(['News', 'news', 'a,b']);
  tags.remove('news'); expect(tags.tags()).toEqual(['News', 'a,b']);
});

test('overflow and legacy tags stay visible so editing another field cannot implicitly remove them', () => {
  const members = [...Array.from({ length: 80 }, (_, i) => `tag-${i}`), '😀'.repeat(48)];
  tags.setTags(members);
  expect(tags.tags()).toEqual(members);
  expect(chips()).toEqual(members);
});

test('picking an existing canonical tag preserves its complete label', () => {
  tags.setExisting([{ tag: '#topic,section', count: 2 }]);
  type('topic');
  byId('tag-suggest').querySelector<HTMLButtonElement>('.chip--suggest')!.click();
  expect(tags.tags()).toEqual(['#topic,section']);
});
