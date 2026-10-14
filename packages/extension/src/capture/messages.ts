import { supportedCaptureUrl } from './existence.js';
import type { FeedbackKind } from './contracts.js';
import type { BookmarkAnnotationInput } from '../bookmark-annotation-store.js';
import { RETAINED_TAG_LIMITS } from '../bookmark-tag-limits.js';

export type CaptureRequest =
  | { readonly kind: 'known.capture.start'; readonly commandId: string; readonly trigger: 'manual-popup' | 'action-popup';
    readonly url: string; readonly title: string; readonly parentNativeId?: string; readonly collectionId?: string; readonly insertPosition?: 'top' | 'bottom';
    readonly saveAnother: boolean; readonly allowUnverifiedCloud: boolean; readonly userGesture?: true;
    readonly annotation?: BookmarkAnnotationInput;
    /** `explicit`: the user picked the folder for this save; no rule overrides it. */
    readonly folderChoice?: 'explicit' | 'default' }
  | { readonly kind: 'known.capture.get' | 'known.capture.resume' | 'known.capture.check' | 'known.capture.report.retry' | 'known.capture.decision.check'; readonly captureId: string }
  | { readonly kind: 'known.capture.undo' | 'known.capture.apply'; readonly captureId: string; readonly commandId: string; readonly userGesture: true }
  /** The popup's Undo removed the saved bookmark: the capture ends as cancelled instead of staying "saved". */
  | { readonly kind: 'known.capture.remove'; readonly captureId: string; readonly userGesture: true }
  | { readonly kind: 'known.capture.list'; readonly before?: readonly [number, string] };
/** Bounded here; the worker normalizes and caps tags and note again before it keeps them. */
function validAnnotation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).every(key => key === 'tags' || key === 'note' || key === 'pinned')
    && (raw.pinned === undefined || raw.pinned === true) && Array.isArray(raw.tags) && raw.tags.length <= RETAINED_TAG_LIMITS.count
    && raw.tags.every(tag => typeof tag === 'string' && tag.length <= 200)
    && (raw.note === null || typeof raw.note === 'string' && raw.note.length <= 20_000);
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);

export function validCaptureRequest(value: unknown): value is CaptureRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'known.capture.undo' || raw.kind === 'known.capture.apply') return Object.keys(raw).length === 4 && uuid(raw.captureId) && uuid(raw.commandId) && raw.userGesture === true;
  if (raw.kind === 'known.capture.remove') return Object.keys(raw).length === 3 && uuid(raw.captureId) && raw.userGesture === true;
  if (['known.capture.get', 'known.capture.resume', 'known.capture.check', 'known.capture.report.retry', 'known.capture.decision.check'].includes(String(raw.kind))) return Object.keys(raw).length === 2 && uuid(raw.captureId);
  if (raw.kind === 'known.capture.list') return Object.keys(raw).every(key => ['kind', 'before'].includes(key))
    && (raw.before === undefined || (Array.isArray(raw.before) && raw.before.length === 2
      && Number.isSafeInteger(raw.before[0]) && Number(raw.before[0]) >= 0 && uuid(raw.before[1])));
  return raw.kind === 'known.capture.start' && (raw.trigger === 'action-popup' ? !Object.hasOwn(raw, 'userGesture') : raw.userGesture === true) && uuid(raw.commandId)
    && ['manual-popup', 'action-popup'].includes(String(raw.trigger)) && supportedCaptureUrl(raw.url)
    && typeof raw.title === 'string' && raw.title.length <= 4096
    && typeof raw.saveAnother === 'boolean' && typeof raw.allowUnverifiedCloud === 'boolean'
    && (raw.parentNativeId === undefined || (typeof raw.parentNativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.parentNativeId)))
    && (raw.collectionId === undefined || typeof raw.collectionId === 'string' && /^[\w.-]{1,128}$/u.test(raw.collectionId))
    && (raw.insertPosition === undefined || raw.insertPosition === 'top' || raw.insertPosition === 'bottom')
    && (raw.annotation === undefined || validAnnotation(raw.annotation))
    && (raw.folderChoice === undefined || raw.folderChoice === 'explicit' || raw.folderChoice === 'default')
    && Object.keys(raw).every(key => ['kind', 'commandId', 'trigger', 'url', 'title', 'parentNativeId',
      'saveAnother', 'allowUnverifiedCloud', 'userGesture', 'collectionId', 'insertPosition', 'annotation', 'folderChoice'].includes(key));
}

export type CapturePanelRequest =
  | { readonly kind: 'known.capture.context' }
  | { readonly kind: 'known.capture.existence'; readonly url: string }
  | { readonly kind: 'known.capture.presented'; readonly captureId: string; readonly nodeRevision: string }
  | { readonly kind: 'known.capture.feedback'; readonly captureId: string; readonly nodeRevision: string; readonly eventId: string; readonly feedback: FeedbackKind; readonly expectedRevision?: number }
  | { readonly kind: 'known.capture.feedback.adopt'; readonly captureId: string; readonly revision: number };
export function validCapturePanelRequest(value: unknown): value is CapturePanelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'known.capture.context') return Object.keys(raw).length === 1;
  if (raw.kind === 'known.capture.existence') return Object.keys(raw).length === 2 && supportedCaptureUrl(raw.url);
  if (raw.kind === 'known.capture.feedback.adopt') return Object.keys(raw).length === 3 && uuid(raw.captureId) && Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0;
  if (!uuid(raw.captureId) || typeof raw.nodeRevision !== 'string' || raw.nodeRevision.length > 256) return false;
  if (raw.kind === 'known.capture.presented') return Object.keys(raw).length === 3;
  return raw.kind === 'known.capture.feedback' && Object.keys(raw).every(key => ['kind', 'captureId', 'nodeRevision', 'eventId', 'feedback', 'expectedRevision'].includes(key)) && uuid(raw.eventId)
    && (raw.expectedRevision === undefined || Number.isSafeInteger(raw.expectedRevision) && Number(raw.expectedRevision) >= 0)
    && ['explicit_positive', 'explicit_negative', 'implicit_positive', 'dismissed_unrated', 'withdrawn'].includes(String(raw.feedback));
}

/** A popup.html tab is not a toolbar activation. Never substitute a claimed gesture for this check. */
export async function isActionPopup(sender: chrome.runtime.MessageSender): Promise<boolean> {
  return (await actionPopupIdentity(sender)) !== null;
}
export async function actionPopupIdentity(sender: chrome.runtime.MessageSender): Promise<string | null> {
  if (sender.tab || sender.id !== chrome.runtime.id || !sender.url) return null;
  const url = new URL(sender.url);
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id || url.pathname !== '/popup.html'
    || !uuid(url.searchParams.get('surface')) || Array.from(url.searchParams.keys()).some(key => key !== 'surface')) return null;
  // Chromium extension-page messages omit documentId. Match the sender's unique
  // document URL against ALL context types, refusing duplicate/tab contexts.
  const contexts = await chrome.runtime.getContexts({ documentUrls: [sender.url] });
  const context = contexts.length === 1 ? contexts[0] : undefined;
  if (context?.contextType !== 'POPUP' || !context.documentId || context.documentUrl !== sender.url
    || (sender.documentId && sender.documentId !== context.documentId)) return null;
  return context.documentId;
}
