import { expect, test } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../../src/bootstrap/config-http-security.js';
import {
  CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS,
  classificationCreditTransactionTimeoutMs,
} from '../../../src/infrastructure/collections/classification-credit-transactions.js';
import {
  CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS,
  CLASSIFICATION_RUN_APPLY_ITEM_TIMEOUT_MS,
  CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS,
  classificationRunApplyTimeoutMs,
} from '../../../src/infrastructure/collections/classification-run-billing.js';

test('the hot credit paths keep the tight default transaction bound', () => {
  expect(CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS).toBe(2_000);
});

test('a caller may raise the transaction budget but never lower it', () => {
  expect(classificationCreditTransactionTimeoutMs()).toBe(CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS);
  expect(classificationCreditTransactionTimeoutMs(5_000)).toBe(5_000);
  for (const ignored of [0, 500, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(classificationCreditTransactionTimeoutMs(ignored)).toBe(CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS);
  }
});

test('the run-apply budget grows with the admitted document and stays capped', () => {
  // A measured max-size apply (50 items, ~128-256 KiB escaped body) took 2936 ms
  // on developer hardware, so the 2 s credit default cannot serve the request the
  // route itself admits (`bodyLimitBytes: 256 * 1024`, `maxItems: 50`).
  expect(classificationRunApplyTimeoutMs(0)).toBe(CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS);
  expect(classificationRunApplyTimeoutMs(1)).toBe(CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS + CLASSIFICATION_RUN_APPLY_ITEM_TIMEOUT_MS);
  expect(classificationRunApplyTimeoutMs(50)).toBe(CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS + 50 * CLASSIFICATION_RUN_APPLY_ITEM_TIMEOUT_MS);
  expect(classificationRunApplyTimeoutMs(50)).toBeGreaterThan(2_936);
  expect(classificationRunApplyTimeoutMs(50)).toBeLessThan(CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS);

  // A malformed or hostile selection count can never exceed the cap.
  expect(classificationRunApplyTimeoutMs(1_000_000)).toBe(CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS);
  for (const malformed of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(classificationRunApplyTimeoutMs(malformed)).toBe(CLASSIFICATION_RUN_APPLY_BASE_TIMEOUT_MS);
  }

  // The cap stays below the shipped HTTP request timeout, so a default
  // deployment always lets the largest admitted apply finish the transaction it
  // opened instead of being cut off at the HTTP layer. A deployment that lowers
  // HTTP_REQUEST_TIMEOUT_MS below the cap truncates it by configuration; that
  // constraint is documented next to the variable in .env.example and in
  // docs/classification-execution.md.
  expect(CLASSIFICATION_RUN_APPLY_MAX_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
  expect(classificationRunApplyTimeoutMs(50)).toBeGreaterThan(CLASSIFICATION_CREDIT_TRANSACTION_TIMEOUT_MS);
});
