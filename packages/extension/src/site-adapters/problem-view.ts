import { t } from '../i18n.js';
import { problemFamily, type SiteActivity } from './activity.js';
import { importScopeProblems } from './import-problems.js';

/** Source-neutral copy. Actions are still gated by host capabilities and the actual outcome of the operation. */
export function siteProblem(code: string, site: string, event?: SiteActivity | null): { family: ReturnType<typeof problemFamily>; what: string; next: string } {
  if (code === 'sourceReviewRequired' && event?.review?.length) {
    const reason = event.review[0]!.code;
    if (importScopeProblems.has(reason) && event.review.every(sample => sample.code === reason)) return siteProblem(reason, site);
  }
  const family = event?.family ?? problemFamily(code);
  const what = code === 'sourceDestinationNeedsReview' ? t('sites_problemUnboundLocation', 'This mapping is not connected to the current save location, so importing is blocked.')
    : code === 'sourceSyncUpgradeRequired' ? t('sites_syncEffectsUpgrade', 'The sync server needs an update before website imports can be saved reliably. Your approved import is kept.')
    : code === 'previewStale' ? t('sites_problemPreviewOutdated', 'The save plan no longer matches the current import state and cannot be applied yet.')
    : code === 'sourceAuthorizationChanged' ? t('sites_problemAuthorizationChanged', 'The source account or its access changed, so this check paused.')
    : code === 'sourceAccountChanged' ? t('sites_problemAccountChanged', 'The connected $1 account is different from the account used by this check.', site)
    : code === 'restartRequired' || code === 'navigationChanged' ? t('sites_problemPageChanged', 'The website page changed while source items were being read.')
    : code === 'pageUnavailable' ? t('sites_problemNoReadableTab', 'No readable $1 tab is connected to the extension.', site)
    : code === 'signedOut' ? t('sites_signedOut', 'You’re signed out of $1. Sign in there, then try again.', site)
    : code === 'sourceUnresolved' ? t('sites_problemUnconfirmedAccount', 'The website account needs to be confirmed in sync settings.')
    : code === 'sourceReviewRequired' ? t('sites_problemReviewItems', 'Some items need your review before they can be saved. Confirmed bookmarks are kept.')
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
  const next = code === 'sourceDestinationNeedsReview' ? t('sites_problemPrepareLocation', 'Choose Prepare import again to reconnect an unused mapping. If it remains blocked, confirm the save location in sync settings. Items already read are kept.')
    : code === 'sourceSyncUpgradeRequired' ? t('sites_syncEffectsUpgradeNext', 'Update COLP Server, then choose Check and continue saving to resume this import.')
    : code === 'previewStale' ? t('sites_problemPreparePreview', 'Prepare the import again using the items already read, then confirm the updated list.')
    : code === 'sourceAuthorizationChanged' ? t('sites_problemVerifyConnection', 'Continue checking to verify the current connection. If another account is connected, reconnect the original account in sync settings.')
    : code === 'sourceAccountChanged' ? t('sites_problemOriginalAccount', 'Reconnect the original account in sync settings, or stop this check and start a new one for the current account.')
    : code === 'sourceUnresolved' ? t('sites_problemConfirmAccount', 'Open sync settings and confirm the detected website account, then continue checking.')
    : ['pageUnavailable', 'restartRequired', 'navigationChanged'].includes(code) ? t('sites_problemReconnectTab', 'Continue checking to reconnect an open $1 tab or open the website. Keep it open while reading; items already found are kept and duplicates are skipped.', site)
    : code === 'sourceReviewRequired' ? t('sites_problemReviewNext', 'Open Review items below to see which results need a decision.')
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
