/**
 * Narrow publication barrel for the anonymous public Resource transport test.
 *
 * `packages/server/src/modules/publication/index.ts` re-exports unrelated
 * publication features whose module graphs need the full server dependency
 * install (`jose`, Fastify adapters, ...). The node-only CI job has no
 * `packages/server/node_modules`, so the transport fixture maps only
 * `collection-resources.ts`'s import of the barrel to the exact query
 * functions it uses. Those functions and the rest of the projection remain the
 * real server implementation.
 */
export {
  PublicationDirectoryCursorError,
  getPublicationDirectoryPage,
} from '../../../../server/src/modules/publication/application/directory-query.ts';
export {
  PublicationMetadataNotFoundError,
  getPublicationCollectionMetadata,
} from '../../../../server/src/modules/publication/application/metadata-query.ts';
