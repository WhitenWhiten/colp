import type { HubRoute } from './options-router.js';

/** Deep links into Bookmarks: `#bookmarks?section=import` opens the Import dialog, `section=backup` the Export dialog. */
export const BOOKMARK_SECTIONS = { import: 'local-import', backup: 'local-backup' } as const;
/** Fired on `document`; the dialog binders in local-import/view.ts and local-backup/view.ts listen for it. */
export const OPEN_LIBRARY_DIALOG = 'known:open-library-dialog';
export function bookmarkSectionHash(section: keyof typeof BOOKMARK_SECTIONS): string { return `#bookmarks?section=${section}`; }
export function revealBookmarkSection(route: HubRoute): void {
  if (route.pane !== 'bookmarks') return;
  const section = route.params.get('section');
  if (!section || !Object.hasOwn(BOOKMARK_SECTIONS, section) || document.querySelector('dialog[open].mgr-transfer')) return;
  document.dispatchEvent(new CustomEvent(OPEN_LIBRARY_DIALOG, { detail: section === 'backup' ? 'export' : 'import' }));
}
