import { ClassificationError } from './classification-policy.js';

export interface ClassificationBillingConsent {
  readonly priceVersion: string;
  readonly maxPoints: number;
}

/** Consent binds command intent and is never part of model input. */
export function parseClassificationBillingConsent(value: unknown): ClassificationBillingConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClassificationError('invalid_input');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'priceVersion') || !Object.hasOwn(record, 'maxPoints')
    || typeof record.priceVersion !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(record.priceVersion)
    || typeof record.maxPoints !== 'number' || !Number.isInteger(record.maxPoints)
    || record.maxPoints < 0 || record.maxPoints > 2_147_483_647) throw new ClassificationError('invalid_input');
  return { priceVersion: record.priceVersion, maxPoints: record.maxPoints };
}
