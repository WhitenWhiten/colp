import { isCanonicalProductPublicCollectionSlug } from '../../publication/index.js';
import { assertReportSlug } from '../domain/index.js';

/** Shared transport/application adapter: Product owns the canonical slug predicate. */
export function assertCanonicalReportSlug(value: string): string {
  return assertReportSlug(value, isCanonicalProductPublicCollectionSlug);
}
