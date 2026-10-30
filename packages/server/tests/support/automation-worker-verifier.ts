import type { JWK } from 'jose';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../src/infrastructure/auth/account-credentials-postgres.js';
import { loadCredentialAuthority, resolveMachineMcpBinding } from '../../src/modules/auth/index.js';
import { createMcpOauthVerifier, MCP_OAUTH_DEFAULT_SECURITY_EPOCH } from '../../src/modules/mcp/index.js';
import { createPostgresMcpOauthRevocationStore } from '../../src/infrastructure/database/index.js';

/** The same real credential/epoch/revocation verifier in parent and restarted process fixtures. */
export function automationWorkerVerifier(db: Kysely<DatabaseSchema>, jwk: JWK, origin: string, machineMode: boolean) {
  const credentials = createPostgresAccountCredentialUnitOfWork(db);
  const revocations = createPostgresMcpOauthRevocationStore({ db });
  const verifier = createMcpOauthVerifier({ issuer: origin+'/api/v1/auth',audience: origin+'/collections/-/mcp',
    allowedScopes: ['automation:work','automation:read','automation:manage','mcp:read:own','nodes:write'],
    jwks: { getKeySet: async () => ({ keys: [jwk] }) },securityEpoch: async () => MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
    isRevoked: input => revocations.isRevoked(input),requireAccountEpoch: true,clockToleranceSeconds: 0,
    ...(machineMode ? { machine: { kids: new Set([String(jwk.kid)]),bind: (input: Parameters<typeof resolveMachineMcpBinding>[0]) => resolveMachineMcpBinding({ ...input,load: id => credentials.execute(p => loadCredentialAuthority(p,id)) }) } } : {}),
    resolveAccountBySubject: async sub => { const a = await db.selectFrom('accounts').selectAll().where('subject_id','=',sub).executeTakeFirst();
      return a ? { id: a.id,subjectId: a.subject_id,status: a.status,securityEpoch: String(a.security_epoch) } : null; },
    readAccountSecurityBoundary: async id => { const a = await db.selectFrom('accounts').selectAll().where('id','=',id).executeTakeFirst();
      return a ? { status: a.status,securityEpoch: String(a.security_epoch),bumpedAt: a.security_epoch_bumped_at } : null; },
  });
  return { verifier,revocations };
}
