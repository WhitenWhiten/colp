import { randomUUID } from 'node:crypto';
import {
  INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  type InviteEmailDeliveryResult,
  type InviteEmailSender,
  type SendInviteEmailInput,
} from '../../modules/access-policy/index.js';
import type { EmailSendInput, EmailSendResult } from '../../modules/notifications/index.js';
import { AliyunDirectMailAdapter, redactEvidence, validateIdempotencyKey } from './aliyun-directmail-adapter.js';
import {
  defaultEmailSkinMap,
  wrapEmailMessage,
  type EmailSkinMap,
} from './message-skins.js';

/**
 * SC-04 collection invite email adapter (infrastructure:email).
 *
 * Reuses AliyunDirectMailAdapter.send. Test mode uses an in-process mailbox
 * independent of the auth sink (`purpose: 'collaboration-invite'`). Logs bind
 * purpose `inviteEmail`, delivery_id, and redacted classification — never
 * to/subject/body.
 */

export interface InviteEmailProvider {
  send(input: EmailSendInput): Promise<EmailSendResult>;
  close?(): Promise<void>;
}

export interface InviteEmailLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface InviteEmailAdapterOptions {
  readonly provider: InviteEmailProvider;
  readonly logger: InviteEmailLogger;
  readonly tagPrefix?: string;
  readonly maxTagChars?: number;
  /** Per-purpose skins; default all `purpose` so existing tests stay pixel-equal. */
  readonly emailSkins?: EmailSkinMap;
}

export interface InviteEmailAdapter extends InviteEmailSender {
  close(): Promise<void>;
}

/** Unified-chrome footer reason for the collaboration-invite message. */
const INVITE_EMAIL_FOOTER_NOTE =
  'You received this because someone invited you to a collection.';

/** Inbox preheader: the first non-empty body line, capped at 90 chars. */
function firstBodyLine(textBody: string): string | undefined {
  const line = textBody.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return undefined;
  return line.length > 90 ? line.slice(0, 90) : line;
}

export interface InviteEmailMailboxEntry {
  readonly purpose: 'collaboration-invite';
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly receivedAt: string;
}

export interface InviteEmailMailboxSink {
  readonly provider: InviteEmailProvider;
  readonly entries: readonly InviteEmailMailboxEntry[];
  readonly sentCount: number;
}

export function createInviteEmailMailboxSink(): InviteEmailMailboxSink {
  const entries: InviteEmailMailboxEntry[] = [];
  let sent = 0;
  return {
    provider: {
      async send(input: EmailSendInput): Promise<EmailSendResult> {
        sent += 1;
        entries.push({
          purpose: 'collaboration-invite',
          idempotencyKey: input.idempotencyKey,
          to: input.message.to,
          subject: input.message.subject,
          textBody: input.message.textBody ?? '',
          htmlBody: input.message.htmlBody ?? '',
          receivedAt: new Date().toISOString(),
        });
        return {
          classification: 'success',
          providerMessageId: `invite-mailbox-sink-${sent}`,
          requestId: null,
          errorCategory: null,
        };
      },
    },
    get entries(): readonly InviteEmailMailboxEntry[] { return entries; },
    get sentCount(): number { return sent; },
  };
}

export function createInviteEmailAdapter(options: InviteEmailAdapterOptions): InviteEmailAdapter {
  const { provider, logger } = options;
  const tagPrefix = options.tagPrefix ?? 'known-invite-';
  const maxTagChars = options.maxTagChars ?? 128;
  const emailSkins = options.emailSkins ?? defaultEmailSkinMap();
  return {
    async sendInviteEmail(input: SendInviteEmailInput): Promise<InviteEmailDeliveryResult> {
      const correlationId = randomUUID();
      const deliveryId = input.idempotencyKey;
      const invalid = validateInviteEmailRequest(input, tagPrefix, maxTagChars);
      if (invalid !== null) {
        logger.warn(
          { purpose: 'inviteEmail', deliveryId, classification: 'invalid_request', correlationId },
          'invite email rejected before provider contact',
        );
        return { outcome: 'email_delivery_unavailable', correlationId, redactedReason: invalid };
      }
      const wrapped = wrapEmailMessage({
        purpose: 'collaboration-invite',
        skin: emailSkins['collaboration-invite'],
        mailClass: 'transactional',
        message: {
          subject: input.message.subject,
          textBody: input.message.textBody,
          htmlBody: input.message.htmlBody,
        },
        preheader: firstBodyLine(input.message.textBody),
        footerNote: INVITE_EMAIL_FOOTER_NOTE,
      });
      if (!wrapped.ok) {
        logger.warn(
          { purpose: 'inviteEmail', deliveryId, classification: 'invalid_request', correlationId },
          'invite email wrap rejected before provider contact',
        );
        return {
          outcome: 'email_delivery_unavailable',
          correlationId,
          redactedReason: 'invite email wrap exceeded the delivery budget',
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
          { purpose: 'inviteEmail', deliveryId, classification: 'provider_unavailable', correlationId },
          'invite email provider failed at transport level',
        );
        return {
          outcome: 'email_delivery_unavailable',
          correlationId,
          redactedReason: redactEvidence(error),
        };
      }
      if (result.classification === 'success') {
        logger.info(
          { purpose: 'inviteEmail', deliveryId, classification: 'queued', correlationId },
          'invite email queued for delivery',
        );
        return { outcome: 'queued', correlationId, providerMessageId: result.providerMessageId };
      }
      logger.warn({
        purpose: 'inviteEmail',
        deliveryId,
        classification: 'provider_unavailable',
        providerClassification: result.classification,
        ...(result.errorCategory !== null ? { errorCategory: result.errorCategory } : {}),
        correlationId,
      }, 'invite email delivery unavailable');
      return {
        outcome: 'email_delivery_unavailable',
        correlationId,
        redactedReason: result.redactedError ?? 'provider did not accept the invite email',
      };
    },
    async close(): Promise<void> {
      await provider.close?.();
    },
  };
}

