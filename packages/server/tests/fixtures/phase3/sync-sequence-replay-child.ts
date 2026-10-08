import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresSyncSequencePort } from '../../../src/infrastructure/sync/index.js';
import { verifyExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncSequenceAdmission, verifiedSequenceSession } from './sync-sequence.js';

const databaseUrl = process.env.KNOWN_TEST_DATABASE_URL;
const sessionId = process.env.KNOWN_SEQUENCE_SESSION_ID;
const replicaId = process.env.KNOWN_SEQUENCE_REPLICA_ID;
const authorityJson = process.env.KNOWN_SEQUENCE_AUTHORITY;
if (!databaseUrl || !sessionId || !replicaId || !authorityJson) {
  throw new Error('Sequence replay child environment is incomplete');
}

const encoded = JSON.parse(authorityJson) as {
  readonly authorization: string;
  readonly jwk: Parameters<typeof verifyExtensionCredentialFixture>[0]['jwk'];
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
};
const credential = await verifyExtensionCredentialFixture(encoded);

const runtime = createDatabaseRuntime(databaseUrl, {
  maxConnections: 1,
  applicationName: 'known-p3-sequence-replay-child',
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 1_000,
});

try {
  const session = await verifiedSequenceSession({
    sessionId,
    principalId: 'sequence-subject',
    collectionId: 'sequence-collection',
  });
  const replay = await createPostgresSyncSequencePort(runtime.db).coordinate(
    syncSequenceAdmission(session, replicaId, {
      transactionalAuthority: { credential, origin: session.origin },
    }),
    async () => { throw new Error('persisted replay unexpectedly evaluated'); },
  );
  process.stdout.write(JSON.stringify({ kind: replay.result.kind, result: replay.result }));
} finally {
  await runtime.close();
}
