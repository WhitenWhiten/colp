/**
 * Auth module public facade.
 *
 * C1 owns the authentication email surface (port + templates); A2 owns the
 * business-account mapping surface (business-account-mapping.ts +
 * ensure-business-account.ts, in the same directory); C2 owns the token
 * policy (auth-token-policy.ts) and the password hasher port
 * (password-hasher.ts); A3 owns the browser session authority surface
 * (ports.ts + browser-session-authority.ts); C4 owns the security epoch
 * bridge (security-epoch-bridge.ts) and the MFA policy surface
 * (mfa-policy.ts). This facade is shared: it
 * re-exports ALL surfaces so infrastructure adapters (infrastructure/auth
 * and infrastructure/email) and transport consume facade-only edges. EXTEND
 * this file when adding auth module surfaces; do not recreate it.
 */
export * from './application/auth-email-templates.js';
export * from './application/auth-email-port.js';
export * from './application/auth-token-policy.js';
export * from './application/password-hasher.js';
export * from './application/business-account-mapping.js';
export * from './application/ensure-business-account.js';
export * from './application/ports.js';
export * from './application/browser-session-authority.js';
export * from './application/account-linking.js';
export * from './application/account-deletion.js';
export * from './application/oauth-occupancy-adopt.js';
export * from './application/account-issuer.js';
export * from './application/account-recovery.js';
export * from './application/security-epoch-bridge.js';
export * from './application/provider-link-epoch.js';
export * from './application/mfa-policy.js';
export * from './application/account-credentials/index.js';
