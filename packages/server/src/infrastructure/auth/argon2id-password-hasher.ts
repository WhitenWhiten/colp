import * as argon2 from '@node-rs/argon2';
import {
  PASSWORD_HASH_ARGON2ID_PARAMS,
  verifyArgon2idHash,
  type PasswordHasher,
} from '../../modules/auth/index.js';

/**
 * Task C2 Argon2id password hasher (infrastructure layer).
 *
 * The ONLY production implementation of the modules/auth PasswordHasher port.
 * The frozen parameters (m=19456, t=2, p=1) live in the port contract
 * (modules/auth/application/password-hasher.ts) and are written into the
 * config contract by better-auth-config.ts; the better-auth default scrypt is
 * never used (G1 §2, spike §4.4).
 *
 * Output format: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` — the
 * parameters are embedded in the PHC string and every verify is a REAL
 * Argon2id verify (constant-time, never a string compare).
 */

/** Build the frozen Argon2id hasher (stateless; safe to share). */
export function createArgon2idPasswordHasher(): PasswordHasher {
  return Object.freeze({
    async hash(password: string): Promise<string> {
      return argon2.hash(password, PASSWORD_HASH_ARGON2ID_PARAMS);
    },
    // Shared fail-closed verify (same helper the module-layer config hook
    // uses), so the adapter and the production hook behave identically.
    verify: verifyArgon2idHash,
  });
}
