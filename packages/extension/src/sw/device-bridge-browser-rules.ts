import type { BrowserRequest } from '../automation/device-bridge.js';
import { deviceResultPage } from '../automation/device-bridge-result.js';
import { record } from '../automation/closed-value.js';
import { validBrowserRuleCommand, type BrowserRuleCommand } from '../automation/messages.js';
import { entryId, type LocalRule } from '../automation/rule-list-store.js';
import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { browserRuleStore, handleBrowserRuleCommand } from './automation-browser.js';
import { browserRunViews, handleRunCommand } from './automation-run.js';
import { hasBookmarkPermission } from './runtime.js';
import { sourceDigest } from '../site-adapters/source-db.js';

function page<T extends { id: string }>(request: BrowserRequest, rows: T[], base: Record<string, unknown>, revision: string) {
  let start = 0;
  if (request.input.cursor) {
    let cursor: unknown; try { cursor = JSON.parse(request.input.cursor); } catch { throw Error('invalid_cursor'); }
    if (!record(cursor) || cursor.revision !== revision || !Number.isSafeInteger(cursor.index) || Number(cursor.index) < 0
      || Number(cursor.index) >= rows.length) throw Error('invalid_cursor');
    start = Number(cursor.index) + 1;
  }
  return deviceResultPage(request.id, rows.slice(start), base, {
    cursorFor: item => JSON.stringify({ revision, index: rows.indexOf(item) }),
  });
}

async function writableFolder(id: string) {
  const folder = (await chrome.bookmarks.get(id))[0];
  if (!folder || folder.url !== undefined || folder.unmodifiable) throw Error('bookmark_folder_unavailable');
  await assertBookmarkFolderAllowed(id);
  if (await isSubscriptionExcluded(id)) throw Error('excluded');
}

function configurationCommand(change: Record<string, unknown>): unknown {
  switch (change.operation) {
    case 'save': return { kind: 'known.automation.browser.save', draft: change.draft,
      ...(change.ruleId ? { id: change.ruleId } : {}), ...(change.enabled === undefined ? {} : { enabled: change.enabled }) };
    case 'remove': return { kind: 'known.automation.browser.remove', id: change.ruleId };
    case 'reorder': return { kind: 'known.automation.browser.reorder', order: change.order };
    case 'enable': return { kind: 'known.automation.browser.enable', id: change.ruleId, enabled: change.enabled };
    case 'list_enable': return { kind: 'known.automation.browser.list.enable', enabled: change.enabled };
    default: throw Error('browser_rule_operation_invalid');
  }
}

/** Uses the browser's existing rules and run journal. Remote writes share the
 * UI's store lane; revision and live device authority are checked in that lane. */
export async function handleBrowserRulesBridge(request: BrowserRequest, authorize: () => Promise<void>): Promise<unknown> {
  await authorize();
  if (!await hasBookmarkPermission()) throw Error('permission_required');
  const store = browserRuleStore();
  if (request.operation === 'browser_rules.list') {
    const list = await store.load();
    const rows: Array<{ id: string; kind: string; position: number; parentId: string | null; enabled: boolean;
      name?: string; draft?: Pick<LocalRule, 'name' | 'combinator' | 'conditions' | 'action'> }> = [];
    const addRule = (rule: LocalRule, position: number, parentId: string | null) => rows.push({ id: rule.id, kind: 'rule',
      position, parentId, enabled: rule.enabled, draft: { name: rule.name, combinator: rule.combinator, conditions: rule.conditions, action: rule.action } });
    list.entries.forEach((entry, position) => {
      if (entry.kind === 'rule') addRule(entry.rule, position, null);
      else if (entry.kind === 'set') {
        rows.push({ id: entry.set.id, kind: 'set', position, parentId: null, name: entry.set.name, enabled: entry.set.enabled });
        entry.set.rules.forEach((rule, index) => addRule(rule, index, entry.set.id));
      } else rows.push({ id: entryId(entry), kind: 'subscription', position, parentId: null, enabled: entry.enabled });
    });
    return page(request, rows, { revision: list.revision, enabled: list.enabled }, String(list.revision));
  }
  if (request.operation === 'browser_rules.folders') {
    const parentId = request.input.parentNativeId ?? '0';
    if (parentId !== '0') await writableFolder(parentId);
    const folders = [];
    for (const node of await chrome.bookmarks.getChildren(parentId)) {
      if (node.url !== undefined || node.unmodifiable) continue;
      try { await writableFolder(node.id); } catch { continue; }
      folders.push({ id: node.id, title: node.title, parentId });
    }
    return page(request, folders, { parentNativeId: parentId }, sourceDigest(folders));
  }
  if (request.operation === 'browser_rules.configure') {
    if (!record(request.input.request) || !Number.isSafeInteger(request.input.baseRevision)) throw Error('browser_rule_input_invalid');
    const command = configurationCommand(request.input.request);
    if (!validBrowserRuleCommand(command)) throw Error('browser_rule_input_invalid');
    const result = await handleBrowserRuleCommand(command as Parameters<typeof handleBrowserRuleCommand>[0], undefined, async list => {
      await authorize();
      if (list.revision !== request.input.baseRevision) throw Error('browser_rules_changed');
      if (command.kind === 'known.automation.browser.save' && command.draft.action.kind === 'file'
        && 'folderNativeId' in command.draft.action) await writableFolder(command.draft.action.folderNativeId);
    });
    // Return the operation's result. A later list read supplies the next
    // revision together with its matching data, including concurrent UI edits.
    return result;
  }
  if (request.operation === 'browser_rules.preview') {
    const bookmark = request.input.bookmark;
    if (!bookmark) throw Error('browser_rule_input_invalid');
    const command: BrowserRuleCommand = { kind: 'known.automation.browser.preview', ...bookmark };
    if (!validBrowserRuleCommand(command)) throw Error('browser_rule_input_invalid');
    return handleBrowserRuleCommand(command);
  }
  if (request.operation === 'browser_rules.runs') {
    const runs = (await browserRunViews()).map(run => ({ ...run, id: run.runId }));
    return page(request, runs, {}, sourceDigest(runs));
  }
  if (request.operation === 'browser_rules.run_preview' && request.input.scopeNativeId)
    return handleRunCommand({ kind: 'known.automation.browser.runPreview', scopeNativeId: request.input.scopeNativeId }, authorize);
  if (request.operation === 'browser_rules.run_apply' && request.input.previewId)
    return handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: request.input.previewId }, authorize);
  if (request.operation === 'browser_rules.run_undo' && request.input.runId)
    return handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: request.input.runId }, authorize);
  throw Error('device_operation_unsupported');
}
