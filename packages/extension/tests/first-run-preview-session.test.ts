import { expect, test } from 'vitest';
import { createFirstRunPreviewSession } from '../src/first-run-preview-session.js';
import type { FirstRunPreviewOk } from '../src/types.js';
const preview: FirstRunPreviewOk = { ok: true, previewId: 'preview', boundaryVersion: 'v1', treeDigest: 'tree',
  bookmarkCount: 1, folderCount: 1, skippedCount: 0, warnings: [] };

test('a changed selection, library or mode cannot accept an old preview or confirm it', () => {
  const session = createFirstRunPreviewSession();
  const stale = session.read('old-selection')!;
  const latest = session.read('new-selection')!;
  expect(session.accept(stale, preview, 'old-selection')).toBe(false);
  expect(session.accept(latest, preview, 'new-selection')).toBe(true);
  expect(session.confirm('different-library-or-mode')).toBeUndefined();
  session.invalidate();
  expect(session.preview).toBeUndefined(); expect(session.confirm('new-selection')).toBeUndefined();
  expect(session.accept(latest, preview, 'new-selection')).toBe(false);
});
test('submitting is exclusive, retries retain the reviewed command, and a new preview gets a new command', () => {
  let count = 0; const session = createFirstRunPreviewSession(() => `command-${++count}`);
  const ticket = session.read('selection')!; session.accept(ticket, preview, 'selection');
  expect(session.confirm('selection')).toEqual({ preview, commandId: 'command-1' });
  expect(session.phase).toBe('confirming'); expect(session.read('selection')).toBeUndefined(); expect(session.confirm('selection')).toBeUndefined();
  expect(session.finish('wrong-command')).toBe(false); expect(session.finish('command-1')).toBe(true);
  expect(session.confirm('selection')?.commandId).toBe('command-1');
  session.invalidate(); expect(session.finish('command-1')).toBe(false);
  const next = session.read('selection')!; session.accept(next, preview, 'selection');
  expect(session.confirm('selection')?.commandId).toBe('command-2');
});
test('refreshing discards an old deletion plan and the confirmation key together', () => {
  const session = createFirstRunPreviewSession();
  const ticket = session.read('selection')!; session.accept(ticket, preview, 'selection');
  expect(session.preview).toBe(preview);
  const refresh = session.read('selection')!;
  expect(session.preview).toBeUndefined(); expect(session.confirm('selection')).toBeUndefined();
  expect(session.current(ticket, 'selection')).toBe(false); expect(session.current(refresh, 'selection')).toBe(true);
});
