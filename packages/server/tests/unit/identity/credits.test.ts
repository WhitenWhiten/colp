import { describe, expect, test } from 'vitest';
import { checkClassificationCreditConsent, CreditError } from '../../../src/modules/identity/index.js';
import { rethrowCreditError } from '../../../src/infrastructure/identity/credit-errors.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';

describe('classification financial consent and failure boundaries', () => {
  test('consent and price precede limits and funds, preserving the locked quote', () => {
    expect(checkClassificationCreditConsent(undefined, 50, 0)?.code).toBe('billing_consent_required');
    expect(checkClassificationCreditConsent({ priceVersion: 'old.v1', maxPoints: 1 }, 50, 0))
      .toMatchObject({ code: 'credit_price_changed', creditContext: {
        requiredPoints: 50, availablePoints: 0, maxPoints: 1, priceVersion: 'bookmark-classify.v1',
      } });
    expect(checkClassificationCreditConsent({ priceVersion: 'bookmark-classify.v1', maxPoints: 1 }, 50, 0)?.code)
      .toBe('credit_limit_exceeded');
    expect(checkClassificationCreditConsent({ priceVersion: 'bookmark-classify.v1', maxPoints: 50 }, 50, 49)?.code)
      .toBe('insufficient_credits');
    expect(checkClassificationCreditConsent({ priceVersion: 'bookmark-classify.v1', maxPoints: 50 }, 3, 3)).toBeNull();
  });

  test('invalid ledger facts fail closed rather than authorizing model work', () => {
    for (const balance of [-1, Number.NaN, 2_147_483_648]) {
      expect(() => checkClassificationCreditConsent(undefined, 1, balance)).toThrow(CreditError);
    }
  });

  test('unknown commit cannot be mistaken for rollback or insufficient credit', () => {
    const cause = new Error('private database detail');
    expect(() => rethrowCreditError(new DatabaseOperationError('commit_outcome_unknown', cause)))
      .toThrow('credits_unavailable');
    expect(() => rethrowCreditError({ code: '55P03' })).toThrow('credits_busy');
    expect(() => rethrowCreditError({ code: 'P0001', message: 'credit_reconciliation_required' }))
      .toThrow('credits_reconciling');
    expect(() => rethrowCreditError({ code: '23514', message: 'private constraint detail' }))
      .toThrow('credits_unavailable');
  });
});
