import { randomUUID } from 'node:crypto';
import {
  AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  renderAuthEmailTemplate,
  type AuthEmailDeliveryResult,
  type AuthEmailSender,
  type SendAuthEmailInput,
} from '../../modules/auth/index.js';
import type { EmailSendInput, EmailSendResult } from '../../modules/notifications/index.js';
import { AliyunDirectMailAdapter, redactEvidence } from './aliyun-directmail-adapter.js';
import {
  defaultEmailSkinMap,
  wrapEmailMessage,
  type EmailSkinMap,
} from './message-skins.js';

/**
 * C1 authentication email adapter (infrastructure:email).
 *
 * Implements the modules/auth auth-email port over the EXISTING DirectMail
 * machinery (aliyun-directmail-adapter.ts) WITHOUT touching the notification
 * delivery ledger: auth emails never enter the notification business tables,
 * and this adapter has no lookup / callback / suppression surface at all.
 *
 * Reused DirectMail capabilities:
 * - bounded per-request timeout + AbortSignal handling (timeout/abort =>
 *   retryable provider_unavailable -> email_delivery_unavailable);
 * - frozen error classification (permanent/retryable/unknown) and redacted
 *   error text (never recipient/OTP/subject material);
 * - stable tag/idempotency key: the caller's idempotencyKey is forwarded
 *   verbatim and reused as the DirectMail TagName on retries;
 * - provider credentials/recipient addresses/OTP are never logged: log lines
 *   carry ONLY purpose, redacted classification and the correlation id.
 *
 * Composition contract:
 * - test mode (NODE_ENV=test) -> in-process mailbox sink, never DirectMail
 *   credentials;
 * - any other environment with AUTH_EMAIL_ENABLED=true -> DirectMail adapter,
 *   credentials resolved via `resolveCredentials` (fail closed);
 * - AUTH_EMAIL_ENABLED=false -> unavailable sender (the auth routes must
 *   never claim "sent to a real mailbox" when delivery is not configured).
 */

/** Minimal provider surface the auth adapter needs (structural subset of EmailProviderAdapter). */
export interface AuthEmailProvider {
  send(input: EmailSendInput): Promise<EmailSendResult>;
  close?(): Promise<void>;
}

/**
 * Minimal log surface (pino Logger and the worker loop logger both satisfy
 * it structurally). Bindings MUST carry only purpose / redacted classification
 * / correlationId — never recipients, OTP/codes, subjects or bodies.
 */
export interface AuthEmailLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface AuthEmailAdapterOptions {
  readonly provider: AuthEmailProvider;
  readonly logger: AuthEmailLogger;
  /** Per-purpose skins; default all `purpose` so existing tests stay pixel-equal. */
  readonly emailSkins?: EmailSkinMap;
}

export interface AuthEmailAdapter extends AuthEmailSender {
  close(): Promise<void>;
}

/** Unified-chrome footer reason for every auth-purpose message. */
const AUTH_EMAIL_FOOTER_NOTE =
  'You received this because an account was created with this address.';

/** Inbox preheader: the first non-empty body line, capped at 90 chars. */
function firstBodyLine(textBody: string): string | undefined {
  const line = textBody.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return undefined;
  return line.length > 90 ? line.slice(0, 90) : line;
}

/**
 * In-process mailbox entry recorded by the test-mode sink. The sink is the
 * ONLY provider allowed in test mode (production requires DirectMail
 * credentials).
 */
export interface AuthEmailMailboxEntry {
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly receivedAt: string;
}

export interface InProcessMailboxSink {
  readonly provider: AuthEmailProvider;
  readonly entries: readonly AuthEmailMailboxEntry[];
  readonly sentCount: number;
}

