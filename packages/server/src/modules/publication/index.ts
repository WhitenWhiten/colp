import type { PublicationCursorKeyring } from './application/index.js';

export * from './application/index.js';

export function createPublicationModule(cursorKeys?: PublicationCursorKeyring): {
  readonly name: 'publication';
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  return Object.freeze({
    name: 'publication',
    async start() {},
    async stop() { cursorKeys?.destroy(); },
  });
}
export * from './application/folder-shares.js';
export * from './application/folder-share-public-query.js';
export { projectPublicNode } from './application/public-page-projection.js';
export type { ProductPublicCollectionNode, ProductPublicCollectionPage } from './application/product-public-query.js';
