/**
 * Task E1 contract tests for the authentication test mailbox (plan §11 E1
 * step 3): NODE_ENV=test gate, purpose/email/test-id lookup over the last
 * delivered mail, digest-only idempotency matching and OTP extraction.
 *
 * 假阴性防护: purpose lookup matches the REAL `authEmailIdempotencyKey`
 * digest contract (the same key the C1 adapter forwards to the provider), so
 * a purpose mismatch is caught exactly like production would separate them.
 *
 * 假阳性防护: the mailbox works with ZERO provider credential environment
 * (no DirectMail/Google/GitHub secret can be involved), and entries never
 * expose credential-shaped fields.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { authEmailIdempotencyKey } from '../../../src/modules/auth/index.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';

function deliver(
  mailbox: ReturnType<typeof createAuthTestMailbox>,
  input: { readonly scope: string; readonly email: string; readonly textBody: string; readonly subject?: string },
): void {
  void mailbox.provider.send({
    idempotencyKey: authEmailIdempotencyKey(input.scope, input.email),
    message: {
      to: input.email,
      subject: input.subject ?? 'Know-N auth mail',
      textBody: input.textBody,
    },
  });
}

test('refuses construction outside NODE_ENV=test', () => {
  assert.throws(
    () => createAuthTestMailbox({ env: { NODE_ENV: 'production' } }),
    /only available under NODE_ENV=test/u,
  );
  assert.throws(
    () => createAuthTestMailbox({ env: { NODE_ENV: 'development' } }),
    /only available under NODE_ENV=test/u,
  );
});

test('records deliveries and reads the LAST mail by email', () => {
  const mailbox = createAuthTestMailbox();
  deliver(mailbox, { scope: 'otp:sign-in', email: 'a@example.test', textBody: 'code 111111' });
  deliver(mailbox, { scope: 'otp:sign-in', email: 'a@example.test', textBody: 'code 222222' });
  deliver(mailbox, { scope: 'otp:sign-in', email: 'b@example.test', textBody: 'code 333333' });

  assert.equal(mailbox.sentCount, 3);
  assert.equal(mailbox.entries.length, 3);
  const last = mailbox.lastMailFor({ email: 'a@example.test' });
  assert.ok(last);
  assert.equal(last!.id, 'mail-2');
  assert.match(last!.textBody, /222222/u);
  assert.equal(mailbox.lastMailFor({ email: 'nobody@example.test' }), null);
});

test('purpose lookup matches the REAL digest idempotency key and never collides across purposes', () => {
  const mailbox = createAuthTestMailbox();
  const email = 'purposes@example.test';
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'sign-in code 111111' });
  deliver(mailbox, { scope: 'otp:forget-password', email, textBody: 'reset code 222222' });

  const signIn = mailbox.lastMailFor({ email, purpose: 'otp:sign-in' });
  const forget = mailbox.lastMailFor({ email, purpose: 'otp:forget-password' });
  assert.ok(signIn && forget);
  assert.equal(signIn!.textBody, 'sign-in code 111111');
  assert.equal(forget!.textBody, 'reset code 222222');
  assert.notEqual(signIn!.idempotencyKey, forget!.idempotencyKey);
  // The stored key is the digest contract, never the raw scope/recipient.
  assert.equal(signIn!.idempotencyKey, authEmailIdempotencyKey('otp:sign-in', email));
  assert.equal(signIn!.idempotencyKey.includes(email), false);

  // The LAST mail per purpose wins even when deliveries interleave.
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'sign-in code 444444' });
  assert.equal(mailbox.lastMailFor({ email, purpose: 'otp:sign-in' })!.textBody, 'sign-in code 444444');
  assert.equal(mailbox.lastMailFor({ email, purpose: 'otp:forget-password' })!.textBody, 'reset code 222222');
});

test('otpFor extracts the 6-digit code from the last matching mail', () => {
  const mailbox = createAuthTestMailbox();
  const email = 'otp@example.test';
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'Your code is 654321 and expires soon.' });
  assert.equal(mailbox.otpFor({ email, purpose: 'otp:sign-in' }), '654321');
  assert.equal(mailbox.otpFor({ email, purpose: 'otp:forget-password' }), null);
});

test('setTestId tags deliveries and testId filters read the per-test last mail', () => {
  const mailbox = createAuthTestMailbox();
  const email = 'shared@example.test';
  mailbox.setTestId('test-a');
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'code 111111' });
  mailbox.setTestId('test-b');
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'code 222222' });
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'code 333333' });
  mailbox.setTestId(null);
  deliver(mailbox, { scope: 'otp:sign-in', email, textBody: 'code 444444' });

  assert.equal(mailbox.lastMailFor({ email, testId: 'test-a' })!.textBody, 'code 111111');
  assert.equal(mailbox.lastMailFor({ email, testId: 'test-b' })!.textBody, 'code 333333');
  assert.equal(mailbox.lastMailFor({ email, testId: null })!.textBody, 'code 444444');
  assert.equal(mailbox.lastMailFor({ email })!.textBody, 'code 444444');
});

test('works with zero provider credential environment and exposes no credential-shaped fields', () => {
  // The mailbox is constructed with an empty env except NODE_ENV=test: no
  // DirectMail/Google/GitHub secret can be involved anywhere in the path.
  const mailbox = createAuthTestMailbox({ env: { NODE_ENV: 'test' } });
  deliver(mailbox, { scope: 'password-reset', email: 'reset@example.test', textBody: 'reset token abc' });
  const entry = mailbox.lastMailFor({ email: 'reset@example.test' });
  assert.ok(entry);
  for (const key of Object.keys(entry!)) {
    assert.match(key, /^(id|testId|idempotencyKey|to|subject|textBody|receivedAt)$/u, `unexpected entry field ${key}`);
  }
  assert.equal('accessKeyId' in entry!, false);
  assert.equal('accessKeySecret' in entry!, false);
  assert.equal(mailbox.provider.send.length, 1, 'the provider send must accept exactly the EmailSendInput shape');
});

test('reset clears deliveries, counters and the test tag', () => {
  const mailbox = createAuthTestMailbox();
  mailbox.setTestId('x');
  deliver(mailbox, { scope: 'otp:sign-in', email: 'r@example.test', textBody: 'code 111111' });
  mailbox.reset();
  assert.equal(mailbox.sentCount, 0);
  assert.equal(mailbox.entries.length, 0);
  assert.equal(mailbox.lastMailFor({ email: 'r@example.test' }), null);
});
