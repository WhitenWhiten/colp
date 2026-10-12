import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { StorageArea } from './credential-store.js';
import type { CaptureScope } from './capture/contracts.js';
import type { ClassificationRequest } from './classification-messages.js';
import { retainClassificationReply, type ClassificationPreviewReply } from './classification-preview-reply.js';
import { canonicalJson } from './sync-state/codec.js';

export type ClassificationPreviewMessage = Extract<ClassificationRequest,
  { kind: 'known.classification.preview' | 'known.classification.local-preview' }>;
export const CLASSIFICATION_PREVIEW_PREFIX = 'known.classification.form-open.v1.';
const MAX_SESSION_INTENTS = 100;
interface PreviewRecord { readonly version: 1; readonly commandId: string; readonly reply?: ClassificationPreviewReply }
const running = new Map<string, Promise<ClassificationPreviewReply>>();

/** Reopening a form observes its prior command; only an explicit action can retry an uncertain result. */
export async function reuseClassificationPreview(input: {
  readonly message: ClassificationPreviewMessage;
  readonly binding: CaptureScope & { readonly providerGeneration: string | null };
  readonly storage: StorageArea;
  readonly execute: (message: ClassificationPreviewMessage) => Promise<ClassificationPreviewReply>;
}): Promise<ClassificationPreviewReply> {
  const { message, storage, execute } = input;
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(canonicalJson([
    input.binding, message.kind, 'collectionId' in message ? message.collectionId : null, message.document,
  ]))));
  const key = `${CLASSIFICATION_PREVIEW_PREFIX}${fingerprint}`;
  const implicit = 'automatic' in message;
  if (implicit && running.has(key)) return running.get(key)!;
  const run = async (): Promise<ClassificationPreviewReply> => {
    const stored = await storage.get(key);
    const value = stored[key] as PreviewRecord | undefined;
    const prior = value?.version === 1 && typeof value.commandId === 'string' ? value : undefined;
    const unknown = (commandId: string): ClassificationPreviewReply => ({ ok: false, commandId,
      error: message.kind === 'known.classification.local-preview' ? 'local_result_unknown' : 'classification_unavailable',
      sameRequestRetrySafe: message.kind === 'known.classification.preview' });
    if (implicit && Object.hasOwn(stored, key)) return prior ? { ...(prior.reply ?? unknown(prior.commandId)), commandId: prior.commandId }
      : { ...unknown(message.commandId), sameRequestRetrySafe: false };
    const replay = prior?.commandId === message.commandId;
    if (replay && prior.reply?.ok) return { ...prior.reply, commandId: prior.commandId };
    if (replay && message.kind === 'known.classification.local-preview') return { ...(prior.reply ?? unknown(prior.commandId)), commandId: prior.commandId };
    if (!implicit && !prior) return execute(message);
    if (implicit) {
      const records = await storage.get(null);
      if (Object.keys(records).filter(name => name.startsWith(CLASSIFICATION_PREVIEW_PREFIX)).length >= MAX_SESSION_INTENTS) {
        return { ok: true, skipped: 'session_limit' };
      }
    }
    // Durable before dispatch, including a user-requested replacement of an earlier implicit intent.
    await storage.set({ [key]: { version: 1, commandId: message.commandId } satisfies PreviewRecord });
    let reply: ClassificationPreviewReply;
    try { reply = await execute(message); }
    catch { reply = unknown(message.commandId); }
    const retained = retainClassificationReply(reply);
    await storage.set({ [key]: { version: 1, commandId: message.commandId, reply: retained } satisfies PreviewRecord }).catch(() => undefined);
    return { ...reply, commandId: message.commandId };
  };
  const promise = run();
  if (!implicit) return promise;
  running.set(key, promise);
  try { return await promise; } finally { running.delete(key); }
}
