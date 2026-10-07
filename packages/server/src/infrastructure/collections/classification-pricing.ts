export interface ClassificationPricingPolicy {
  readonly reservationMicrousd: bigint;
  readonly tokenRateMicrousd: number;
}

export const DEFAULT_CLASSIFICATION_PRICING: ClassificationPricingPolicy = Object.freeze({
  reservationMicrousd: 2000n,
  tokenRateMicrousd: 0.042,
});

/**
 * Calculates settled micro-USD from input token count without surcharge multiplier.
 * Fallback to full reservation cost when token count is unavailable.
 */
export function calculateClassificationSettledMicrousd(
  inputTokens: number | null,
  pricing: ClassificationPricingPolicy = DEFAULT_CLASSIFICATION_PRICING,
): number {
  if (inputTokens === null) return Number(pricing.reservationMicrousd);
  return Math.ceil(inputTokens * pricing.tokenRateMicrousd);
}
