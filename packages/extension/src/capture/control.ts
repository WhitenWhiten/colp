import { bookmarkPreferencesScopeKey, type BookmarkPreferences } from '../bookmark-preferences.js';
import type { CaptureScope } from './contracts.js';
export interface CaptureControl {
  readonly manualStopToken?: string;
  readonly manualOverride?: boolean;
  readonly paused: boolean;
  readonly generation: number;
  readonly lastCommand?: { readonly id: string; readonly fingerprint: string };
  readonly evidenceGeneration?: number;
  readonly consent: { readonly collectionId: string; readonly priceVersion: string; readonly maxPoints: number;
    readonly periodPoints: number; readonly expiresAt: number } | null;
}
export const DEFAULT_CAPTURE_CONTROL: CaptureControl = { paused: false, generation: 0, consent: null };
/** Saving depends on native access and a destination; classification controls never gate it. */
export function effectiveSaveState(preferences: BookmarkPreferences, control: CaptureControl,
  input: { readonly permission: boolean; readonly target: boolean }) {
  if (preferences.captureMode !== 'automatic' || control.manualOverride) return 'manual';
  if (!input.permission) return 'permission_required';
  return input.target ? 'automatic' : 'target_unavailable';
}
export function captureControlKey(scope: CaptureScope): string {
  return `known.capture.control.v1.${bookmarkPreferencesScopeKey(scope.serverOrigin, scope.accountId)}`;
}
export function effectiveCaptureState(preferences: BookmarkPreferences, control: CaptureControl,
  input: { readonly account: boolean; readonly permission: boolean; readonly policy: boolean; readonly collectionId: string | null; readonly now: number; readonly online?: boolean; readonly conflict?: boolean; readonly inRange?: boolean; readonly credits?: boolean; readonly local?: boolean; readonly localOffline?: boolean }) {
  if (preferences.captureMode !== 'automatic' || control.manualOverride) return 'manual';
  if (control.paused) return 'paused';
  if (!input.permission) return 'permission_required';
  // Local-first: the user's own provider needs no account, collection, authorization, policy or credits.
  if (input.local) return input.online === false && !input.localOffline ? 'offline' : input.conflict ? 'preferences_conflict' : 'automatic';
  if (!input.account) return 'sign_in_required';
  if (input.online === false) return 'offline';
  if (input.conflict) return 'preferences_conflict';
  if (input.inRange === false) return 'target_not_mapped';
  if (!control.consent || control.consent.expiresAt <= input.now || control.consent.collectionId !== input.collectionId) return 'authorization_required';
  if (!input.policy) return 'policy_unavailable';
  if (input.credits === false) return 'credits_required';
  return 'automatic';
}
export async function readCaptureControl(scope: CaptureScope): Promise<CaptureControl> {
  const value = (await chrome.storage.local.get(captureControlKey(scope)))[captureControlKey(scope)] as CaptureControl | undefined;
  if (!value || typeof value.paused !== 'boolean' || !Number.isSafeInteger(value.generation) || value.generation < 0) return DEFAULT_CAPTURE_CONTROL;
  const consent = value.consent;
  if (consent && (typeof consent.collectionId !== 'string' || typeof consent.priceVersion !== 'string'
    || !Number.isSafeInteger(consent.maxPoints) || consent.maxPoints < 0 || !Number.isSafeInteger(consent.periodPoints)
    || consent.periodPoints < consent.maxPoints || !Number.isSafeInteger(consent.expiresAt))) return { ...value, consent: null };
  return value;
}

// The worker owns mutations; serialize read/modify/write so learning refresh cannot erase pause or consent.
const controlWrites = new Map<string, Promise<unknown>>();
export async function updateCaptureControl(scope: CaptureScope, change: (current: CaptureControl) => CaptureControl, values: Record<string, unknown> = {}): Promise<CaptureControl> {
  const key = captureControlKey(scope), previous = controlWrites.get(key) ?? Promise.resolve();
  const result = previous.then(async () => {
    const next = change(await readCaptureControl(scope));
    await chrome.storage.local.set({ ...values, [key]: next }); return next;
  });
  const settled = result.then(() => {}, () => {});
  controlWrites.set(key, settled);
  try { return await result; } finally { if (controlWrites.get(key) === settled) controlWrites.delete(key); }
}
