import { vi } from 'vitest';
import { createPopupNote } from '../../src/popup-note.js';
import { createTagInput } from '../../src/popup-tags.js';
import { byId, mountPopupShell } from './popup-shell.js';

/**
 * The shell pieces the suggestion lane writes to: the chip beside the folder
 * pill, the note line and the tag field. `press` delivers a click the way a
 * trusted user gesture would (the binding ignores synthetic clicks).
 */
export function mountSuggestShell(mode = 'manual') {
  mountPopupShell({ mode });
  const chip = byId<HTMLButtonElement>('folder-suggest');
  let listener: ((event: { isTrusted: boolean }) => unknown) | undefined;
  const original = chip.addEventListener.bind(chip);
  vi.spyOn(chip, 'addEventListener').mockImplementation((type: string, handler: unknown, options?: unknown) => {
    if (type === 'click') listener = handler as typeof listener;
    original(type, handler as EventListener, options as boolean);
  });
  const line = byId('pp-note');
  const note = createPopupNote(line);
  const tags = createTagInput({ field: byId('tag-field'), input: byId<HTMLInputElement>('tag-text'), suggest: byId('tag-suggest'), onChange: () => undefined });
  return {
    chip, label: byId('folder-suggest-label'), line, note, tags,
    press: async () => { await listener!({ isTrusted: true }); },
  };
}
