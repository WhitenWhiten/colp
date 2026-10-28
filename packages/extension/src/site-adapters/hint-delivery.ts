import type { AdapterContext, MembershipHint } from './contracts.js';
import { abortableSleep } from './read-errors.js';
/** Retry the same interaction identity; host admission receipts make a lost reply idempotent. */
export async function deliverMembershipHint(context: AdapterContext, hint: MembershipHint,
  sleep = abortableSleep, now = Date.now) {
  for (let attempt = 0; attempt < 3 && !context.signal.aborted; attempt++) {
    const reply = await context.hint(hint);
    if (reply.status !== 'rejected' || !['capacity', 'rateLimited'].includes(reply.reason)) return reply;
    if (attempt === 2 || now() + 1500 >= context.deadlineAt) return reply;
    await sleep(1500, context.signal);
  }
  return { status: 'rejected' as const, reason: 'staleContext' as const };
}
