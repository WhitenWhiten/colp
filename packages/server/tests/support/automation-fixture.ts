import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RuleDefinition, FolderRef } from '@know-n/colp/automation';
import { createPostgresIdentityUnitOfWork } from '../../src/infrastructure/identity/index.js';
import { createSession, ensureAccountFromOidcIdentity } from '../../src/modules/identity/index.js';
import { createOwnedCollectionCanonical, createCollectionNode, updateCollectionNode } from '../../src/modules/collections/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime } from './postgres-test-runtime.js';
import { SESSION_COOKIE_NAME } from '../../src/transport/session-cookie.js';

export async function automationFixture(prefix: string) {
  const isolated = await createIsolatedPostgresRuntime(prefix);
  await runMigrations(isolated.runtime.db, 'latest');
  const db = isolated.runtime.db;
  const identity = createPostgresIdentityUnitOfWork(db);
  const issue = async (suffix: string) => identity.execute(async (ports) => {
    const result = await ensureAccountFromOidcIdentity(ports, { issuer: 'https://automation.example.test', subject: suffix,
      email: `${suffix}@example.test`, displayName: suffix, handle: `aw-${suffix}` });
    const session = await createSession(ports, { accountId: result.account.id });
    return { accountId: result.account.id, subjectId: result.account.subjectId, cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.rawSessionToken)}`, csrfToken: session.rawCsrfToken };
  });
  const owner = await issue('owner');
  const actor = { principalId: owner.accountId, subjectId: owner.subjectId, principalType: 'account' as const };
  const canonical = createPostgresCanonicalMutationUnitOfWork(db);
  const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID() });
  await canonical.execute((ports) => createOwnedCollectionCanonical(ports, { actor, command: command(), title: 'Automation', summary: null,
    kind: 'bookmarks', collectionId: 'collection', rootNodeId: 'root', operationId: 'initial_operation' }));
  const createNode = async (id: string, parentId: string, title: string, url?: string) => {
    const node = url ? { kind: 'bookmark' as const, title, url, description: null, tags: [], visibility: 'inherit' as const }
      : { kind: 'folder' as const, title, description: null, tags: [], visibility: 'inherit' as const };
    const result = await canonical.execute((ports) => createCollectionNode(ports, { actor, command: command(), collectionId: 'collection',
      parentId, nodeId: id, afterId: null, beforeId: null, node }));
    if (result.kind !== 'created') throw new Error('Fixture node not created'); return result;
  };
  await createNode('parent', 'root', 'Research'); await createNode('academic', 'parent', 'Academic');
  await createNode('paper', 'root', 'Paper', 'https://arxiv.org/abs/fixture');
  const rename = async (nodeId: string, title: string) => {
    const node = await db.selectFrom('nodes').select('resource_revision').where('id', '=', nodeId).executeTakeFirstOrThrow();
    return canonical.execute((ports) => updateCollectionNode(ports, { actor, command: command(), collectionId: 'collection', nodeId,
      ifMatch: `"${node.resource_revision}"`, patch: { title } }));
  };
  const folder: FolderRef = { serverUuid: 'server', collectionId: 'collection', nodeId: 'academic' };
  const rule = JSON.parse(readFileSync('../node/tests/fixtures/automation/m1-placement.json', 'utf8')) as RuleDefinition;
  rule.scope.collectionId = 'collection';
  const values = { academicRoot: { kind: 'folder' as const, folder, followIdentity: true as const, onUnavailable: 'block' as const, notifyOn: ['rename' as const, 'move' as const, 'delete' as const, 'permission' as const, 'syncScope' as const] } };
  return { isolated, db, identity, issue, owner, actor, canonical, command, createNode, rename, folder, rule, values };
}
