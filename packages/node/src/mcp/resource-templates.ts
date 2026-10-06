import type { Manifest } from '../types/index.js';
import { createMcpResourceUriCodec } from './resource-uri.js';

export interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: 'collection' | 'collection-node';
  readonly title: 'Collection metadata' | 'Collection node';
  readonly mimeType:
    | 'application/vnd.collection-protocol.collection+json'
    | 'application/vnd.collection-protocol.node+json';
}

export type McpResourceTemplates = readonly [
  collection: McpResourceTemplate,
  collectionNode: McpResourceTemplate,
];

/**
 * Creates the read-only MCP Resource Templates bound to the server identity in a Manifest.
 * Only implemented Resource kinds are advertised; feed reads are not implemented here.
 */
export function createMcpResourceTemplates(
  manifest: Pick<Manifest, 'serverUuid'>,
): McpResourceTemplates {
  assertArgumentCount('createMcpResourceTemplates', arguments.length, 1);
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('createMcpResourceTemplates requires a Manifest object.');
  }

  const serverUuidDescriptor = Object.getOwnPropertyDescriptor(manifest, 'serverUuid');
  if (serverUuidDescriptor === undefined || !('value' in serverUuidDescriptor)) {
    throw new TypeError('Manifest must own its serverUuid as a data property.');
  }

  // Delegate serverUuid syntax validation to the existing MCP/CORE identity boundary.
  const { serverUuid } = createMcpResourceUriCodec({
    serverUuid: serverUuidDescriptor.value as Manifest['serverUuid'],
  });
  const collectionPrefix = `colp://${serverUuid}/collections/{collectionId}`;

  return Object.freeze([
    Object.freeze({
      uriTemplate: collectionPrefix,
      name: 'collection',
      title: 'Collection metadata',
      mimeType: 'application/vnd.collection-protocol.collection+json',
    }),
    Object.freeze({
      uriTemplate: `${collectionPrefix}/nodes/{nodeId}`,
      name: 'collection-node',
      title: 'Collection node',
      mimeType: 'application/vnd.collection-protocol.node+json',
    }),
  ]);
}

function assertArgumentCount(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new TypeError(`${name} requires exactly ${expected} argument${expected === 1 ? '' : 's'}.`);
  }
}
