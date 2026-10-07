/**
 * Shared Better Auth code → product envelope table (C-05).
 * Unit translate tests and integration BA-bridge tests must import this
 * instead of duplicating status/code/message.
 */
export const BETTER_AUTH_PRODUCT_WIRE = Object.freeze({
  INVALID_EMAIL_OR_PASSWORD: Object.freeze({
    productCode: 'invalid_credentials',
    statusCode: 401,
    message: 'The email or password is incorrect.',
  }),
  USER_ALREADY_EXISTS: Object.freeze({
    productCode: 'invalid_credentials',
    statusCode: 401,
    message: 'The email or password is incorrect.',
  }),
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: Object.freeze({
    productCode: 'invalid_credentials',
    statusCode: 401,
    message: 'The email or password is incorrect.',
  }),
  EMAIL_NOT_VERIFIED: Object.freeze({
    productCode: 'verification_required',
    statusCode: 403,
    message: 'Email verification is required to complete this action.',
  }),
  UNAUTHORIZED: Object.freeze({
    productCode: 'authentication_required',
    statusCode: 401,
    message: 'Authentication is required.',
  }),
  SESSION_REQUIRED: Object.freeze({
    productCode: 'authentication_required',
    statusCode: 401,
    message: 'Authentication is required.',
  }),
  INVALID_ORIGIN: Object.freeze({
    productCode: 'csrf_failed',
    statusCode: 403,
    message: 'The request failed CSRF or Origin validation.',
  }),
  MISSING_OR_NULL_ORIGIN: Object.freeze({
    productCode: 'csrf_failed',
    statusCode: 403,
    message: 'The request failed CSRF or Origin validation.',
  }),
  SOCIAL_ACCOUNT_ALREADY_LINKED: Object.freeze({
    productCode: 'account_link_required',
    statusCode: 403,
    message: 'This account must be linked explicitly before it can be used.',
  }),
  LINKED_ACCOUNT_ALREADY_EXISTS: Object.freeze({
    productCode: 'account_link_required',
    statusCode: 403,
    message: 'This account must be linked explicitly before it can be used.',
  }),
  VERIFICATION_EMAIL_NOT_ENABLED: Object.freeze({
    productCode: 'email_delivery_unavailable',
    statusCode: 503,
    message: 'Email delivery is temporarily unavailable. Please try again later.',
  }),
  RESET_PASSWORD_DISABLED: Object.freeze({
    productCode: 'email_delivery_unavailable',
    statusCode: 503,
    message: 'Email delivery is temporarily unavailable. Please try again later.',
  }),
  TOO_MANY_REQUESTS: Object.freeze({
    productCode: 'rate_limited',
    statusCode: 429,
    message: 'Too many requests. Please try again later.',
  }),
  INVALID_OTP: Object.freeze({
    productCode: 'invalid_request',
    statusCode: 400,
    message: 'That code did not work. Try again.',
  }),
  OTP_EXPIRED: Object.freeze({
    productCode: 'invalid_request',
    statusCode: 400,
    message: 'That code has expired. Request a new one.',
  }),
  TOO_MANY_ATTEMPTS: Object.freeze({
    productCode: 'rate_limited',
    statusCode: 429,
    message: 'Too many requests. Please try again later.',
  }),
} as const);

export type BetterAuthProductWireCode = keyof typeof BETTER_AUTH_PRODUCT_WIRE;
