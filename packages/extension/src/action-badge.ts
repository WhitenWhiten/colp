import type { ToolbarBadge } from './automation/digest-indicator.js';

/**
 * The toolbar badge has two owners. A save problem ("!", save-feedback.ts)
 * always wins; otherwise the badge shows the server's unread automation
 * results (automation/digest-indicator.ts). The worker keeps the automation
 * badge here, so whoever clears a save problem hands the badge back to it
 * instead of blanking it.
 */
export const AUTOMATION_BADGE_KEY = 'known.automation.badge.v1';

function parse(value: unknown): ToolbarBadge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const badge = value as Record<string, unknown>;
  return typeof badge.text === 'string' && badge.text.length <= 4 && typeof badge.color === 'string' && typeof badge.title === 'string'
    ? { text: badge.text, color: badge.color, title: badge.title } : null;
}

export async function readAutomationBadge(): Promise<ToolbarBadge | null> {
  try { return parse((await chrome.storage.local.get(AUTOMATION_BADGE_KEY))[AUTOMATION_BADGE_KEY]); } catch { return null; }
}

/** Stores the automation badge; true when it changed. */
export async function writeAutomationBadge(badge: ToolbarBadge | null): Promise<boolean> {
  const before = await readAutomationBadge();
  if (JSON.stringify(before) === JSON.stringify(badge)) return false;
  if (badge) await chrome.storage.local.set({ [AUTOMATION_BADGE_KEY]: badge });
  else await chrome.storage.local.remove(AUTOMATION_BADGE_KEY);
  return true;
}

/**
 * Puts the automation badge (or none) on the toolbar. The caller has checked
 * that no save problem holds the badge. With `title`, the tooltip follows too,
 * back to the button's own when there is nothing new.
 */
export async function showAutomationBadge(options: { readonly title: boolean }): Promise<void> {
  const badge = await readAutomationBadge();
  try {
    await chrome.action.setBadgeText({ text: badge?.text ?? '' });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    // The button's own tooltip is the manifest's, as Chrome resolves it.
    const manifestTitle = () => (chrome as { i18n?: { getMessage(key: string): string } }).i18n?.getMessage('actionTitle') || 'Know-N';
    if (options.title) await chrome.action.setTitle({ title: badge?.title ?? manifestTitle() });
  } catch { /* The badge is a hint; the popup and Options say the same. */ }
}
