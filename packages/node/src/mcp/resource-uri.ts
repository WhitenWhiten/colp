import { isOpaqueId } from '../shared/resource-identity.js';
import type { Manifest, OpaqueId } from '../types/index.js';

/** Maximum accepted/generated MCP Resource URI length. */
export const MAX_MCP_RESOURCE_URI_LENGTH = 4096;

export type McpReadResource =
  | {
      readonly kind: 'collection-metadata';
      readonly collectionId: OpaqueId;
    }
  | {
      readonly kind: 'collection-snapshot';
      readonly collectionId: OpaqueId;
    }
  | {
      readonly kind: 'collection-node';
      readonly collectionId: OpaqueId;
      readonly nodeId: OpaqueId;
    };

export interface McpResourceUriCodec {
  /** The stable authority taken from the server's validated Manifest. */
  readonly serverUuid: OpaqueId;
  readonly collectionMetadata: (collectionId: string) => string;
  readonly collectionSnapshot: (collectionId: string) => string;
  readonly collectionNode: (collectionId: string, nodeId: string) => string;
  readonly parse: (uri: string) => McpReadResource;
}

/**
 * Creates a read-only Logical Resource URI codec bound to this server's Manifest identity.
 * Wire ID syntax is delegated to the shared CORE identity predicate; this codec owns only
 * the MCP profile's authority binding and its three non-overlapping resource paths.
 */
export function createMcpResourceUriCodec(
  manifest: Pick<Manifest, 'serverUuid'>,
): McpResourceUriCodec {
  assertArgumentCount('createMcpResourceUriCodec', arguments.length, 1);
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('createMcpResourceUriCodec requires a Manifest identity object.');
  }
  if (!Object.hasOwn(manifest, 'serverUuid')) {
    throw new TypeError('Manifest identity must own its serverUuid.');
  }
  const serverUuid = assertMcpPathId('Manifest serverUuid', manifest.serverUuid);
  const prefix = `colp://${serverUuid}/collections/`;

  const collectionMetadata = (...args: [collectionId: string]): string => {
    assertArgumentCount('collectionMetadata', args.length, 1);
    const uri = `${prefix}${assertMcpPathId('collectionId', args[0])}`;
    assertUriLength(uri);
    return uri;
  };

  const collectionSnapshot = (...args: [collectionId: string]): string => {
    assertArgumentCount('collectionSnapshot', args.length, 1);
    const uri = `${collectionMetadata(args[0])}/snapshot`;
    assertUriLength(uri);
    return uri;
  };

  const collectionNode = (...args: [collectionId: string, nodeId: string]): string => {
    assertArgumentCount('collectionNode', args.length, 2);
    const uri = `${collectionMetadata(args[0])}/nodes/${assertMcpPathId('nodeId', args[1])}`;
    assertUriLength(uri);
    return uri;
  };

  const parse = (...args: [uri: string]): McpReadResource => {
    assertArgumentCount('parse', args.length, 1);
    const uri = args[0];
    if (typeof uri !== 'string' || uri.length > MAX_MCP_RESOURCE_URI_LENGTH || uri.includes('%')) {
      throw new TypeError('MCP Resource URI must be a string without percent encoding.');
    }
    if (!uri.startsWith(prefix)) {
      throw new TypeError('MCP Resource URI does not use this server\'s stable serverUuid authority.');
    }
    if (uri.includes('?') || uri.includes('#') || uri.includes('\\')) {
      throw new TypeError('MCP Resource URI must not contain a query, fragment, or backslash.');
    }

    const segments = uri.slice(prefix.length).split('/');
    const collectionId = assertMcpPathId('collectionId', segments[0]);
    if (segments.length === 1) {
      return Object.freeze({ kind: 'collection-metadata', collectionId });
    }
    if (segments.length === 2 && segments[1] === 'snapshot') {
      return Object.freeze({ kind: 'collection-snapshot', collectionId });
    }
    if (segments.length === 3 && segments[1] === 'nodes') {
      const nodeId = assertMcpPathId('nodeId', segments[2]);
      return Object.freeze({ kind: 'collection-node', collectionId, nodeId });
    }
    throw new TypeError('MCP Resource URI does not identify collection metadata, a snapshot, or a node.');
  };

  return Object.freeze({
    serverUuid,
    collectionMetadata,
    collectionSnapshot,
    collectionNode,
    parse,
  });
}

function assertMcpPathId(name: string, value: unknown): OpaqueId {
  if (!isOpaqueId(value) || value === '.' || value === '..') {
    throw new TypeError(`${name} must be a valid CORE opaqueId.`);
  }
  return value;
}

function assertUriLength(uri: string): void {
  if (uri.length > MAX_MCP_RESOURCE_URI_LENGTH) {
    throw new RangeError('MCP Resource URI exceeds the maximum length.');
  }
}

function assertArgumentCount(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new TypeError(`${name} requires exactly ${expected} argument${expected === 1 ? '' : 's'}.`);
  }
}

