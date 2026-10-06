import { isProxy } from 'node:util/types';

import { isHttpUrl } from '../schema/uri.js';

const INVALID_PUBLICATION_SNAPSHOT = 'Publication Snapshot Bookmark URLs are invalid.';

/**
 * Rejects publication representations that would disclose a non-HTTP(S)
 * Bookmark target or HTTP Authority userinfo.
 *
 * Callers retain the exact URL string: this guard neither resolves nor
 * normalizes targets. Redacted Bookmarks do not need to carry a target.
 */
export function assertPublicationSnapshotBookmarkUrls(
  snapshot: unknown,
): void {
  try {
    if (typeof snapshot !== 'object' || snapshot === null || isProxy(snapshot)) throw new TypeError();
    if (dataProperty(snapshot, 'mode') !== 'publication') throw new TypeError();
    const nodes = dataProperty(snapshot, 'nodes');
    if (!Array.isArray(nodes) || isProxy(nodes)) throw new TypeError();

    for (let index = 0; index < nodes.length; index += 1) {
      const node = dataProperty(nodes, String(index));
      if (typeof node !== 'object' || node === null || isProxy(node)) throw new TypeError();
      if (
        dataProperty(node, 'kind') === 'bookmark'
        && optionalDataProperty(node, 'redacted') !== true
        && !isHttpUrl(optionalDataProperty(node, 'url'))
      ) throw new TypeError();
    }
  } catch {
    throw new TypeError(INVALID_PUBLICATION_SNAPSHOT);
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function optionalDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}
