import type { StrictNode } from '../types/index.js';

import type { NodeWriteChildrenPage } from './node-write-guard.js';

/**
 * Pages created here were read from the same authoritative snapshot as
 * `resolveNode`. The membership is unforgeable: copying a field or freezing a
 * caller-built page does not enter the set.
 */
const authoritativeChildrenPages = new WeakSet<object>();

export function authoritativeNodeWriteChildrenPage(
  nodes: readonly StrictNode[],
  hasMore: boolean,
): NodeWriteChildrenPage {
  if (!Array.isArray(nodes) || typeof hasMore !== 'boolean') {
    throw new TypeError('Authoritative Node write children page requires a node array and hasMore.');
  }
  const page: NodeWriteChildrenPage = Object.freeze({
    nodes: Object.freeze(nodes.slice()),
    hasMore,
  });
  authoritativeChildrenPages.add(page);
  return page;
}

export function isAuthoritativeNodeWriteChildrenPage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && authoritativeChildrenPages.has(value);
}
