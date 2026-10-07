import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  closeDeliveryRuntimeResources,
  createDeliverySecretResolver,
  loadDeliveryProcessConfig,
  resolveDeliveryRateLimitKeySecret,
} from '../../../src/bootstrap/delivery-main.js';
import { deliveryProcessEnv } from '../../support/phase4a-l049-delivery-rate-limit.js';

const SECRET_ENV_KEYS = [
  'ATTACHMENTS_R2_PRIMARY_ACCESS_KEY_ID',
  'ATTACHMENTS_R2_PRIMARY_SECRET_ACCESS_KEY',
  'ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY',
  'ATTACHMENTS_RATE_LIMIT_KEY_SECRET_HMAC',
] as const;

afterEach(() => {
  for (const key of SECRET_ENV_KEYS) delete process.env[key];
});

test('delivery cleanup closes Redis and PostgreSQL after an HTTP host failure', async () => {
  const calls: string[] = [];
  const close = (resource: string, fails = false) => async (): Promise<void> => {
    calls.push(resource);
    if (fails) throw new Error(`${resource} failed`);
  };

  let reported: unknown;
  try {
    await closeDeliveryRuntimeResources({
      host: { close: close('host', true) },
      requestLimiter: { close: close('requestLimiter', true) },
      pool: { end: close('pool') },
    });
  } catch (error: unknown) {
    reported = error;
  }

  assert.deepEqual(calls, ['host', 'requestLimiter', 'pool']);
  assert.ok(reported instanceof AggregateError);
  assert.equal(reported.errors.length, 2);
  assert.match(reported.message, /host, requestLimiter/u);
});

test('delivery cleanup succeeds when optional resources were not composed', async () => {
  let poolCloses = 0;
  await closeDeliveryRuntimeResources({
    pool: { end: async () => { poolCloses += 1; } },
  });
  assert.equal(poolCloses, 1);
});

test('delivery secret resolver exposes only RO and capability values and rejects every other ref', async () => {
  const attachments = loadDeliveryProcessConfig(deliveryProcessEnv()).attachments;
  const resolveSecret = createDeliverySecretResolver(attachments);
  await assert.rejects(
    resolveSecret(attachments.r2.rwSecretRef),
    /R2 RW secret reference must never be resolved/u,
  );
  await assert.rejects(resolveSecret(attachments.r2.roSecretRef), /ATTACHMENTS_R2_PRIMARY/u);
  process.env.ATTACHMENTS_R2_PRIMARY_ACCESS_KEY_ID = '  delivery-read-id  ';
  process.env.ATTACHMENTS_R2_PRIMARY_SECRET_ACCESS_KEY = '  delivery-read-secret  ';
  assert.deepEqual(await resolveSecret(attachments.r2.roSecretRef), {
    accessKeyId: 'delivery-read-id',
    secretAccessKey: 'delivery-read-secret',
  });
  await assert.rejects(
    resolveSecret(attachments.deliveryCapabilitySecretRef),
    /ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY/u,
  );
  process.env.ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY = '  capability-secret  ';
  assert.equal(await resolveSecret(attachments.deliveryCapabilitySecretRef), 'capability-secret');
  await assert.rejects(resolveSecret('known/unknown/ref'), /unknown secret ref/u);
});

test('delivery shared rate-limit secret resolver fails closed and trims key material', async () => {
  await assert.rejects(resolveDeliveryRateLimitKeySecret('///'), /invalid rate-limit key secret ref/u);
  await assert.rejects(
    resolveDeliveryRateLimitKeySecret('known/delivery/ratelimit/hmac'),
    /ATTACHMENTS_RATE_LIMIT_KEY_SECRET_HMAC/u,
  );
  process.env.ATTACHMENTS_RATE_LIMIT_KEY_SECRET_HMAC = '  delivery-rate-limit-secret  ';
  assert.equal(
    (await resolveDeliveryRateLimitKeySecret('known/delivery/ratelimit/hmac')).toString('utf8'),
    'delivery-rate-limit-secret',
  );
});
