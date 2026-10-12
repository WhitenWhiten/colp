import type { HubPane } from './options-tabs.js';

/**
 * Preferences used to be one long page. Its sections now live on their own
 * pages; this table is where each old `#preferences?section=…` link lands
 * (docs/ui-design.md, "Options").
 */
export const PREFERENCE_SECTIONS = {
  capture: 'saving', bookmarks: 'saving',
  classification: 'ai', 'local-classification': 'ai',
  subscriptions: 'subscriptions', directories: 'subscriptions',
  language: 'general', permissions: 'general',
} as const satisfies Readonly<Record<string, HubPane>>;
export type PreferenceSection = keyof typeof PREFERENCE_SECTIONS;

/** The page a preference section lives on, as a hash. */
export function preferenceHash(section: PreferenceSection): string { return `#${PREFERENCE_SECTIONS[section]}`; }
