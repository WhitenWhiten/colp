import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { AuthEmailMailboxEntry, InProcessMailboxSink } from '../infrastructure/email/index.js';

/** Frozen C1 template subjects → stable purpose labels (test material only). */
const AUTH_MAILBOX_SUBJECT_PURPOSES: Readonly<Record<string, string>> = Object.freeze({
  'Your Know-N sign-in code': 'sign-in-otp',
  'Your Know-N email verification code': 'email-verification-otp',
  'Your Know-N password reset code': 'forget-password-otp',
  'Your Know-N email change code': 'change-email-otp',
  'Verify your Know-N email': 'email-verification',
  'Reset your Know-N password': 'password-reset',
  'Confirm your new Know-N email': 'email-change',
  'Your Know-N recovery codes': 'mfa-recovery',
});

function authMailboxPurposeOfSubject(subject: string): string {
  return AUTH_MAILBOX_SUBJECT_PURPOSES[subject] ?? 'other';
}

/**
 * E3 test-only mailbox entry projection: test material only (recipient,
 * purpose, OTP plaintext, expiry, idempotency key, extracted URL for
 * verification/reset links). The OTP/URL are parsed from the C1 template
 * body; expiry is the recipient's receivedAt + the configured OTP TTL.
 */
export function toAuthMailboxQueryEntry(
  entry: AuthEmailMailboxEntry,
  index: number,
  otpTtlSeconds: number,
): Record<string, unknown> {
  const otp = entry.textBody.match(/\b\d{6}\b/u)?.[0] ?? null;
  const url = entry.textBody.match(/\bhttps?:\/\/\S+/u)?.[0] ?? null;
  const receivedAt = new Date(entry.receivedAt);
  return {
    id: `mail-${index + 1}`,
    to: entry.to,
    purpose: authMailboxPurposeOfSubject(entry.subject),
    otp,
    url,
    receivedAt: receivedAt.toISOString(),
    expiresAt: otp === null
      ? null
      : new Date(receivedAt.getTime() + otpTtlSeconds * 1000).toISOString(),
    idempotencyKey: entry.idempotencyKey,
  };
}

export function registerTestAuthMailboxRoute(
  app: FastifyInstance,
  config: AppConfig,
  authMailboxSink: InProcessMailboxSink | undefined,
): void {
  // E3 test-only auth-mailbox query route (supervisor-approved src/**
  // exception; see the config section). The in-process C1 mailbox sink lives
  // in this process, so the separate real-stack harness can only read
  // OTP/verification material through this explicit surface. Triple gate:
  // NODE_ENV=test + explicit flag (route not registered otherwise) + bearer
  // token (wrong/absent token answers 404). The response carries test
  // material only (purpose/email/OTP/expiry/idempotency key, never
  // credentials) and is never logged; no-store on every path.
  if (!config.testAuthMailboxHttp.enabled) return;
  app.get('/__test__/auth-mailbox', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${config.testAuthMailboxHttp.token}`) {
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found' });
    }
    const entries = (authMailboxSink?.entries ?? []).map((entry, index) =>
      toAuthMailboxQueryEntry(entry, index, config.betterAuth.otpTtlSeconds));
    return reply.header('Cache-Control', 'no-store').send({ entries });
  });
}