export function createInProcessMailboxSink(): InProcessMailboxSink {
  const entries: AuthEmailMailboxEntry[] = [];
  let sent = 0;
  return {
    provider: {
      async send(input: EmailSendInput): Promise<EmailSendResult> {
        sent += 1;
        entries.push({
          idempotencyKey: input.idempotencyKey,
          to: input.message.to,
          subject: input.message.subject,
          textBody: input.message.textBody ?? '',
          receivedAt: new Date().toISOString(),
        });
        return {
          classification: 'success',
          providerMessageId: `mailbox-sink-${sent}`,
          requestId: null,
          errorCategory: null,
        };
      },
    },
    get entries(): readonly AuthEmailMailboxEntry[] { return entries; },
    get sentCount(): number { return sent; },
  };
}

export function createAuthEmailAdapter(options: AuthEmailAdapterOptions): AuthEmailAdapter {
  const { provider, logger } = options;
  const emailSkins = options.emailSkins ?? defaultEmailSkinMap();
  return {
    async sendAuthEmail(input: SendAuthEmailInput): Promise<AuthEmailDeliveryResult> {
      const correlationId = randomUUID();
      const invalid = validateAuthEmailRequest(input);
      if (invalid !== null) {
        logger.warn(
          { purpose: input.purpose, classification: 'invalid_request', correlationId },
          'auth email rejected before provider contact',
        );
        return { outcome: 'email_delivery_unavailable', correlationId, redactedReason: invalid };
      }
      const rendered = renderAuthEmailTemplate(input.purpose, input.templateData);
      if (!rendered.ok) {
        logger.warn(
          { purpose: input.purpose, classification: 'invalid_request', correlationId },
          'auth email template rejected before provider contact',
        );
        return {
          outcome: 'email_delivery_unavailable',
          correlationId,
          redactedReason: `auth email template rejected: ${rendered.reason}`,
        };
      }
      const wrapped = wrapEmailMessage({
        purpose: input.purpose,
        skin: emailSkins[input.purpose],
        mailClass: 'transactional',
        message: rendered.message,
        preheader: firstBodyLine(rendered.message.textBody),
        footerNote: AUTH_EMAIL_FOOTER_NOTE,
      });
      if (!wrapped.ok) {
        logger.warn(
          { purpose: input.purpose, classification: 'invalid_request', correlationId },
          'auth email wrap rejected before provider contact',
        );
        return {
          outcome: 'email_delivery_unavailable',
          correlationId,
          redactedReason: 'auth email wrap exceeded the delivery budget',
        };
      }
      let result: EmailSendResult;
      try {
        result = await provider.send({
          idempotencyKey: input.idempotencyKey,
          message: {
            to: input.to,
            subject: wrapped.message.subject,
            textBody: wrapped.message.textBody,
            htmlBody: wrapped.message.htmlBody,
          },
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (error) {
        logger.error(
          { purpose: input.purpose, classification: 'provider_unavailable', correlationId },
          'auth email provider failed at transport level',
        );
        return {
          outcome: 'email_delivery_unavailable',
          correlationId,
          redactedReason: redactEvidence(error),
        };
      }
      if (result.classification === 'success') {
        logger.info(
          { purpose: input.purpose, classification: 'queued', correlationId },
          'auth email queued for delivery',
        );
        return { outcome: 'queued', correlationId, providerMessageId: result.providerMessageId };
      }
      // Every provider classification (permanent/retryable/unknown) collapses
      // to the unified unavailable result; the redacted classification stays
      // observable in the log only.
      logger.warn({
        purpose: input.purpose,
        classification: 'provider_unavailable',
        providerClassification: result.classification,
        ...(result.errorCategory !== null ? { errorCategory: result.errorCategory } : {}),
        correlationId,
      }, 'auth email delivery unavailable');
      return {
        outcome: 'email_delivery_unavailable',
        correlationId,
        redactedReason: result.redactedError ?? 'provider did not accept the auth email',
      };
    },
    async close(): Promise<void> {
      await provider.close?.();
    },
  };
}

function validateAuthEmailRequest(input: SendAuthEmailInput): string | null {
  if (typeof input.to !== 'string' || input.to.trim() === '') {
    return 'auth email recipient is required';
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0
      || input.idempotencyKey.length > AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS) {
    return `auth email idempotencyKey must be 1..${AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS} chars`;
  }
  return null;
}

/**
 * The unavailable sender: composed when AUTH_EMAIL_ENABLED=false so the auth
 * routes always hold a stable surface that can NEVER claim a real mailbox
 * send (fake-positive protection).
 */
export function createUnavailableAuthEmailSender(logger: AuthEmailLogger): AuthEmailAdapter {
  return {
    async sendAuthEmail(input: SendAuthEmailInput): Promise<AuthEmailDeliveryResult> {
      const correlationId = randomUUID();
      logger.warn(
        { purpose: input.purpose, classification: 'not_configured', correlationId },
        'auth email delivery not configured',
      );
      return {
        outcome: 'email_delivery_unavailable',
        correlationId,
        redactedReason: 'auth email delivery is not configured',
      };
    },
    async close(): Promise<void> {
      // Nothing owned.
    },
  };
}

/** Structural DirectMail settings for the auth email surface (bootstrap config section). */
export interface AuthEmailDirectMailSettings {
  readonly endpoint: string;
  readonly regionId: string;
  readonly accountName: string | null;
  readonly timeoutMs: number;
  readonly tagPrefix: string;
  readonly maxTagChars: number;
}

export interface ComposeAuthEmailAdapterOptions {
  /** AUTH_EMAIL_ENABLED rollback flag; false composes the unavailable sender. */
  readonly enabled: boolean;
  /**
   * NODE_ENV: 'test' composes the in-process mailbox sink (DirectMail
   * credentials are NEVER resolved); any other value requires DirectMail
   * credentials via `resolveCredentials` (fail closed).
   */
  readonly nodeEnv: string;
  readonly directMail: AuthEmailDirectMailSettings;
  /**
   * DirectMail credential resolver (bootstrap reads ALIBABA_CLOUD_ACCESS_KEY_ID/
   * ALIBABA_CLOUD_ACCESS_KEY_SECRET). Called only when enabled && nodeEnv !==
   * 'test'; must throw naming the missing env vars (fail closed).
   */
  readonly resolveCredentials: () => { readonly accessKeyId: string; readonly accessKeySecret: string };
  readonly logger: AuthEmailLogger;
  /** Test seam: the in-process mailbox sink used in test mode (default creates a fresh sink). */
  readonly inProcessSink?: InProcessMailboxSink;
  /** Per-purpose skins from bootstrap config; default all `purpose`. */
  readonly emailSkins?: EmailSkinMap;
}

export interface AuthEmailComposition {
  /** Concrete adapter surface (sendAuthEmail + close); assignable to the port AuthEmailSender. */
  readonly sender: AuthEmailAdapter;
  close(): Promise<void>;
}

export function composeAuthEmailAdapter(options: ComposeAuthEmailAdapterOptions): AuthEmailComposition {
  if (!options.enabled) {
    return { sender: createUnavailableAuthEmailSender(options.logger), close: async () => {} };
  }
  if (options.nodeEnv === 'test') {
    const sink = options.inProcessSink ?? createInProcessMailboxSink();
    return {
      sender: createAuthEmailAdapter({
        provider: sink.provider,
        logger: options.logger,
        ...(options.emailSkins === undefined ? {} : { emailSkins: options.emailSkins }),
      }),
      close: async () => {},
    };
  }
  if (!options.directMail.accountName) {
    throw new Error('AUTH_EMAIL_DM_ACCOUNT_NAME is required when AUTH_EMAIL_ENABLED is enabled');
  }
  const credentials = options.resolveCredentials();
  const directMail = new AliyunDirectMailAdapter({
    endpoint: options.directMail.endpoint,
    regionId: options.directMail.regionId,
    accountName: options.directMail.accountName,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    timeoutMs: options.directMail.timeoutMs,
    tagPrefix: options.directMail.tagPrefix,
    maxTagChars: options.directMail.maxTagChars,
  });
  const sender = createAuthEmailAdapter({
    provider: directMail,
    logger: options.logger,
    ...(options.emailSkins === undefined ? {} : { emailSkins: options.emailSkins }),
  });
  return { sender, close: () => directMail.close() };
}
