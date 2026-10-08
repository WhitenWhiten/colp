import {
  createBetterAuthSessionTokenProtector,
  type BetterAuthSessionTokenProtectionOptions,
} from '../../src/infrastructure/auth/better-auth-session-token-protection.js';

export const TEST_SESSION_TOKEN_PROTECTION: BetterAuthSessionTokenProtectionOptions = Object.freeze({
  keys: Object.freeze([
    Object.freeze({ version: 1, key: Buffer.alloc(32, 0x73) }),
  ]),
  legacyPlaintextReadUntil: new Date('2100-01-01T00:00:00.000Z'),
});

export function createTestSessionTokenProtector() {
  return createBetterAuthSessionTokenProtector(TEST_SESSION_TOKEN_PROTECTION);
}

