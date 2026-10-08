import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'vitest';
import {
  composeInviteEmailAdapter,
  createInviteEmailAdapter,
  createInviteEmailMailboxSink,
  createUnavailableInviteEmailSender,
} from '../../../src/infrastructure/email/invite-email-adapter.js';
import { parseEmailSkinConfig } from '../../../src/infrastructure/email/message-skins.js';
import { UNIFIED_EMAIL_SKIN } from '../../../src/infrastructure/email/unified-email-chrome.js';
import {
  INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  type InviteEmailDeliveryResult,
} from '../../../src/modules/access-policy/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import {
  AliyunDirectMailAdapter,
  type AliyunDirectMailAdapterOptions,
  type EmailAdapterTransport,
} from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';

const RECIPIENT = 'invitee-redact@example.invalid';
const MESSAGE = {
  subject: "You've been invited to collaborate on Know-N",
  textBody: 'Ada invited you to collaborate on Notes as Editor.\n\n— Know-N',
  htmlBody: '<p>Ada invited you to collaborate on Notes as Editor.</p><p>— Know-N</p>',
};

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding: unknown, done: () => void) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger('info', destination), lines };
}

function sendInput(overrides: Partial<{
  to: string;
  idempotencyKey: string;
  signal: AbortSignal;
}> = {}) {
  return {
    to: overrides.to ?? RECIPIENT,
    message: MESSAGE,
    idempotencyKey: overrides.idempotencyKey ?? 'delivery-key-1',
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}

function unavailableReason(result: InviteEmailDeliveryResult): string {
  return result.outcome === 'email_delivery_unavailable' ? result.redactedReason : '';
}

function directMailOptions(
  overrides: Partial<AliyunDirectMailAdapterOptions> = {},
): AliyunDirectMailAdapterOptions {
  return {
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'invite-sender@example.invalid',
    accessKeyId: 'INVITEFIXTUREAKID',
    accessKeySecret: 'invite-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-invite-',
    maxTagChars: 128,
    ...overrides,
  };
}

function fakeTransport(
  responses: readonly (() => { readonly httpStatus: number; readonly bodyText: string })[],
): { readonly transport: EmailAdapterTransport; readonly calls: number } {
  let calls = 0;
  let index = 0;
  return {
    transport: {
      async request(input) {
        calls += 1;
        if (input.signal.aborted) {
          throw input.signal.reason instanceof Error ? input.signal.reason : new Error('aborted');
        }
        const response = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        return response();
      },
    },
    get calls() { return calls; },
  };
}

const json = (httpStatus: number, body: unknown) => ({
  httpStatus,
  bodyText: JSON.stringify(body),
});

describe('invite email adapter unavailable dichotomy', () => {
  test('provider success is queued; every failure is email_delivery_unavailable', async () => {
    const success = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const directMail = new AliyunDirectMailAdapter(directMailOptions({ transport: success.transport }));
    const sender = createInviteEmailAdapter({ provider: directMail, logger: createLogger('silent') });
    try {
      const queued = await sender.sendInviteEmail(sendInput());
      assert.equal(queued.outcome, 'queued');
    } finally {
      await directMail.close();
    }

    const failure = fakeTransport([() => json(500, { Code: 'InternalError', Message: 'x', RequestId: 'r' })]);
    const failing = new AliyunDirectMailAdapter(directMailOptions({ transport: failure.transport }));
    const failingSender = createInviteEmailAdapter({
      provider: failing, logger: createLogger('silent'),
    });
    try {
      const unavailable = await failingSender.sendInviteEmail(sendInput());
      assert.equal(unavailable.outcome, 'email_delivery_unavailable');
    } finally {
      await failing.close();
    }

    const blank = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const blankMail = new AliyunDirectMailAdapter(directMailOptions({ transport: blank.transport }));
    const blankSender = createInviteEmailAdapter({
      provider: blankMail, logger: createLogger('silent'),
    });
    try {
      const missingTo = await blankSender.sendInviteEmail(sendInput({ to: '   ' }));
      assert.equal(missingTo.outcome, 'email_delivery_unavailable');
      assert.equal(blank.calls, 0);
    } finally {
      await blankMail.close();
    }
  });

  test('createUnavailableInviteEmailSender never claims a mailbox send', async () => {
    const { logger, lines } = captureLogger();
    const sender = createUnavailableInviteEmailSender(logger);
    const result = await sender.sendInviteEmail(sendInput());
    assert.equal(result.outcome, 'email_delivery_unavailable');
    assert.match(unavailableReason(result), /not configured/u);
    const logText = lines.join('\n');
    assert.match(logText, /"purpose":"inviteEmail"/u);
    assert.match(logText, /"classification":"not_configured"/u);
    assert.doesNotMatch(logText, /"to"/u);
  });
});

describe('invite email adapter request validation', () => {
  test('idempotencyKey longer than 128 chars is rejected before provider contact', async () => {
    assert.equal(INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS, 128);
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const directMail = new AliyunDirectMailAdapter(directMailOptions({ transport: fake.transport }));
    const sender = createInviteEmailAdapter({ provider: directMail, logger: createLogger('silent') });
    try {
      const result = await sender.sendInviteEmail(sendInput({
        idempotencyKey: 'x'.repeat(INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS + 1),
      }));
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.match(unavailableReason(result), /idempotencyKey/u);
      assert.equal(fake.calls, 0);
    } finally {
      await directMail.close();
    }
  });
});

describe('invite email adapter log redaction', () => {
  test('log bindings include inviteEmail purpose and never include to', async () => {
    const { logger, lines } = captureLogger();
    const sink = createInviteEmailMailboxSink();
    const sender = createInviteEmailAdapter({ provider: sink.provider, logger });
    const result = await sender.sendInviteEmail(sendInput({ idempotencyKey: 'delivery-log-1' }));
    assert.equal(result.outcome, 'queued');
    const logText = lines.join('\n');
    assert.match(logText, /"purpose":"inviteEmail"/u);
    assert.match(logText, /"classification":"queued"/u);
    assert.doesNotMatch(logText, /"to"/u);
    assert.doesNotMatch(logText, new RegExp(RECIPIENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(logText, /You've been invited/u);
    assert.equal(sink.entries[0]?.purpose, 'collaboration-invite');
  });
});

describe('invite email adapter test composition', () => {
  test('NODE_ENV=test uses the independent mailbox sink and never resolves credentials', async () => {
    const sink = createInviteEmailMailboxSink();
    const composition = composeInviteEmailAdapter({
      enabled: true,
      nodeEnv: 'test',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
        timeoutMs: 10_000,
        tagPrefix: 'known-invite-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved in test mode');
      },
      logger: createLogger('silent'),
      inProcessSink: sink,
    });
    try {
      const result = await composition.sender.sendInviteEmail(sendInput());
      assert.equal(result.outcome, 'queued');
      assert.equal(sink.sentCount, 1);
    } finally {
      await composition.close();
    }
  });

  test('enabled=false composes the unavailable sender without touching credentials', async () => {
    const composition = composeInviteEmailAdapter({
      enabled: false,
      nodeEnv: 'production',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
        timeoutMs: 10_000,
        tagPrefix: 'known-invite-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved when invite email is disabled');
      },
      logger: createLogger('silent'),
    });
    const result = await composition.sender.sendInviteEmail(sendInput());
    assert.equal(result.outcome, 'email_delivery_unavailable');
    await composition.close();
  });
});

