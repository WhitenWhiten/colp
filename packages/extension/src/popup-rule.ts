import type { AutomationMatchView } from './automation/messages.js';
import type { CaptureTask } from './capture/contracts.js';
import type { PopupFields } from './popup-fields.js';
import type { bindSaveFolderPicker } from './save-folder-ui.js';

type FolderPicker = ReturnType<typeof bindSaveFolderPicker>;
export interface PopupRuleTarget { readonly parentNativeId: string | undefined; readonly folderChoice: 'explicit' | 'default' }

/**
 * The manual popup's view of the account's rules. When the page matches a rule,
 * the folder pill shows the rule's folder before Save, marked "By rule", and the
 * save goes there. Picking another folder makes it the user's own choice, which
 * no rule overrides. This is a preview: the worker decides again when it saves,
 * from the folder the save would use without the rule.
 */
export function bindPopupRule(host: {
  readonly folders: FolderPicker;
  readonly fields: PopupFields;
  readonly page: () => { readonly url: string; readonly title: string } | null;
  /** The rule started or stopped choosing the folder. */
  readonly onChange: () => void;
}) {
  /** `base`: the folder without the rule. `shown`: the rule's folder now on the pill. */
  let base = '', shown = '', turn = 0;
  const decides = () => shown !== '' && host.folders.chosenFolderId() === shown && !host.folders.explicit();
  /** Only a new bookmark is placed: the popup editing one that exists shows where it already lives. */
  const newSave = () => document.body.dataset.captureMode !== 'automatic'
    && document.body.dataset.existing !== 'edit' && document.body.dataset.existing !== 'view';
  function clear(): void {
    const had = shown !== '';
    shown = ''; host.fields.setRulePick(null);
    if (had) host.onChange();
  }
  document.addEventListener('known:existence-shown', () => {
    turn++;
    if (decides()) void host.folders.adopt(base);
    clear();
  });

  return {
    decides,
    /** Asks the worker what a rule would do with this page; shows its folder when it would place it. */
    async refresh(): Promise<void> {
      const mine = ++turn, page = host.page();
      const parent = decides() ? base : host.folders.chosenFolderId();
      if (!page || !parent || host.folders.explicit() || !newSave()) { clear(); return; }
      const reply = await chrome.runtime.sendMessage({ kind: 'known.automation.match', url: page.url, title: page.title, parentNativeId: parent })
        .catch(() => null) as { ok?: boolean; match?: AutomationMatchView | null } | null;
      if (mine !== turn || host.folders.explicit() || !newSave()) return;
      const match = reply?.ok ? reply.match ?? null : null;
      if (match?.outcome !== 'placed' || !match.folderNativeId) { if (decides()) await host.folders.adopt(base); clear(); return; }
      base = parent; shown = match.folderNativeId;
      if (host.folders.chosenFolderId() !== shown) await host.folders.adopt(shown);
      // A rule from a set or a subscription is named with it: "Community › GitHub".
      host.fields.setRulePick(match.sourceName ? `${match.sourceName} › ${match.ruleName}` : match.ruleName);
      host.onChange();
    },
    /** The user picked a folder: it is theirs now. */
    picked(): void { clear(); },
    /** What Save sends: the folder the save uses without the rule, and whether the user chose it. */
    target(chosen: string | undefined): PopupRuleTarget {
      if (decides()) return { parentNativeId: base, folderChoice: 'default' };
      return { parentNativeId: chosen, folderChoice: host.folders.explicit() ? 'explicit' : 'default' };
    },
    /** After the save: the pill shows where the bookmark went, and the mark says whether a rule put it there. */
    async saved(task: CaptureTask): Promise<void> {
      turn++;
      if (task.disposition === 'new' && task.targetNativeId && task.targetNativeId !== host.folders.chosenFolderId()) {
        await host.folders.adopt(task.targetNativeId);
      }
      const placed = task.disposition === 'new' && task.automation?.outcome === 'placed';
      shown = placed ? task.targetNativeId : '';
      const automation = placed ? task.automation! : null;
      host.fields.setRulePick(automation ? automation.source === 'browser' && automation.sourceName
        ? `${automation.sourceName} › ${automation.rule.name}` : automation.rule.name : null);
    },
  };
}
