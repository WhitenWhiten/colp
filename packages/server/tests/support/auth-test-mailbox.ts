/**
 * Task E1: in-process authentication test mailbox (plan §11 E1 step 3).
 *
 * Injected ONLY under `NODE_ENV=test` (refuses any other environment), wraps
 * the C1 in-process mailbox sink (`createInProcessMailboxSink`) and adds
 * purpose/email/test-id lookup over the last delivered mail:
 *
 * - purpose lookup matches the frozen digest-only idempotency key
 *   (`authEmailIdempotencyKey(purpose, email)`), so purpose separation is
 *   proven against the REAL key contract — never by parsing subject text;
 * - `otpFor` extracts the 6-digit code from the last matching mail;
 * - `setTestId` tags every subsequent delivery so parallel tests can read
 *   "the last mail of this test" even when they share a recipient address;
 * - the mailbox NEVER constructs or exposes real DirectMail/Google/GitHub
 *   provider credentials (C1 test-mode sink only).
 */
import {
  createInProcessMailboxSink,
} from '../../src/infrastructure/email/auth-email-adapter.js';
import type { EmailSendInput, EmailSendResult } from '../../src/modules/email/index.js';
import { authEmailIdempotencyKey } from '../../src/modules/auth/index.js';

export type AuthTestMailScope =
  | 'otp:sign-in'
  | 'otp:forget-password'
  | 'otp:email-verification'
  | 'otp:change-email'
  | 'otp:mfa-recovery'
  | 'email-verification'
  | 'password-reset'
  | 'email-change'
  | 'mfa-recovery';

export const AUTH_TEST_MAIL_SCOPES: readonly AuthTestMailScope[] = [
  'otp:sign-in',
  'otp:forget-password',
  'otp:email-verification',
  'otp:change-email',
  'otp:mfa-recovery',
  'email-verification',
  'password-reset',
  'email-change',
  'mfa-recovery',
];

export interface AuthTestMailboxEntry {
  /** Stable per-delivery sequence id (`mail-1`, `mail-2`, ...). */
  readonly id: string;
  /** Test tag active when the mail was delivered (`setTestId`). */
  readonly testId: string | null;
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly receivedAt: string;
}

export interface AuthTestMailbox {
  /** Wire into `createAuthEmailAdapter({ provider: mailbox.provider, ... })`. */
  readonly provider: {
    send(input: EmailSendInput): Promise<EmailSendResult>;
  };
  readonly entries: readonly AuthTestMailboxEntry[];
  readonly sentCount: number;
  /** Tag every subsequent delivery with a test id (null clears the tag). */
  setTestId(testId: string | null): void;
  /**
   * Last mail matching email (+ optional purpose scope / test id). Purpose
   * matching uses the REAL digest idempotency-key contract; `testId` filters
   * deliveries tagged by `setTestId`.
   */
  lastMailFor(input: {
    readonly email: string;
    readonly purpose?: AuthTestMailScope;
    readonly testId?: string | null;
  }): AuthTestMailboxEntry | null;
  /** Extract the 6-digit OTP from the last mail matching the filter. */
  otpFor(input: {
    readonly email: string;
    readonly purpose?: AuthTestMailScope;
    readonly testId?: string | null;
  }): string | null;
  reset(): void;
}

export function createAuthTestMailbox(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): AuthTestMailbox {
  const env = options.env ?? process.env;
  if (env.NODE_ENV !== 'test') {
    throw new Error('auth test mailbox is only available under NODE_ENV=test');
  }
  const sink = createInProcessMailboxSink();
  const entries: AuthTestMailboxEntry[] = [];
  let sent = 0;
  let currentTestId: string | null = null;

  return {
    provider: {
      async send(input: EmailSendInput): Promise<EmailSendResult> {
        sent += 1;
        const entry: AuthTestMailboxEntry = {
          id: `mail-${sent}`,
          testId: currentTestId,
          idempotencyKey: input.idempotencyKey,
          to: input.message.to,
          subject: input.message.subject,
          textBody: input.message.textBody ?? '',
          receivedAt: new Date().toISOString(),
        };
        entries.push(entry);
        return sink.provider.send(input);
      },
    },
    get entries() { return entries; },
    get sentCount() { return sent; },
    setTestId(testId: string | null) {
      currentTestId = testId;
    },
    lastMailFor({ email, purpose, testId }) {
      const key = purpose === undefined ? null : authEmailIdempotencyKey(purpose, email);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        if (entry.to !== email) continue;
        if (key !== null && entry.idempotencyKey !== key) continue;
        if (testId !== undefined && entry.testId !== testId) continue;
        return entry;
      }
      return null;
    },
    otpFor(input) {
      const entry = this.lastMailFor(input);
      if (!entry) return null;
      const match = entry.textBody.match(/\b\d{6}\b/u);
      return match ? match[0] : null;
    },
    reset() {
      entries.length = 0;
      sent = 0;
      currentTestId = null;
    },
  };
}

export type { AuthEmailMailboxEntry } from '../../src/infrastructure/email/auth-email-adapter.js';
