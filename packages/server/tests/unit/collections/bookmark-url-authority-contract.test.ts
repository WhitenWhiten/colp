/**
 * Locks the single Known-Backend bookmark-URL owner. Product, COLP sync, and
 * MCP write-create reject userinfo / ftp through their real entry functions
 * and real error types. Source scans below are extra wiring checks, not the
 * accept proof.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  CollectionsError,
  createCollectionNode,
  type CreateCollectionNodeInput,
  type ProductCollectionCanonicalPorts,
} from '../../../src/modules/collections/index.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  createPhase4bMcpLowRiskNodeCreateService,
} from '../../../src/modules/mcp/low-risk-node-create.js';
import {
  SyncNodeCreateError,
  mapSyncNodeCreateOperation,
} from '../../../src/modules/sync/sync-node-create.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function src(relative: string): string {
  return readFileSync(join(root, 'src', relative), 'utf8');
}

const COLP_URL_PREDICATE = /\b(?:isHttpUrl|isBookmarkUrl)\b/;

const REJECTED_URLS = [
  'https://user:pass@example.com/x',
  'ftp://example.com/x',
] as const;

function productBookmarkInput(url: string): CreateCollectionNodeInput {
  return {
    actor: {
      principalId: 'principal-owner',
      principalType: 'account',
      subjectId: 'subject-owner',
    },
    command: {
      commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a',
      fingerprint: 'a'.repeat(64),
    },
    collectionId: 'col-node-0001',
    parentId: 'root-node-0001',
    afterId: null,
    beforeId: null,
    node: {
      kind: 'bookmark',
      title: 'Bookmark',
      url,
      description: null,
      tags: [],
      visibility: 'inherit',
    },
  };
}

const unusedProductPorts = {} as ProductCollectionCanonicalPorts;

function syncBookmarkOperation(url: string) {
  return syncNodeCreatePushRequest({
    node: {
      kind: 'bookmark',
      title: 'Bookmark',
      url,
      description: null,
      tags: [],
      visibility: 'inherit',
    },
  }).operations[0]!;
}

const MCP_BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const mcpCreate = createPhase4bMcpLowRiskNodeCreateService({
  unitOfWork: {
    async execute() {
      throw new Error('MCP unit of work must not run after bookmark URL reject');
    },
  },
});

function mcpBookmarkRequest(url: string) {
  return {
    input: {
      tool: 'nodes.create',
      collectionId: 'collection-1',
      parentId: 'root-1',
      afterId: null,
      beforeId: null,
      node: {
        kind: 'bookmark',
        title: 'Example bookmark',
        url,
        description: null,
        tags: [],
        visibility: 'private',
      },
      reason: 'create a bookmark',
      confirmApply: true,
    },
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    expectedBaseRevisions: {
      'children.root-1': 'children-r1',
      'content.collection-1': 'content-r1',
      'policy.collection-1': 'policy-r1',
    },
  };
}

const MCP_CONTEXT = Object.freeze({
  binding: MCP_BINDING,
  accountSubjectId: MCP_BINDING.principalId,
  scope: Object.freeze(['nodes:write']),
});

describe('bookmark URL accept authority', () => {
  test('Product createCollectionNode rejects userinfo and ftp with invalid_node_url', async () => {
    for (const url of REJECTED_URLS) {
      await assert.rejects(
        () => createCollectionNode(unusedProductPorts, productBookmarkInput(url)),
        (error: unknown) => error instanceof CollectionsError && error.code === 'invalid_node_url',
        url,
      );
    }
  });

  test('sync mapSyncNodeCreateOperation rejects userinfo and ftp with invalid_document', () => {
    for (const url of REJECTED_URLS) {
      assert.throws(
        () => mapSyncNodeCreateOperation(syncBookmarkOperation(url), { managedBookmarkWrites: false }),
        (error: unknown) => error instanceof SyncNodeCreateError && error.code === 'invalid_document',
        url,
      );
    }
  });

  test('MCP write-create rejects userinfo and ftp with invalid_catalog_input', async () => {
    for (const url of REJECTED_URLS) {
      await assert.rejects(
        () => mcpCreate.execute(mcpBookmarkRequest(url), MCP_CONTEXT),
        (error: unknown) =>
          error instanceof Phase4bMcpLowRiskNodeCreateError && error.code === 'invalid_catalog_input',
        url,
      );
    }
  });

  test('MCP write-create does not import COLP URL predicates for bookmark accept', () => {
    const lowRisk = src('modules/mcp/low-risk-node-create.ts');
    assert.doesNotMatch(lowRisk, COLP_URL_PREDICATE);
    assert.match(lowRisk, /\bparseMcpNodeCreatePayload\b/);
    assert.match(lowRisk, /from '\.\/node-create-payload\.js'/);
    const payload = src('modules/mcp/node-create-payload.ts');
    assert.doesNotMatch(payload, COLP_URL_PREDICATE);
    assert.match(payload, /\bisAcceptedBookmarkUrl\b/);
    assert.match(payload, /from '\.\.\/collections\/index\.js'/);
  });

  test('MCP nodes.create catalog schema uses collections bookmark URL lexical bounds, not COLP predicates', () => {
    const source = src('modules/mcp/node-create-catalog.ts');
    assert.doesNotMatch(source, COLP_URL_PREDICATE);
    assert.match(source, /\bBOOKMARK_URL_MIN_LENGTH\b/);
    assert.match(source, /\bBOOKMARK_URL_MAX_LENGTH\b/);
    assert.match(source, /\bBOOKMARK_URL_HTTP_NO_USERINFO_PATTERN\b/);
    assert.match(source, /from '\.\.\/collections\/index\.js'/);
  });

  test('sync-node-create does not import COLP URL predicates for bookmark accept', () => {
    const source = src('modules/sync/sync-node-create.ts');
    assert.doesNotMatch(source, COLP_URL_PREDICATE);
    assert.match(source, /\b(?:acceptBookmarkUrl|assertValidHttpUrlNoUserInfo)\b/);
    assert.match(source, /from '\.\.\/collections\/index\.js'/);
  });

  test('Product node transport does not keep a local bookmark URL parser', () => {
    const source = src('transport/product/node-routes.ts');
    assert.doesNotMatch(source, /\bassertValidHttpUrlNoUserInfo\b/);
    assert.doesNotMatch(source, /\bacceptBookmarkUrl\b/);
    assert.doesNotMatch(source, /\bnew URL\s*\(/);
  });

  test('Postgres canonical ports use the collections accept predicate', () => {
    const source = src('infrastructure/collections/canonical-mutation-postgres-ports.ts');
    assert.doesNotMatch(source, COLP_URL_PREDICATE);
    assert.match(source, /\bisAcceptedBookmarkUrl\b/);
  });
});
