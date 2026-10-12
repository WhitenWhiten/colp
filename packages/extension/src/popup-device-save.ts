import { element } from './popup-dom.js';
import type { PublicAuthState } from './types.js';
import { localized, t } from './i18n.js';

export { DEVICE_FOLDER_SCOPE } from './save-folder.js';

export let PERMISSION_NOTE: string, SAVE_BUTTON: string;
localized(() => {
  PERMISSION_NOTE = t('popup_bookmarkAccessOffAllow', 'Bookmark access is off — allow it to save bookmarks to this browser.');
  SAVE_BUTTON = t('common_save', 'Save');
});

/**
 * Signed-out local saves (capture plan §12.4): the account may be absent,
 * offline, or refused, yet every local bookmark path stays usable. The only
 * non-connected states that keep the save surface closed are the transient
 * 'connecting'/'refreshing' — a save raced against a credential swap could
 * land in the wrong scope.
 */
export function localSaveCapable(state: PublicAuthState | undefined): boolean {
  return state !== undefined && state.status !== 'connected'
    && state.status !== 'connecting' && state.status !== 'refreshing';
}

/**
 * The submit gate mirrors renderAuth's output: dataset.state is 'connected'
 * or echoes the auth status while the local lane is open. Transient view
 * states ('saving', 'connecting' between renderAuth passes) refuse.
 */
export function canSaveNow(auth: PublicAuthState | undefined, viewState: string | undefined): boolean {
  return viewState === 'connected' || (viewState === auth?.status && localSaveCapable(auth));
}

/** One word for every lane: where the save goes is the folder's business, not the button's. */
export function saveButtonLabel(state: PublicAuthState | undefined): string {
  return !state || state.status === 'connected' || localSaveCapable(state) ? SAVE_BUTTON : t('popup_signSave', 'Sign in to save');
}

/** renderAuth's save-surface half: closes only when neither lane can save. */
export function paintSaveGate(state: PublicAuthState): void {
  const connected = state.status === 'connected';
  const localCapable = localSaveCapable(state);
  document.body.dataset.saveScope = localCapable ? 'device' : '';
  const save = element('save') as HTMLButtonElement;
  const gated = !connected && !localCapable;
  element('capture').hidden = gated;
  element('popup-foot').hidden = gated;
  save.hidden = gated;
  save.disabled = gated;
  element('permission-note-text').textContent = PERMISSION_NOTE;
  if (!connected) save.textContent = saveButtonLabel(state);
}

export interface DeviceSaveHost {
  readonly enableControls: () => void;
  readonly initTarget: (collectionId: string | undefined) => Promise<void>;
  readonly showExistence: (url: string) => Promise<void>;
  readonly showPersistedFeedback: () => Promise<void>;
  readonly currentUrl: () => string;
}

/** Device-mode init mirrors the connected one minus the account-only lanes. */
export function bindDeviceSave(host: DeviceSaveHost): { init(state: PublicAuthState | undefined): void } {
  return {
    init(state) {
      if (!localSaveCapable(state)) return;
      host.enableControls();
      void host.initTarget(undefined);
      void host.showExistence(host.currentUrl());
      void host.showPersistedFeedback();
    },
  };
}
