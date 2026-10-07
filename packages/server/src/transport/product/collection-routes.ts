import type { FastifyInstance } from 'fastify';
import { registerCollectionResourceRoutes } from './collection-resource-routes.js';
import { registerEditorRoutes } from './editor-routes.js';
import {
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import { registerNodeRoutes } from './node-routes.js';
import { registerAnnotationRoutes } from './annotation-routes.js';
import { registerRelationRoutes } from './relation-routes.js';
import { registerOwnedCollectionRoutes } from './owned-collection-routes.js';
import { registerCollectionCatalogRoutes } from './catalog-routes.js';

export type { CollectionRoutesDeps } from './collection-route-helpers.js';

export function registerCollectionRoutes(
  app: FastifyInstance,
  deps: CollectionRoutesDeps,
): void {
  if (!deps.productCollectionMutationUnitOfWork) {
    throw new Error(
      'Collection and node mutation routes require a canonical product mutation unit of work',
    );
  }
  registerCollectionResourceRoutes(app, deps);
  registerCollectionCatalogRoutes(app, deps);
  registerOwnedCollectionRoutes(app, deps);
  registerNodeRoutes(app, deps);
  registerEditorRoutes(app, deps);
  registerAnnotationRoutes(app, deps);
  registerRelationRoutes(app, deps);
}
