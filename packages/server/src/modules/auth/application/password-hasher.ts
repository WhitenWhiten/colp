/**
 * Task C2 password hasher port (application layer leaf).
 *
 * The better-auth default password hash is scrypt and MUST NOT be used
 * (plan §1.2; G1 ADR §2; spike §1/§4.4). Every password hash/verify in the
 * local auth flows goes through this port, implemented by the Argon2id
 * adapter (infrastructure/auth/argon2id-password-hasher.ts) and mirrored by
 * the module-layer config hook with the SAME frozen parameters below.
 *
 * Frozen contract (G1 ADR §2, spike §4.4): Argon2id with m=19456, t=2, p=1,
 * output `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`; the parameters are
 * embedded in the PHC string, so the contract is self-describing and the
 * verify path is a REAL Argon2id verify (never a string compare).
 */
import * as argon2 from '@node-rs/argon2';

/** Argon2id algorithm selector for @node-rs/argon2 (2 = Argon2id). */
export const ARGON2ID_ALGORITHM = 2 as const;

/**
 * Frozen Argon2id parameters verified against Better Auth 1.6.29
 * (spike §4.4): `$argon2id$v=19$m=19456,t=2,p=1$...`.
 */
export const PASSWORD_HASH_ARGON2ID_PARAMS = Object.freeze({
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** PHC prefix of every hash produced by the frozen parameters. */
export const ARGON2ID_HASH_PREFIX = '$argon2id$' as const;

/**
 * Fail-closed Argon2id verify shared by the module-layer config hook and the
 * infrastructure adapter: a malformed/foreign hash returns `false` (never
 * throws), so the sign-in path turns it into the same 401 as a wrong
 * password. Every verify is a REAL Argon2id verify (constant-time, never a
 * string compare).
 */
export async function verifyArgon2idHash(input: {
  readonly hash: string;
  readonly password: string;
}): Promise<boolean> {
  try {
    return await argon2.verify(input.hash, input.password);
  } catch {
    // Fail closed: an unparseable/foreign hash is a wrong password.
    return false;
  }
}

/**
 * Password hasher port matching the better-auth emailAndPassword.password
 * hook contract (spike §4.4): `hash(password)` and
 * `verify({ hash, password })`.
 */
export interface PasswordHasher {
  readonly hash: (password: string) => Promise<string>;
  readonly verify: (input: { readonly hash: string; readonly password: string }) => Promise<boolean>;
}
