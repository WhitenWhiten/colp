import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { LibraryCollection, LibraryCollectionPorts, LibraryCollectionUnitOfWork } from '../../../src/modules/collections/index.js';
import { LibraryFolderRequiredError, createPhase4bMcpOwnedCollectionCreateService } from '../../../src/modules/mcp/owned-collection-mcp.js';
import { classifyPhase4bMcpWriteError, toPhase4bMcpWriteRequestError } from '../../../src/modules/mcp/write-error-classifier.js';
import { CONTEXT } from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

const library: LibraryCollection = { id: 'account-library', title: 'Bookmarks', rootNodeId: 'library-root',
  library: true, bookmarksBarId: 'library-bar', otherBookmarksId: 'library-other' };

test('collections.create refuses and preserves library identities through the wire error round trip', async () => {
  let ensures = 0;
  const unit: LibraryCollectionUnitOfWork = { async execute(owner, work) {
    ensures += 1;
    assert.equal(owner.principalId, CONTEXT.binding.principalId);
    assert.equal(owner.subjectId, CONTEXT.accountSubjectId);
    return work({ find: async () => library,
      bootstrap: {} as LibraryCollectionPorts['bootstrap'],
      mutate: async () => { throw new Error('must not create another collection'); },
    });
  } };
  const service = createPhase4bMcpOwnedCollectionCreateService({ libraryCollectionUnitOfWork: unit });
  await assert.rejects(service.execute({}, { ...CONTEXT, scope: ['collections:create'] }), (error: unknown) => {
    assert.ok(error instanceof LibraryFolderRequiredError);
    const wire = toPhase4bMcpWriteRequestError(classifyPhase4bMcpWriteError(error));
    const roundTrip = classifyPhase4bMcpWriteError(wire);
    assert.equal(roundTrip.stableClass, 'library_protected');
    for (const id of [library.id, library.bookmarksBarId, library.otherBookmarksId, 'nodes.create']) {
      assert.ok(wire.message.includes(id));
      assert.ok(roundTrip.safeMessage.includes(id));
    }
    assert.equal((wire.data as { nextTool: string }).nextTool, 'nodes.create');
    return true;
  });
  assert.equal(ensures, 1);
});

test('collections.create checks scope before ensuring the library', async () => {
  const service = createPhase4bMcpOwnedCollectionCreateService({ libraryCollectionUnitOfWork: {
    execute: async () => { throw new Error('unauthorized calls must not ensure a library'); },
  } });
  await assert.rejects(service.execute({}, { ...CONTEXT, scope: [] }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'scope_invalid');
});
