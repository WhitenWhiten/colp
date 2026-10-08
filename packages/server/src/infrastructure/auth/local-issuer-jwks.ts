import { sql, type Kysely } from 'kysely';
import type { JWK } from 'jose';
import type { DatabaseSchema } from '../database/index.js';
import type { JwksProvider } from '../../modules/identity/index.js';

/** The built-in issuer shares our database; verifying it needs no public-origin request. */
export function createLocalIssuerJwks(db: Kysely<DatabaseSchema>, machineKeys: readonly JWK[]): JwksProvider {
  return {
    async getKeySet() {
      // Match Better Auth's default 30-day verification grace after key rotation.
      const result = await sql<{ id: string; publicKey: string; alg: string | null; crv: string | null }>`
        SELECT id, "publicKey", alg, crv FROM auth_jwks
        WHERE "expiresAt" IS NULL OR "expiresAt" + interval '30 days' > current_timestamp
      `.execute(db);
      const keys = result.rows.map((row): JWK => {
        const key = JSON.parse(row.publicKey) as JWK;
        if (!key || typeof key !== 'object' || Array.isArray(key) || 'd' in key || 'k' in key) {
          throw new Error('The issuer public key is invalid.');
        }
        return { alg: row.alg ?? 'RS256', ...(row.crv ? { crv: row.crv } : {}), ...key, kid: row.id };
      });
      return { keys: [...keys, ...machineKeys] };
    },
  };
}