function validateInviteEmailRequest(
  input: SendInviteEmailInput,
  tagPrefix: string,
  maxTagChars: number,
): string | null {
  if (typeof input.to !== 'string' || input.to.trim() === '') {
    return 'invite email recipient is required';
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0
      || input.idempotencyKey.length > INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS) {
    return `invite email idempotencyKey must be 1..${INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS} chars`;
  }
  const keyValidation = validateIdempotencyKey(input.idempotencyKey, { tagPrefix, maxTagChars });
  if (!keyValidation.ok) return `invite email ${keyValidation.reason}`;
  return null;
}

export function createUnavailableInviteEmailSender(logger: InviteEmailLogger): InviteEmailAdapter {
  return {
    async sendInviteEmail(input: SendInviteEmailInput): Promise<InviteEmailDeliveryResult> {
      const correlationId = randomUUID();
      logger.warn(
        {
          purpose: 'inviteEmail',
          deliveryId: input.idempotencyKey,
          classification: 'not_configured',
          correlationId,
        },
        'invite email delivery not configured',
      );
      return {
        outcome: 'email_delivery_unavailable',
        correlationId,
        redactedReason: 'invite email delivery is not configured',
      };
    },
    async close(): Promise<void> {
      // Nothing owned.
    },
  };
}

export interface InviteEmailDirectMailSettings {
  readonly endpoint: string;
  readonly regionId: string;
  readonly accountName: string | null;
  readonly timeoutMs: number;
  readonly tagPrefix: string;
  readonly maxTagChars: number;
}

export interface ComposeInviteEmailAdapterOptions {
  readonly enabled: boolean;
  readonly nodeEnv: string;
  readonly directMail: InviteEmailDirectMailSettings;
  readonly resolveCredentials: () => { readonly accessKeyId: string; readonly accessKeySecret: string };
  readonly logger: InviteEmailLogger;
  readonly inProcessSink?: InviteEmailMailboxSink;
  /** Per-purpose skins from bootstrap config; default all `purpose`. */
  readonly emailSkins?: EmailSkinMap;
}

export interface InviteEmailComposition {
  readonly sender: InviteEmailAdapter;
  close(): Promise<void>;
}

export function composeInviteEmailAdapter(options: ComposeInviteEmailAdapterOptions): InviteEmailComposition {
  if (!options.enabled) {
    return { sender: createUnavailableInviteEmailSender(options.logger), close: async () => {} };
  }
  if (options.nodeEnv === 'test') {
    const sink = options.inProcessSink ?? createInviteEmailMailboxSink();
    return {
      sender: createInviteEmailAdapter({
        provider: sink.provider,
        logger: options.logger,
        tagPrefix: options.directMail.tagPrefix,
        maxTagChars: options.directMail.maxTagChars,
        ...(options.emailSkins === undefined ? {} : { emailSkins: options.emailSkins }),
      }),
      close: async () => {},
    };
  }
  if (!options.directMail.accountName) {
    throw new Error(
      'COLLABORATION_INVITE_EMAIL_DM_ACCOUNT_NAME or AUTH_EMAIL_DM_ACCOUNT_NAME is required '
      + 'when COLLABORATION_INVITE_EMAIL_ENABLED is enabled',
    );
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
  const sender = createInviteEmailAdapter({
    provider: directMail,
    logger: options.logger,
    tagPrefix: options.directMail.tagPrefix,
    maxTagChars: options.directMail.maxTagChars,
    ...(options.emailSkins === undefined ? {} : { emailSkins: options.emailSkins }),
  });
  return { sender, close: () => directMail.close() };
}
