import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { test } from 'vitest';
import {
  registerCollectionRoutes,
  type CollectionRoutesDeps,
} from '../../../src/transport/product/collection-routes.js';

type RegisteredRoute = readonly [method: string, path: string];

function recordingApp(routes: RegisteredRoute[]): FastifyInstance {
  const app = {
    post(path: string) {
      routes.push(['POST', path]);
      return app;
    },
    patch(path: string) {
      routes.push(['PATCH', path]);
      return app;
    },
    delete(path: string) {
      routes.push(['DELETE', path]);
      return app;
    },
    get(path: string) {
      routes.push(['GET', path]);
      return app;
    },
  };
  return app as unknown as FastifyInstance;
}

function configuredDeps(): CollectionRoutesDeps {
  return {
    config: {
      contentGovernance: {
        enabled: false, cursorHmacKey: null,
        evidenceMaxBytes: 65536, evidenceRetentionDays: 365,
        reportRate: { maxRequests: 10, windowMs: 3_600_000 },
        actionRate: { maxRequests: 60, windowMs: 60_000 },
        appealRate: { maxRequests: 10, windowMs: 86_400_000 },
      },
    } as CollectionRoutesDeps['config'],
    identityUnitOfWork: {} as CollectionRoutesDeps['identityUnitOfWork'],
    collectionsUnitOfWork: {} as CollectionRoutesDeps['collectionsUnitOfWork'],
    productCollectionMutationUnitOfWork: {},
    collectionMetadataMutationsEnabled: true,
    collectionsEditorReadUnitOfWork: {},
    ownedCollectionsQuery: {},
    bookmarkCounts: { async countBookmarks() { return new Map(); } },
    annotationMutationUnitOfWork: {},
    annotationReadUnitOfWork: {},
  } as CollectionRoutesDeps;
}

test('collection facade registers each route once in the established order', () => {
  const routes: RegisteredRoute[] = [];

  registerCollectionRoutes(recordingApp(routes), configuredDeps());

  assert.deepEqual(routes, [
    ['POST', '/api/v1/collections'],
    ['PATCH', '/api/v1/collections/:collectionId'],
    ['GET', '/api/v1/collections/:collectionId/catalog'],
    ['PATCH', '/api/v1/collections/:collectionId/catalog'],
    ['GET', '/api/v1/collections'],
    ['POST', '/api/v1/collections/:collectionId/nodes'],
    ['PATCH', '/api/v1/collections/:collectionId/nodes/:nodeId'],
    ['POST', '/api/v1/collections/:collectionId/nodes/:nodeId/move'],
    ['DELETE', '/api/v1/collections/:collectionId/nodes/:nodeId'],
    ['GET', '/api/v1/collections/:collectionId/editor'],
    ['GET', '/api/v1/collections/:collectionId/annotations'],
    ['POST', '/api/v1/collections/:collectionId/annotations'],
    ['GET', '/api/v1/collections/:collectionId/annotations/:annotationId'],
    ['PATCH', '/api/v1/collections/:collectionId/annotations/:annotationId'],
    ['DELETE', '/api/v1/collections/:collectionId/annotations/:annotationId'],
  ]);
  assert.equal(new Set(routes.map(([method, path]) => `${method} ${path}`)).size, routes.length);
});

test('collection facade fails before partial registration when mutation UoW is absent', () => {
  const routes: RegisteredRoute[] = [];
  const deps = { ...configuredDeps(), productCollectionMutationUnitOfWork: undefined };

  assert.throws(
    () => registerCollectionRoutes(recordingApp(routes), deps),
    /require a canonical product mutation unit of work/,
  );
  assert.deepEqual(routes, []);
});