const INVITE_SECRET = 'invite-token-SECRET99';
const SECRET_MESSAGE = {
  subject: "You've been invited to collaborate on Know-N",
  textBody: `Ada invited you to collaborate on Notes as Editor.\n\nOpen ${INVITE_SECRET}\n\n— Know-N`,
  htmlBody: `<p>Ada invited you to collaborate on Notes as Editor.</p><p>${INVITE_SECRET}</p><p>— Know-N</p>`,
};
// The unified chrome strips the duplicate trailing "— Know-N" signature from
// inner copy (the envelope lockup already names the product).
const SECRET_MESSAGE_WRAPPED_TEXT = `Ada invited you to collaborate on Notes as Editor.\n\nOpen ${INVITE_SECRET}`;
const SECRET_MESSAGE_WRAPPED_HTML = `<p>Ada invited you to collaborate on Notes as Editor.</p><p>${INVITE_SECRET}</p>`;

function splitAroundInner(wrapped: string, inner: string): { header: string; footer: string } {
  const start = wrapped.indexOf(inner);
  assert.ok(start >= 0, 'inner fragment must appear unchanged in the wrap');
  return {
    header: wrapped.slice(0, start),
    footer: wrapped.slice(start + inner.length),
  };
}

describe('MAIL-01 invite adapter unified skin', () => {
  test('default skins wrap html with the unified marker (R7-31)', async () => {
    const sink = createInviteEmailMailboxSink();
    const sender = createInviteEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const result = await sender.sendInviteEmail(sendInput());
    assert.equal(result.outcome, 'queued');
    assert.match(sink.entries[0]?.htmlBody ?? '', /data-known-email-skin/u);
  });

  test('explicit purpose opt-out keeps inner html without the unified marker', async () => {
    const sink = createInviteEmailMailboxSink();
    const sender = createInviteEmailAdapter({
      provider: sink.provider,
      logger: createLogger('silent'),
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'purpose' }),
    });
    const result = await sender.sendInviteEmail(sendInput());
    assert.equal(result.outcome, 'queued');
    assert.doesNotMatch(sink.entries[0]?.htmlBody ?? '', /data-known-email-skin/u);
    assert.equal(sink.entries[0]?.htmlBody, MESSAGE.htmlBody);
  });

  test('unified collaboration-invite html has chrome marker; invite secret stays out of header/footer', async () => {
    const sink = createInviteEmailMailboxSink();
    const sender = createInviteEmailAdapter({
      provider: sink.provider,
      logger: createLogger('silent'),
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_COLLABORATION_INVITE: 'unified' }),
    });
    const result = await sender.sendInviteEmail({
      to: RECIPIENT,
      message: SECRET_MESSAGE,
      idempotencyKey: 'delivery-key-unified',
    });
    assert.equal(result.outcome, 'queued');
    const html = sink.entries[0]?.htmlBody ?? '';
    const text = sink.entries[0]?.textBody ?? '';
    assert.match(html, new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    assert.doesNotMatch(sink.entries[0]?.subject ?? '', new RegExp(INVITE_SECRET, 'u'));
    const htmlParts = splitAroundInner(html, SECRET_MESSAGE_WRAPPED_HTML);
    assert.doesNotMatch(htmlParts.header, new RegExp(INVITE_SECRET, 'u'));
    assert.doesNotMatch(htmlParts.footer, new RegExp(INVITE_SECRET, 'u'));
    assert.doesNotMatch(htmlParts.header, /unsubscribe/iu);
    assert.doesNotMatch(htmlParts.footer, /unsubscribe/iu);
    const textParts = splitAroundInner(text, SECRET_MESSAGE_WRAPPED_TEXT);
    assert.doesNotMatch(textParts.header, new RegExp(INVITE_SECRET, 'u'));
    assert.doesNotMatch(textParts.footer, new RegExp(INVITE_SECRET, 'u'));
  });

  test('wrap after subject > 100 refuses send with a static reason and does not truncate', async () => {
    const sink = createInviteEmailMailboxSink();
    const sender = createInviteEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const longSubject = 'K'.repeat(101);
    const result = await sender.sendInviteEmail({
      to: RECIPIENT,
      message: { ...MESSAGE, subject: longSubject },
      idempotencyKey: 'delivery-over-budget',
    });
    assert.equal(result.outcome, 'email_delivery_unavailable');
    assert.equal(sink.sentCount, 0);
    assert.match(unavailableReason(result), /wrap exceeded the delivery budget/u);
    assert.doesNotMatch(unavailableReason(result), new RegExp(longSubject.slice(0, 8), 'u'));
    assert.doesNotMatch(unavailableReason(result), /invitee-redact/u);
  });

  test('composeInviteEmailAdapter threads skins so unified wrap reaches the mailbox', async () => {
    const sink = createInviteEmailMailboxSink();
    const composition = composeInviteEmailAdapter({
      enabled: true,
      nodeEnv: 'test',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
        timeoutMs: 10_000,
        tagPrefix: 'known-invite-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved in test mode');
      },
      logger: createLogger('silent'),
      inProcessSink: sink,
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_COLLABORATION_INVITE: 'unified' }),
    });
    try {
      const result = await composition.sender.sendInviteEmail({
        to: RECIPIENT,
        message: SECRET_MESSAGE,
        idempotencyKey: 'delivery-compose-unified',
      });
      assert.equal(result.outcome, 'queued');
      assert.match(sink.entries[0]?.htmlBody ?? '', new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    } finally {
      await composition.close();
    }
  });
});
