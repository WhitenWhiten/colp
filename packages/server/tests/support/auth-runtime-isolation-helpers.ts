export const F3_TRUSTED_ORIGIN = 'https://app.example.test';
export const F3_SESSION_COOKIE_NAME = '__Host-known_session';
export const F3_PASSWORD = 'password-123'; // secret-scan: allow 'password-123'

export function f3TestEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: F3_TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: F3_TRUSTED_ORIGIN,
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    BETTER_AUTH_OTP_TTL_SECONDS: '300',
    AUTH_RATE_LIMIT_MAX: '1000000',
  };
}

export function f3SessionCookieOf(res: { cookies?: unknown }): string | null {
  const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
  return cookies.find((cookie) => cookie.name === F3_SESSION_COOKIE_NAME)?.value ?? null;
}

export function f3CookieHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}
