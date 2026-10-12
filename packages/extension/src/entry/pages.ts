import { initI18n } from '../i18n.js';

/**
 * The page bundles start here rather than at the page module. A page reads
 * its copy while it loads — module-level labels, controls painted as they are
 * bound — so the pinned UI language has to be in place before the page module
 * evaluates; a static import would run it first.
 */
export async function loadWhenLanguageReady(load: () => Promise<unknown>): Promise<void> {
  await initI18n();
  await load();
}
