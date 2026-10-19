// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AutomationMatchView } from '../src/automation/messages.js';
import { bindPopupRule } from '../src/popup-rule.js';
import { task as base } from './fixtures/capture.js';

/** The manual popup previews a rule's folder before Save; the user's own pick always wins (AU-07). */
let chosen: string, explicit: boolean, match: AutomationMatchView | null;
const sent: unknown[] = [];
const folders = { chosenFolderId: () => chosen, explicit: () => explicit, userPicked: () => explicit,
  adopt: vi.fn(async (id: string) => { chosen = id; }), close: vi.fn() };
const fields = { setRulePick: vi.fn() };
const onChange = vi.fn();

beforeEach(() => {
  chosen = '21'; explicit = false; sent.length = 0; folders.adopt.mockClear(); folders.close.mockClear(); fields.setRulePick.mockClear(); onChange.mockClear();
  match = { outcome: 'placed', ruleName: 'arXiv papers', sourceName: null, ruleCount: 1, folderNativeId: '10', folderTitle: 'Academic' };
  document.body.dataset.captureMode = 'manual'; delete document.body.dataset.existing;
  vi.stubGlobal('chrome', { runtime: { sendMessage: async (message: unknown) => { sent.push(message); return { ok: true, match }; } } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const bind = () => bindPopupRule({ folders: folders as never, fields: fields as never, onChange,
  page: () => ({ url: 'https://arxiv.org/abs/1', title: 'A paper' }) });

test('a matching rule shows its folder, and Save sends the folder it replaces for the worker to decide again', async () => {
  const rule = bind();
  await rule.refresh();
  expect(sent).toEqual([{ kind: 'known.automation.match', url: 'https://arxiv.org/abs/1', title: 'A paper', parentNativeId: '21' }]);
  expect(chosen).toBe('10');
  expect(fields.setRulePick).toHaveBeenLastCalledWith('arXiv papers');
  expect(rule.decides()).toBe(true);
  expect(rule.target('10')).toEqual({ parentNativeId: '21', folderChoice: 'default' });
  // Asking again (the URL changed) still asks about the folder without the rule.
  await rule.refresh();
  expect(sent[1]).toMatchObject({ parentNativeId: '21' });
});

test('picking a folder makes it the user’s: no rule mark, and Save says it was chosen', async () => {
  const rule = bind();
  await rule.refresh();
  chosen = '30'; explicit = true; rule.picked();
  expect(fields.setRulePick).toHaveBeenLastCalledWith(null);
  expect(rule.decides()).toBe(false);
  expect(rule.target('30')).toEqual({ parentNativeId: '30', folderChoice: 'explicit' });
  // An explicit folder is never replaced by a preview.
  await rule.refresh();
  expect(chosen).toBe('30');
});

test('no placement, an existing bookmark or the automatic popup leave the folder alone', async () => {
  match = { outcome: 'blocked', ruleName: 'arXiv papers', sourceName: null, ruleCount: 1, folderNativeId: null, folderTitle: null };
  await bind().refresh();
  expect(chosen).toBe('21');
  expect(fields.setRulePick).toHaveBeenLastCalledWith(null);
  match = { outcome: 'placed', ruleName: 'arXiv papers', sourceName: null, ruleCount: 1, folderNativeId: '10', folderTitle: 'Academic' };
  document.body.dataset.existing = 'edit';
  await bind().refresh();
  document.body.dataset.existing = ''; document.body.dataset.captureMode = 'automatic';
  await bind().refresh();
  expect(sent).toHaveLength(1);
  expect(chosen).toBe('21');
});

test('after the save the pill and mark follow where the worker put the bookmark', async () => {
  const rule = bind();
  await rule.refresh();
  // The rule's folder could not take the save after all: the bookmark went to the default folder.
  await rule.saved({ ...base, disposition: 'new', targetNativeId: '21',
    automation: { outcome: 'blocked', reason: 'bindingUnavailable', ruleIds: ['r'], bundleRevision: '1', settingsRevision: 1, satisfies: [],
      rule: { id: 'r', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'd' }, fromNativeId: '21',
      collectionId: 'c', replicaId: 'r', generation: 1 } });
  expect(chosen).toBe('21');
  expect(fields.setRulePick).toHaveBeenLastCalledWith(null);
});

test('with no folder chosen yet, a rule still shows where it files the page, and Save sends no folder of its own', async () => {
  chosen = '';
  const rule = bind();
  await rule.refresh();
  expect(sent).toEqual([{ kind: 'known.automation.match', url: 'https://arxiv.org/abs/1', title: 'A paper', parentNativeId: '' }]);
  expect(chosen).toBe('10');
  expect(rule.decides()).toBe(true);
  expect(rule.target('10')).toEqual({ parentNativeId: '', folderChoice: 'default' });
  // The picker that opened for want of a folder closes: the rule chose one.
  expect(folders.close).toHaveBeenCalledOnce();
  // The rule stops matching (the URL changed): the pill asks for a folder again.
  match = null;
  await rule.refresh();
  expect(folders.adopt).toHaveBeenLastCalledWith('');
  expect(rule.decides()).toBe(false);
});
