// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { createPopupNote } from '../src/popup-note.js';

function mount() {
  const host = document.createElement('p'); host.hidden = true;
  return { host, note: createPopupNote(host) };
}

test('the line is hidden until a source has something to say', () => {
  const { host, note } = mount();
  expect(host.hidden).toBe(true);
  note.set('cost', 'Uses 1 credit');
  expect(host.hidden).toBe(false);
  expect(host.textContent).toBe('Uses 1 credit');
  note.set('cost', undefined);
  expect(host.hidden).toBe(true);
  expect(host.textContent).toBe('');
});

test('only one source shows: the first in priority order', () => {
  const { host, note } = mount();
  note.set('cost', 'cost');
  note.set('dest', 'dest');
  expect(note.current()).toBe('dest');
  note.set('classify', 'classify');
  expect(note.current()).toBe('classify');
  note.set('classify', '');
  expect(host.textContent).toBe('dest');
});

test('an error wins over any other source and carries its tone', () => {
  const { host, note } = mount();
  note.set('feedback', 'saved', '');
  note.set('cost', 'broke', 'error');
  expect(note.current()).toBe('cost');
  expect(host.dataset.tone).toBe('error');
  note.set('cost', undefined);
  expect(host.textContent).toBe('saved');
  expect(host.dataset.tone).toBeUndefined();
});

test('a node is placed as given', () => {
  const { host, note } = mount();
  const link = document.createElement('button'); link.textContent = 'Sync this folder';
  note.set('dest', link);
  expect(host.querySelector('button')).toBe(link);
});
