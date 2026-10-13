import { createHmac } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createWebhookCipher, signWebhook, webhookSecret } from '../../../src/infrastructure/automation/webhook-signer.js';
import { createWebhookVerifier } from '../../../src/infrastructure/automation/webhook-verifier.js';
const secret = 'whsec_'+Buffer.alloc(32,3).toString('base64'),old = 'whsec_'+Buffer.alloc(32,4).toString('base64');
test('exact bytes and stable event id, fresh timestamp, bounded dual signing', () => {
  const input = { id: 'evt',subscriptionId: 'sub',body: '{"x":"é"}',secret,previous: { secret: old,until: new Date(200_000) } };
  const first = signWebhook({ ...input,now: new Date(100_000) }),retry = signWebhook({ ...input,now: new Date(201_000) });
  const expected = createHmac('sha256',Buffer.alloc(32,3)).update('evt.100.{"x":"é"}').digest('base64');
  expect(first['webhook-signature']?.split(' ')[0]).toBe('v1,'+expected);
  expect(first['webhook-signature']?.split(' ')).toHaveLength(2);
  expect(retry['webhook-signature']?.split(' ')).toHaveLength(1);
  expect(first['webhook-id']).toBe(retry['webhook-id']);expect(first['webhook-signature']).not.toBe(retry['webhook-signature']);
});
test('authenticated encrypted secrets resist tampering and cross-subscription substitution', () => {
  const cipher=createWebhookCipher(Buffer.alloc(32,8)),stored=cipher.encrypt(secret,'sub');
  expect(stored).not.toContain(secret);expect(cipher.decrypt(stored,'sub')).toBe(secret);
  expect(() => cipher.decrypt(stored,'other')).toThrow('Webhook secret is unavailable.');
  expect(() => createWebhookCipher(Buffer.alloc(32,9)).decrypt(stored,'sub')).toThrow();
  expect(() => webhookSecret('whsec_'+Buffer.alloc(23).toString('base64'))).toThrow();
  expect(() => webhookSecret('whsec_'+Buffer.alloc(65).toString('base64'))).toThrow();
  expect(webhookSecret('whsec_'+Buffer.alloc(24).toString('base64'))).toHaveLength(24);
  expect(webhookSecret('whsec_'+Buffer.alloc(64).toString('base64'))).toHaveLength(64);
});
test('challenge uses pinned HTTPS, exact echo and only generated signature headers',async () => {
  const connect=vi.fn(async (target,init) => {
    expect(target.ip).toBe('8.8.8.8');expect(target.url.hostname).toBe('receiver.example');
    const headers=new Headers(init.headers);expect(headers.has('authorization')).toBe(false);expect(headers.has('cookie')).toBe(false);
    expect(headers.get('x-mcp-subscription-id')).toBe('sub');expect(init.redirect).toBe('manual');
    const body=JSON.parse(String(init.body));expect(body.type).toBe('verification');
    return Response.json({ challenge: body.challenge });
  });
  const verifier=createWebhookVerifier(Buffer.alloc(32,8),{ resolve: async () => ['8.8.8.8'],connect });
  await verifier.verify({ id: 'sub',url: 'https://receiver.example/hook',secret });expect(connect).toHaveBeenCalledTimes(1);
});
test('mixed/private DNS and redirects are blocked; challenge mismatch and oversized response fail',async () => {
  const connect=vi.fn(async () => Response.json({ challenge: 'wrong' }));
  const denied=createWebhookVerifier(Buffer.alloc(32),{ resolve: async () => ['8.8.8.8','127.0.0.1'],connect });
  await expect(denied.verify({ id: 'sub',url: 'https://receiver.example',secret })).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
  for (const response of [new Response(null,{ status: 302,headers: { location: 'https://another.example' } }),Response.json({ challenge: 'wrong' }),new Response('x'.repeat(8193)),new Response(null,{ status: 204 })]) {
    const call=vi.fn(async () => response),v=createWebhookVerifier(Buffer.alloc(32),{ resolve: async () => ['8.8.8.8'],connect: call });
    await expect(v.verify({ id: 'sub',url: 'https://receiver.example',secret })).rejects.toThrow();expect(call).toHaveBeenCalledTimes(1);
  }
});
