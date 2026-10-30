import { t } from './i18n.js';
import { preferenceHash } from './preferences-navigation.js';

export interface ClassificationErrorFeedback { readonly text: string; readonly settingsHash?: string }
export function classificationErrorFeedback(error: string | undefined, local: boolean, retrySafe = false): ClassificationErrorFeedback {
  const messages: Record<string, string> = {
    cloud_destination_policy_unsupported: 'This server cannot enforce source folder exclusions. Use your configured local AI service or choose a folder manually.',
    destination_policy_changed: 'Folder eligibility changed. Ask for a new suggestion or choose a folder manually.',
    destination_policy_excluded: 'This folder is excluded from AI destinations. You can choose it manually.',
    destination_policy_needs_rebind: 'A source root needs rebinding in Site adapters before AI suggestions can run.',
    insufficient_credits: t('popup_notEnoughCreditsClassification', 'Not enough credits for a suggestion. You can still save.'),
    billing_consent_required: t('popup_classificationNeedsPriceConfirmation', 'The suggestion needs a price confirmation. Update the extension and try again.'),
    credit_price_changed: t('popup_classificationPriceChangedStart', 'The suggestion price changed. Start a new request.'),
    credit_limit_exceeded: t('popup_spendingLimitTooLow', 'Your spending limit is too low for this request. Start a new request.'),
    local_key_required: t('popup_localKeyRequired', 'Add your API key under AI suggestions in settings to get suggestions.'),
    local_key_rejected: t('popup_localKeyRejected', 'Your AI service rejected the key. Check it under AI suggestions in settings.'),
    local_no_folders: t('popup_localNoFolders', 'Create a bookmark folder first, then ask for a suggestion.'),
    local_request_failed: t('popup_localRequestFailed', 'Your AI service rejected the request or replied in an unexpected format. Try again.'),
    local_call_in_progress: t('popup_localCallInProgress', 'A suggestion is already running. Try again when it finishes.'),
    local_rate_limited: t('popup_localRateLimited', 'Your AI service is busy or rate limited. Try again shortly.'),
    local_timeout: t('popup_localTimeout', 'The suggestion timed out. Try again.'),
    local_result_unknown: t('popup_localResultUnknown', "The suggestion result wasn't received. Try again."),
    local_settings_changed: t('popup_localSettingsChanged', 'Your AI service settings changed. Try again.'),
    local_request_too_large: t('popup_localRequestTooLarge', 'The page and folder list are too large to send. Choose a folder manually.'),
    local_taxonomy_too_large: t('popup_localTaxonomyTooLarge', 'There are too many folders for a suggestion. Choose a folder manually.'),
    local_classification_failed: t('popup_localClassificationFailed', "The suggestion couldn't run. Try again, or choose a folder manually."),
  };
  if (!local) messages.reconnect_required = t('popup_signAgainExtensionSettings', 'Sign in again in the extension settings to get suggestions. You can still save.');
  const fallback = local ? t('popup_localProviderUnavailable', 'The suggestion could not be completed. Try again, or choose a folder manually.')
    : retrySafe ? t('popup_noFinalResultYet', 'No final result yet. Check this same request, or save without suggestions.')
      : t('popup_suggestionsUnavailableCanStill', 'Suggestions are unavailable. You can still choose a folder and save.');
  const settingsHash = error === 'local_key_required' || error === 'local_key_rejected'
    ? preferenceHash('local-classification') : undefined;
  return { text: error && Object.hasOwn(messages, error) ? messages[error]! : fallback, ...(settingsHash ? { settingsHash } : {}) };
}

export function paintClassificationError(host: HTMLElement, feedback: ClassificationErrorFeedback): void {
  host.replaceChildren(document.createTextNode(feedback.text));
  if (!feedback.settingsHash) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm';
  button.textContent = t('popup_openAiServiceSettings', 'Open AI service settings');
  const hash = feedback.settingsHash;
  button.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + hash }); });
  host.append(document.createTextNode(' '), button);
}
