export const P3_16_PUSH_OUTCOMES = Object.freeze([
  'applied',
  'rebased',
  'noop',
  'conflicted',
  'rejected',
  'deferred',
  'sequence_gap',
  'sequence_blocked',
  'sequence_reuse',
  'op_id_reused',
  'service_unavailable',
  'internal_error',
] as const);

export const P3_16_SEQUENCE_RECOVERY = Object.freeze({
  sequence_gap: Object.freeze({ status: 409, expectedSequence: 1, action: 'fill_gap' as const }),
  sequence_blocked: Object.freeze({ status: 409, expectedSequence: 1, action: 'retry_deferred' as const }),
  service_unavailable: Object.freeze({ status: 503, action: 'same_request' as const }),
});

export const P3_16_FORBIDDEN_METRIC_MARKERS = Object.freeze([
  'replica-', 'operation-', 'bookmark title', 'https://', 'bearer ', 'token-',
]);
