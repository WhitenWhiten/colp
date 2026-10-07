/** Shared environment fixtures for the seed lifecycle integration suite. */

export const SEED_BA_SECRET = 'seed-test-better-auth-secret-0123456789abcdef';
export const SEED_DEMO_PASSWORD = 'demo-password-123'; // secret-scan: allow 'demo-password-123'
export const SEED_TRUSTED_ORIGIN = 'https://app.example.test';

/** Seed/auth 阶段使用的环境（auth.ts 通过 loadConfig(env) 解析 BA 配置与 demo 密码）。 */
export function seedEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // seed/demo/auth.ts 走生产 loader，而本套件不提供私有 EXPORT_R2_*。
    // 与 tests/support/test-config.ts 的隔离口径一致（见 library-export 合并评审）。
    KNOWN_FEATURE_EXPORT_JOBS: 'false',
    PRODUCT_ORIGIN: SEED_TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: SEED_TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: SEED_BA_SECRET,
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'false',
    KNOWN_DEMO_PASSWORD: SEED_DEMO_PASSWORD,
  };
}

/** 产品 app 环境（与 A3 browser-session-authority 套件同构：authority 显式注入）。 */
export function appEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // 同样经生产 loadConfig 解析，且不提供 EXPORT_R2_*。
    KNOWN_FEATURE_EXPORT_JOBS: 'false',
    PRODUCT_ORIGIN: SEED_TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: SEED_TRUSTED_ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${SEED_TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  };
}
