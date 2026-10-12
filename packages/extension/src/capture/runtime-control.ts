import type { CaptureControl } from './control.js';
import type { CaptureScope, CaptureTask } from './contracts.js';
import { sameCaptureScope } from './contracts.js';
import { localized, t } from '../i18n.js';
export type CaptureControlRequest = { kind: 'known.capture.control' } | { kind: 'known.capture.control.quote' }
  | { kind: 'known.capture.control.change'; commandId: string; generation: number; scopeKey: string; action: 'pause' | 'resume' }
  | { kind: 'known.capture.control.authorize'; commandId: string; generation: number; scopeKey: string; collectionId: string; priceVersion: string; maxPoints: number; periodPoints: number }
  | { kind: 'known.capture.control.target'; commandId: string; generation: number; scopeKey: string; nativeId: string };
export function validCaptureControlRequest(value: unknown): value is CaptureControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (['known.capture.control', 'known.capture.control.quote'].includes(String(raw.kind))) return Object.keys(raw).length === 1;
  if (typeof raw.scopeKey !== 'string' || raw.scopeKey.length > 1024 || typeof raw.commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.commandId)
    || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0) return false;
  if (raw.kind === 'known.capture.control.change') return Object.keys(raw).length === 5 && ['pause', 'resume'].includes(String(raw.action));
  if (raw.kind === 'known.capture.control.target') return Object.keys(raw).length === 5 && typeof raw.nativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.nativeId);
  return raw.kind === 'known.capture.control.authorize' && Object.keys(raw).length === 8 && typeof raw.collectionId === 'string' && /^[\w.-]{1,128}$/u.test(raw.collectionId)
    && typeof raw.priceVersion === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(raw.priceVersion)
    && [raw.maxPoints, raw.periodPoints].every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647)
    && Number(raw.periodPoints) >= Number(raw.maxPoints);
}
export function canResumeCapture(task: CaptureTask, scope: CaptureScope, now: number) {
  return sameCaptureScope(task.scope, scope) && task.automaticIntent && task.disposition === 'new' && task.save === 'local-saved'
    && !task.automatic && !task.manualFence && Boolean(task.local?.state === 'waiting' || task.billingAuthorization && task.billingAuthorization.expiresAt > now
      && task.billingAuthorization.collectionId === scope.collectionId) && now - task.createdAt < 86400000;
}
export interface CaptureRuntimeView {
  readonly ok: true; readonly scopeKey: string; readonly control: CaptureControl; readonly mode: 'manual' | 'automatic'; readonly pending: boolean; readonly state: string;
  readonly permission: boolean; readonly signedIn: boolean;
  readonly classificationState: string;
  /** Automatic classification runs through the user's own provider (no account or credits). */
  readonly local?: boolean; readonly target: { nativeId: string; path: string[]; inRange: boolean; collectionId: string | null; collectionTitle: string | null } | null;
  readonly targetError: string | null; readonly counts: { resumable: number; suggestions: number; checking: number; manual: number };
}
export let CAPTURE_RUNTIME_COPY: Readonly<Record<string, string>>;
localized(() => {
  CAPTURE_RUNTIME_COPY = {
  manual: t('capture_manualSaving', 'Manual saving'), automatic: t('capture_automaticSavingReady', 'Automatic saving is ready'), paused: t('capture_automaticClassificationPausedSaving', 'Folder suggestions paused. Saving and sync continue.'),
  target_unavailable: t('capture_chooseBrowserFolder', 'Choose a browser folder'),
  permission_required: t('capture_bookmarkPermissionRequired', 'Bookmark permission required'), sign_in_required: t('capture_signClassify', 'Sign in for Know-N suggestions'), authorization_required: t('capture_classificationAuthorizationRequired', 'Set a spending limit under AI suggestions'),
  policy_unavailable: t('capture_automaticClassificationAwaitsQuality', 'Folder suggestions are unavailable right now'), policy_unknown: t('capture_classificationAvailabilityCouldNot2', 'Could not check whether suggestions are available'),
  offline: t('capture_offlineLocalSavingRemains', 'Offline; local saving remains available'), preferences_conflict: t('capture_resolveAccountPreferenceConflict', 'Resolve the account preference conflict'), target_not_mapped: t('capture_targetOutsideBrowsersSync', 'The default folder is not synced'),
  credits_unavailable: t('capture_creditsCouldNotChecked', 'Credits could not be checked'),
  credits_required: t('capture_reviewClassificationCredits', 'Not enough credits for suggestions'),
};
});
