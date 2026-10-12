import type { SubscriptionCommand } from '../bookmark-subscriptions/commands.js';
export type { SubscriptionCommand, MountInput } from '../bookmark-subscriptions/commands.js';
export type Send = <T>(command: SubscriptionCommand, requestId?: string) => Promise<T>;
export const send: Send = async <T>(command: SubscriptionCommand, requestId: string = crypto.randomUUID()): Promise<T> => {
  const result = await chrome.runtime.sendMessage({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId, command }) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!result?.ok) throw new Error(result?.error ?? 'subscription_runtime_unavailable');
  return result.data as T;
};
