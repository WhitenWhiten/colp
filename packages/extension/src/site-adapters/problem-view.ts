import { t } from '../i18n.js';
import { problemFamily, type SiteActivity } from './activity.js';

/** Source-neutral copy. Actions are still gated by host capabilities and the actual outcome of the operation. */
export function siteProblem(code: string, site: string, event?: SiteActivity | null) {
  const family = event?.family ?? problemFamily(code);
  const what = code === 'sourceReviewRequired' ? t('sites_problemReviewItems', 'Some items need your review before they can be saved. Confirmed bookmarks are kept.')
    : code === 'folderCreateFailed' ? t('sites_problemCreateFolder', 'The local folder could not be created. Choose an existing folder or try again.')
    : family === 'connection' ? t('sites_problemConnection', 'The website connection is unavailable. Reading cannot continue yet.')
    : family === 'permission' ? t('sites_problemPermission', 'Bookmark or website access is missing. Saved bookmarks are kept.')
    : family === 'rate' ? t('sites_problemRate', '$1 is limiting requests. Items already read and saved are kept.', site)
    : family === 'network' ? t('sites_problemNetwork', 'The connection did not finish. Confirmed bookmarks are kept; unfinished work is still pending.')
    : family === 'destination' ? t('sites_problemDestination', 'The save location or its association has changed. Check it before saving more items.')
    : family === 'changed' ? t('sites_problemChanged', 'The source or settings changed during this check. Check again before applying the remaining changes.')
    : family === 'unconfirmed' ? t('sites_problemUnconfirmed', 'Some save results could not be confirmed. Check the original operations before creating another copy.')
    : family === 'unsupported' ? t('sites_problemUnsupported', 'This operation is unavailable with the current adapter, browser or stored data version.')
    : family === 'source' ? t('sites_problemSourceData', 'The website returned content this adapter could not read. Confirmed bookmarks are kept.')
    : family === 'storage' ? t('sites_problemStorage', 'Local records for this source could not be read. Bookmarks already saved in the browser are kept.')
    : family === 'capacity' ? t('sites_problemCapacity', 'This operation reached a size or item limit. Work already saved is kept.')
    : family === 'configuration' ? t('sites_problemConfiguration', 'Saving is blocked by the current automation or AI settings. Existing bookmarks are kept.')
    : t('sites_problemUnknown', 'This operation could not finish, and the cause is not yet classified. Its diagnostic details can be copied for investigation.');
  const next = code === 'sourceReviewRequired' ? t('sites_problemReviewNext', 'Open Review items below to see which results need a decision.')
    : family === 'connection' ? t('sites_problemOpen', 'Open $1 and check its connection to continue.', site)
    : family === 'permission' ? t('sites_problemAllow', 'Open sync settings and allow the missing access.')
    : family === 'rate' ? t('sites_problemWait', 'Wait a few minutes before continuing. Unavailable source items are skipped separately.')
    : family === 'unconfirmed' ? t('sites_problemInspect', 'Use the operation records to check the save result.')
    : family === 'destination' ? t('sites_problemLocation', 'Check the save location in sync settings. Existing bookmarks will stay where they are.')
    : family === 'changed' ? t('sites_problemRecheck', 'Run a new check to review the current changes.')
    : family === 'capacity' ? t('sites_problemReduceScope', 'Select fewer collections or a smaller source list, then check again.')
    : family === 'configuration' ? t('sites_problemCheckSettings', 'Review the automation or AI settings before continuing this operation.')
    : family === 'network' ? event?.automatic ? t('sites_problemAutomatic', 'The background task has scheduled another attempt; no action is needed now.')
      : t('sites_problemRetryConnection', 'Check the connection, then continue the check or retry the original operation.')
    : family === 'storage' ? t('sites_problemStorageNext', 'Try refreshing. If the problem continues, copy the report so this failure can be investigated.')
    : t('sites_problemDetails', 'Review the operation details or copy the problem report.');
  return { family, what, next };
}
