import { bindNativeWaitSettings } from './native-wait-ui.js';
import { bindSyncAttentionSettings } from './sync-attention-ui.js';
import { bindIngressDiagnosticsSettings } from './ingress-diagnostics-ui.js';
import { bindLocalClassificationOptions } from './classification-local-options.js';
import { bindUiLanguageSettings } from './ui-language-settings.js';
import { bindLocalImportView } from './local-import/view.js';
import { bindManualClassificationOptions } from './manual-classification-options.js';
import { bindPermissionSettings } from './permissions-settings.js';
import { bindBackupView } from './local-backup/view.js';
import { bindRemoteDeleteSettings } from './remote-delete-ui.js';
import { initializeSettingsSection } from './settings-section.js';
/** Optional settings sections cannot prevent sign-in, native save or sync controls from loading. */
export function bindSecondarySettings(): void {
  initializeSettingsSection('pref-permissions', bindPermissionSettings);
  initializeSettingsSection('local-import', host => bindLocalImportView(host as HTMLDetailsElement));
  initializeSettingsSection('local-backup', bindBackupView);
  initializeSettingsSection('native-wait-settings', bindNativeWaitSettings);
  initializeSettingsSection('sync-attention-settings', bindSyncAttentionSettings);
  initializeSettingsSection('remote-delete-settings', bindRemoteDeleteSettings);
  initializeSettingsSection('ingress-diagnostics-settings', bindIngressDiagnosticsSettings);
  initializeSettingsSection('classification-local-settings', bindLocalClassificationOptions);
  initializeSettingsSection('manual-classification-settings', bindManualClassificationOptions);
  initializeSettingsSection('pref-language', bindUiLanguageSettings);
}
