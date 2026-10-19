import type { Annotation } from './popup-annotations.js';
import { t } from './i18n.js';

export function annotationSyncHint(annotation: Annotation): string {
  if (annotation.syncProblem === 'note-conflict') return t('metadata_noteConflict', 'Your draft is saved in this browser. Save to review both versions and choose which note to keep.');
  if (annotation.syncProblem === 'note-unsupported') return t('metadata_noteUnsupported', 'Your note is saved in this browser. Review the note in your library on the web; its format or size cannot be synced here.');
  if (annotation.syncProblem === 'tags-incompatible') return t('metadata_tagsIncompatible', 'All tags are saved in this browser. Tag sync supports up to 64 tags of 64 characters each; review the tags to resume syncing.');
  return '';
}
