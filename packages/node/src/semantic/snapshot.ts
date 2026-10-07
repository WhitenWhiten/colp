import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { preparePlainCanonicalJson } from '../shared/plain-canonical-json.js';

import type {
  Annotation,
  Attachment,
  Relation,
  Snapshot,
  SnapshotNode,
  StrictNode,
} from '../types/index.js';
import {
  type ExtensionRemovalAudit,
  type ExtensionSecurityPolicy,
} from '../schema/extensions.js';
import { absoluteUriScheme, isBookmarkUrl, isHttpsNamespaceUri, isHttpUrl } from '../schema/uri.js';
import { validateNodeUrlHashSemantics } from './bookmark-url-hash.js';
import { createSnapshotVisibilityResolver } from './snapshot-visibility.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';
import {
  assembleSnapshotPagePayload,
  findCycles,
  liveResourceIdentities,
  visibilityRank,
  type GraphEdge,
  type LiveResourceIdentity,
  type SnapshotAssemblyBudget,
} from './snapshot-page-assembly.js';

export interface SnapshotSemanticContext {
  /** Producer enforces the public allowlist; consumer preserves valid namespaces as opaque JSON. */
  readonly publicationExtensionMode?: 'producer' | 'consumer';
  readonly publicSafeExtensions?: ReadonlySet<string>;
  readonly referenceResolution?: SnapshotReferenceResolution;
}

export interface SnapshotAssemblyContext extends SnapshotSemanticContext, SnapshotAssemblyBudget {
  /** Omit to preserve every extension. Any removal is returned in extensionRemovals. */
  readonly extensionSecurityPolicy?: ExtensionSecurityPolicy;
}

/** Resolution policy for references omitted from a cropped Snapshot or an individual page. */
export type SnapshotReferenceResolution =
  | {
      readonly mode: 'collection';
      readonly resolveNode: (nodeId: string) => StrictNode | undefined;
    }
  | { readonly mode: 'deferred' };

export type SnapshotAssemblyResult =
  | {
      readonly valid: true;
      readonly issues: readonly [];
      readonly snapshot: Snapshot;
      readonly extensionRemovals: readonly ExtensionRemovalAudit[];
    }
  | { readonly valid: false; readonly issues: readonly SemanticIssue[] };

const positionTokenPattern = /^[0-9A-Za-z_-]{1,128}$/;

function isPositionToken(value: unknown): value is string {
  return typeof value === 'string' && positionTokenPattern.test(value);
}

/** Compares canonical position tokens as unsigned ASCII octet sequences. */
export function compareOrderKeys(left: string, right: string): number {
  if (!isPositionToken(left) || !isPositionToken(right)) {
    throw new TypeError('Position tokens must match ^[0-9A-Za-z_-]{1,128}$.');
  }
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/** Removes Snapshot-only ordering hints before a Node becomes authoritative state. */
export function withoutSnapshotIndexes(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map(({ index: _index, ...node }) => node as SnapshotNode),
  };
}

/**
 * Replaces any received indexes with ordinals derived solely from canonical Position order.
 * The input must represent an assembled logical Snapshot rather than an individual page.
 */
export function deriveSnapshotIndexes(snapshot: Snapshot): Snapshot {
  if (
    snapshot.page.sequence !== 1
    || snapshot.page.hasMore
    || snapshot.page.nextCursor !== null
  ) {
    throw new TypeError('Snapshot indexes can only be derived after logical page assembly.');
  }

  type PositionedSnapshotNode = Exclude<SnapshotNode, { readonly kind: 'root' }>;
  const siblings = new Map<string, PositionedSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'root') continue;
    const group = siblings.get(node.parentId) ?? [];
    group.push(node);
    siblings.set(node.parentId, group);
  }

  const indexes = new Map<string, number>();
  for (const group of siblings.values()) {
    const ordered = group
      .slice()
      .sort((left, right) => compareOrderKeys(left.position, right.position));
    ordered.forEach((node, index) => {
      if (index > 0 && ordered[index - 1]!.position === node.position) {
        throw new TypeError(`Cannot derive Snapshot indexes from duplicate Position ${node.position}.`);
      }
      indexes.set(node.id, index);
    });
  }

  return {
    ...snapshot,
    nodes: snapshot.nodes.map(({ index: _index, ...node }) =>
      node.kind === 'root' ? { ...node, index: null } : { ...node, index: indexes.get(node.id)! }),
  };
}

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message };
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function extensionIssues(
  value: { readonly extensions?: Readonly<Record<string, unknown>> },
  path: string,
  publicationAllowlist: ReadonlySet<string> | undefined,
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  for (const namespace of Object.keys(value.extensions ?? {})) {
    const namespacePath = `${path}/extensions/${jsonPointerSegment(namespace)}`;
    if (!isHttpsNamespaceUri(namespace)) {
      issues.push(
        issue(
          'invalid_extension_namespace',
          namespacePath,
          `Extension key ${namespace} is not a valid HTTPS URI.`,
        ),
      );
      continue;
    }
    if (publicationAllowlist !== undefined && !publicationAllowlist.has(namespace)) {
      issues.push(
        issue(
          'unsafe_publication_extension',
          namespacePath,
          `Extension ${namespace} is not approved for publication.`,
        ),
      );
    }
  }
  return issues;
}

export function validateSnapshotSemantics(
  snapshot: Snapshot,
  context: SnapshotSemanticContext = {},
): SemanticValidationResult {
  if (isProxy(snapshot)) throw new TypeError('Snapshot must be plain JSON data.');
  const contentDigestProperty = Object.getOwnPropertyDescriptor(snapshot, 'contentDigest');
  if (
    contentDigestProperty !== undefined
    && (!contentDigestProperty.enumerable || !('value' in contentDigestProperty))
  ) {
    throw new TypeError('Snapshot contentDigest must be an enumerable data property.');
  }
  const contentDigest = contentDigestProperty === undefined ? undefined : contentDigestProperty.value;
  const digestDocument = contentDigest === undefined
    ? undefined
    : preparePlainCanonicalJson(snapshot, 'Snapshot logical content');
  // Generated Snapshot DTOs have mutable arrays; validation only reads the frozen copy.
  if (digestDocument) snapshot = digestDocument.value as Snapshot;
  const issues: SemanticIssue[] = [];
  const nodes = snapshot.nodes as readonly StrictNode[];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const completeSnapshotAvailable = snapshot.complete && snapshot.page.sequence === 1 && !snapshot.page.hasMore;
  const roots = nodes.filter((node) => node.kind === 'root');
  type ExternalNodeResolution =
    | { readonly status: 'resolved'; readonly node: StrictNode }
    | { readonly status: 'missing' }
    | { readonly status: 'invalid'; readonly code: string; readonly message: string };
  const externalNodeCache = new Map<string, ExternalNodeResolution>();
  const nodeKinds = new Set<StrictNode['kind']>(['root', 'folder', 'bookmark', 'separator', 'alias']);

  const publicationAllowlist = snapshot.mode === 'publication'
    && context.publicationExtensionMode !== 'consumer'
    ? context.publicSafeExtensions ?? new Set<string>()
    : undefined;
  if (
    snapshot.collection.canonicalUrl !== undefined &&
    !isHttpUrl(snapshot.collection.canonicalUrl)
  ) {
    issues.push(
      issue(
        'invalid_canonical_url',
        '/collection/canonicalUrl',
        'Canonical URL must be an absolute HTTP(S) URL without user information.',
      ),
    );
  }
  if (snapshot.page.hasMore === (snapshot.page.nextCursor === null)) {
    issues.push(
      issue(
        'invalid_snapshot_page_cursor',
        '/page/nextCursor',
        'nextCursor must be present exactly when hasMore is true.',
      ),
    );
  }
  if (contentDigest !== undefined && !completeSnapshotAvailable) {
    issues.push(
      issue(
        'invalid_snapshot_content_digest_scope',
        '/contentDigest',
        'contentDigest is only valid for a complete single-page logical Snapshot.',
      ),
    );
  } else if (contentDigest !== undefined) {
    const canonical = digestDocument!.encode('contentDigest');
    const expected = `sha-256=:${createHash('sha256').update(canonical).digest('base64')}:`;
    if (contentDigest !== expected) {
      issues.push(
        issue(
          'snapshot_content_digest_mismatch',
          '/contentDigest',
          'Snapshot contentDigest does not match its canonical logical content.',
        ),
      );
    }
  }
  // Append diagnostics as data, never as an unbounded function argument list.
  for (const entry of extensionIssues(snapshot.collection, '/collection', publicationAllowlist)) issues.push(entry);
  for (const [kind, resources] of [
    ['nodes', snapshot.nodes], ['annotations', snapshot.annotations],
    ['attachments', snapshot.attachments], ['relations', snapshot.relations],
  ] as const) {
    resources.forEach((value, index) => {
      for (const entry of extensionIssues(value, `/${kind}/${index}`, publicationAllowlist)) issues.push(entry);
    });
  }

  const resolveExternalNode = (nodeId: string): ExternalNodeResolution => {
    const cached = externalNodeCache.get(nodeId);
    if (cached !== undefined) return cached;

    let resolution: ExternalNodeResolution;
    try {
      const resolved = context.referenceResolution?.mode === 'collection'
        ? context.referenceResolution.resolveNode(nodeId)
        : undefined;
      if (resolved === undefined) {
        resolution = { status: 'missing' };
      } else if (typeof resolved !== 'object' || resolved === null) {
        resolution = {
          status: 'invalid',
          code: 'invalid_reference_resolution',
          message: `Resolver returned a non-node value for ${nodeId}.`,
        };
      } else if (resolved.id !== nodeId) {
        resolution = {
          status: 'invalid',
          code: 'invalid_reference_resolution',
          message: `Resolver returned node ${String(resolved.id)} for ${nodeId}.`,
        };
      } else if (resolved.collectionId !== snapshot.collection.id) {
        resolution = {
          status: 'invalid',
          code: 'cross_collection_reference',
          message: `Resolved node ${nodeId} belongs to another collection.`,
        };
      } else if (!nodeKinds.has(resolved.kind)) {
        resolution = {
          status: 'invalid',
          code: 'invalid_reference_resolution',
          message: `Resolver returned node ${nodeId} with invalid kind ${String(resolved.kind)}.`,
        };
      } else {
        resolution = { status: 'resolved', node: resolved };
      }
    } catch {
      resolution = {
        status: 'invalid',
        code: 'reference_resolver_error',
        message: `Reference resolver failed for ${nodeId}.`,
      };
    }
    externalNodeCache.set(nodeId, resolution);
    return resolution;
  };

  interface ResolvedNode {
    readonly node?: StrictNode;
    readonly nodeKind?: StrictNode['kind'];
  }

  const resolveReferencedNode = (
    nodeId: string,
    path: string,
    missingCode: string,
    label: string,
  ): ResolvedNode | undefined => {
    const local = nodeById.get(nodeId);
    if (local !== undefined) return { node: local, nodeKind: local.kind };

    // A complete logical Snapshot is authoritative and must resolve every reference locally.
    if (!completeSnapshotAvailable && context.referenceResolution?.mode === 'deferred') {
      return undefined;
    }

    if (!completeSnapshotAvailable && context.referenceResolution?.mode === 'collection') {
      const resolved = resolveExternalNode(nodeId);
      if (resolved.status === 'missing') {
        issues.push(issue(missingCode, path, `${label} ${nodeId} is missing from the collection.`));
        return undefined;
      }
      if (resolved.status === 'invalid') {
        issues.push(issue(resolved.code, path, resolved.message));
        return undefined;
      }
      return { node: resolved.node, nodeKind: resolved.node.kind };
    }

    issues.push(issue(missingCode, path, `${label} ${nodeId} is missing.`));
    return undefined;
  };

  if (completeSnapshotAvailable) {
    if (roots.length !== 1) {
      issues.push(issue('invalid_root_count', '/nodes', `Expected one root, found ${roots.length}.`));
    } else if (roots[0]?.id !== snapshot.collection.rootNodeId) {
      issues.push(
        issue('root_id_mismatch', '/collection/rootNodeId', 'rootNodeId does not identify the root.'),
      );
    }
  }

  const liveIds = new Map<string, LiveResourceIdentity>();
  for (const identity of liveResourceIdentities(snapshot)) {
    const { resourceType, resource, path } = identity;
    const previous = liveIds.get(resource.id);
    if (previous !== undefined) {
      issues.push(
        issue(
          'duplicate_live_id',
          `${path}/id`,
          `Live ID ${resource.id} is already used by ${previous.resourceType} at ${previous.path}/id.`,
        ),
      );
    }
    if (previous === undefined) liveIds.set(resource.id, identity);
    if (resource.collectionId !== undefined && resource.collectionId !== snapshot.collection.id) {
      issues.push(
        issue(
          'collection_id_mismatch',
          `/${resourceType}s`,
          `${resourceType} ${resource.id} belongs to another collection.`,
        ),
      );
    }
  }

  const tombstoneIds = new Set<string>();
  snapshot.tombstones.forEach((tombstone, index) => {
    if (tombstoneIds.has(tombstone.targetId)) {
      issues.push(
        issue(
          'duplicate_tombstone',
          `/tombstones/${index}/targetId`,
          `Tombstone target ${tombstone.targetId} is repeated.`,
        ),
      );
    }
    tombstoneIds.add(tombstone.targetId);
    const live = liveIds.get(tombstone.targetId);
    if (live !== undefined) {
      issues.push(
        issue(
          'live_tombstone_overlap',
          `/tombstones/${index}/targetId`,
          `Tombstone target ${tombstone.targetId} is still live as ${live.resourceType} at ${live.path}/id.`,
        ),
      );
    }
    if (tombstone.collectionId !== snapshot.collection.id) {
      issues.push(
        issue('collection_id_mismatch', `/tombstones/${index}/collectionId`, 'Tombstone belongs to another collection.'),
      );
    }
  });

  const parentEdges = new Map<string, GraphEdge>();
  const aliasEdges = new Map<string, GraphEdge>();
  const invalidParentTargets = new Set<string>();
  const positions = new Map<string, Set<string>>();
  nodes.forEach((node, index) => {
    if (node.kind === 'root') {
      return;
    }
    const parentPath = `/nodes/${index}/parentId`;
    const parent = resolveReferencedNode(node.parentId, parentPath, 'missing_parent', 'Parent');
    const structuralParent = parent !== undefined
      && (parent.nodeKind === 'root' || parent.nodeKind === 'folder');
    if (parent !== undefined && !structuralParent) {
      invalidParentTargets.add(node.parentId);
      issues.push(
        issue(
          'invalid_parent_kind',
          `/nodes/${index}/parentId`,
          `Parent ${node.parentId} has non-structural kind ${parent.nodeKind}; expected root or folder.`,
        ),
      );
    }
    if (parent !== undefined) {
      parentEdges.set(node.id, { targetId: node.parentId, path: `/nodes/${index}/parentId` });
    }
    if (!isPositionToken(node.position)) {
      issues.push(
        issue(
          'invalid_position',
          `/nodes/${index}/position`,
          'Position must match ^[0-9A-Za-z_-]{1,128}$.',
        ),
      );
    } else {
      const siblingPositions = positions.get(node.parentId) ?? new Set<string>();
      if (siblingPositions.has(node.position)) {
        issues.push(issue('duplicate_position', `/nodes/${index}/position`, 'Sibling position is reused.'));
      }
      siblingPositions.add(node.position);
      positions.set(node.parentId, siblingPositions);
    }

    if (node.kind === 'alias') {
      const targetPath = `/nodes/${index}/targetNodeId`;
      const target = resolveReferencedNode(
        node.targetNodeId,
        targetPath,
        'missing_alias_target',
        'Alias target',
      );
      if (target !== undefined) {
        aliasEdges.set(node.id, { targetId: node.targetNodeId, path: `/nodes/${index}/targetNodeId` });
      }
    }
  });

  const resolvedGraphLimit = 10_000;
  const expandResolvedParentEdges = (): void => {
    if (completeSnapshotAvailable || context.referenceResolution?.mode !== 'collection') return;
    const pending = [...parentEdges.values()];
    const expanded = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
      const edge = pending[index] as GraphEdge;
      if (nodeById.has(edge.targetId) || expanded.has(edge.targetId)) continue;
      if (invalidParentTargets.has(edge.targetId)) continue;
      if (expanded.size >= resolvedGraphLimit) {
        issues.push(issue(
          'reference_resolution_limit',
          edge.path,
          `Resolved Parent graph exceeds ${resolvedGraphLimit} external nodes.`,
        ));
        return;
      }
      expanded.add(edge.targetId);
      const resolution = resolveExternalNode(edge.targetId);
      if (resolution.status === 'missing') {
        issues.push(issue(
          'missing_parent',
          edge.path,
          `Parent ancestry node ${edge.targetId} is missing from the collection.`,
        ));
        continue;
      }
      if (resolution.status === 'invalid') {
        issues.push(issue(resolution.code, edge.path, resolution.message));
        continue;
      }
      const parent = resolution.node;
      if (parent.kind !== 'root' && parent.kind !== 'folder') {
        issues.push(issue(
          'invalid_parent_kind',
          edge.path,
          `Parent ${parent.id} has non-structural kind ${parent.kind}; expected root or folder.`,
        ));
        continue;
      }
      if (parent.kind === 'root') continue;
      const parentId = (parent as { readonly parentId?: unknown }).parentId;
      if (typeof parentId !== 'string') {
        issues.push(issue(
          'invalid_reference_resolution',
          edge.path,
          `Resolver returned node ${parent.id} without a valid parentId.`,
        ));
        continue;
      }
      const next = { targetId: parentId, path: edge.path };
      parentEdges.set(parent.id, next);
      pending.push(next);
    }
  };
  const expandResolvedAliasEdges = (): void => {
    if (completeSnapshotAvailable || context.referenceResolution?.mode !== 'collection') return;
    const pending = [...aliasEdges.values()];
    const expanded = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
      const edge = pending[index] as GraphEdge;
      if (nodeById.has(edge.targetId) || expanded.has(edge.targetId)) continue;
      if (expanded.size >= resolvedGraphLimit) {
        issues.push(issue(
          'reference_resolution_limit',
          edge.path,
          `Resolved Alias graph exceeds ${resolvedGraphLimit} external nodes.`,
        ));
        return;
      }
      expanded.add(edge.targetId);
      const resolution = resolveExternalNode(edge.targetId);
      if (resolution.status === 'missing') {
        issues.push(issue(
          'missing_alias_target',
          edge.path,
          `Alias ancestry node ${edge.targetId} is missing from the collection.`,
        ));
        continue;
      }
      if (resolution.status === 'invalid') {
        issues.push(issue(resolution.code, edge.path, resolution.message));
        continue;
      }
      const target = resolution.node;
      if (target.kind !== 'alias') continue;
      const targetNodeId = (target as { readonly targetNodeId?: unknown }).targetNodeId;
      if (typeof targetNodeId !== 'string') {
        issues.push(issue(
          'invalid_reference_resolution',
          edge.path,
          `Resolver returned Alias ${target.id} without a valid targetNodeId.`,
        ));
        continue;
      }
      const next = { targetId: targetNodeId, path: edge.path };
      aliasEdges.set(target.id, next);
      pending.push(next);
    }
  };
  expandResolvedParentEdges();
  expandResolvedAliasEdges();
  for (const entry of findCycles(parentEdges, 'parent_cycle', 'Parent')) issues.push(entry);
  for (const entry of findCycles(aliasEdges, 'alias_cycle', 'Alias')) issues.push(entry);

  const lookupVisibilityNode = (
    nodeId: string,
    path: string,
    reportFailure: boolean,
  ): StrictNode | undefined => {
    const local = nodeById.get(nodeId);
    if (local !== undefined) return local;
    if (completeSnapshotAvailable) return undefined;
    const external = resolveExternalNode(nodeId);
    if (external.status === 'resolved') return external.node;
    if (reportFailure) {
      issues.push(external.status === 'missing'
        ? issue(
            'missing_visibility_ancestor',
            path,
            `Visibility ancestor ${nodeId} is missing from the collection.`,
          )
        : issue(external.code, path, external.message));
    }
    return undefined;
  };
  const reportedVisibilityFailures = new Set(issues
    .filter(({ code }) => code === 'parent_cycle' || code === 'reference_resolution_limit')
    .map(({ code, path }) => `${code}:${path}`));
  const resolveNodeVisibility = createSnapshotVisibilityResolver({
    localNodes: nodeById,
    collectionRank: visibilityRank[snapshot.collection.visibility],
    maxExternalNodes: resolvedGraphLimit,
    lookup: lookupVisibilityNode,
    report: (entry) => {
      const key = `${entry.code}:${entry.path}`;
      if (reportedVisibilityFailures.has(key)) return;
      reportedVisibilityFailures.add(key);
      issues.push(entry);
    },
  });
  nodes.forEach((node, index) => resolveNodeVisibility(node, `/nodes/${index}/parentId`));

  const validateSubject = (
    resource: Annotation | Attachment,
    resourceType: 'annotations' | 'attachments',
    index: number,
  ): void => {
    let subjectRank: number | undefined;
    if (resource.subject.type === 'collection') {
      if (resource.subject.id !== snapshot.collection.id) {
        issues.push(
          issue(
            'missing_subject',
            `/${resourceType}/${index}/subject/id`,
            `Collection subject ${resource.subject.id} is missing from the collection.`,
          ),
        );
      } else {
        subjectRank = visibilityRank[snapshot.collection.visibility];
      }
    } else {
      const subjectPath = `/${resourceType}/${index}/subject/id`;
      const subject = resolveReferencedNode(resource.subject.id, subjectPath, 'missing_subject', 'Subject');
      if (subject?.node !== undefined) {
        subjectRank = resolveNodeVisibility(subject.node, subjectPath);
      }
    }
    if (subjectRank !== undefined && visibilityRank[resource.visibility] < subjectRank) {
      issues.push(
        issue('visibility_widened', `/${resourceType}/${index}/visibility`, 'Sidecar visibility is wider than its subject.'),
      );
    }
  };
  snapshot.annotations.forEach((value, index) => validateSubject(value, 'annotations', index));
  snapshot.attachments.forEach((value, index) => validateSubject(value, 'attachments', index));

  snapshot.annotations.forEach((annotation, annotationIndex) => {
    annotation.provenance?.sourceNodeIds?.forEach((nodeId, sourceIndex) => {
      resolveReferencedNode(
        nodeId,
        `/annotations/${annotationIndex}/provenance/sourceNodeIds/${sourceIndex}`,
        'missing_provenance_source',
        'Provenance source',
      );
    });
  });

  snapshot.relations.forEach((relation: Relation, index) => {
    const from = resolveReferencedNode(
      relation.fromNodeId,
      `/relations/${index}/fromNodeId`,
      'missing_relation_endpoint',
      'Relation endpoint',
    );
    const to = resolveReferencedNode(
      relation.toNodeId,
      `/relations/${index}/toNodeId`,
      'missing_relation_endpoint',
      'Relation endpoint',
    );
    const endpointRank = from?.node !== undefined && to?.node !== undefined
      ? Math.max(
          resolveNodeVisibility(from.node, `/relations/${index}/fromNodeId`),
          resolveNodeVisibility(to.node, `/relations/${index}/toNodeId`),
        )
      : undefined;
    if (endpointRank !== undefined && visibilityRank[relation.visibility] < endpointRank) {
      issues.push(issue('visibility_widened', `/relations/${index}/visibility`, 'Relation visibility is wider than an endpoint.'));
    }
  });

  nodes.forEach((node, index) => {
    if (node.kind !== 'bookmark') return;
    if (node.redacted === true) {
      if (snapshot.mode !== 'publication') {
        issues.push(
          issue(
            'redacted_node_outside_publication',
            `/nodes/${index}/redacted`,
            'Redacted Bookmark nodes are only valid in publication Snapshots.',
          ),
        );
      }
      return;
    }
    if (!isBookmarkUrl(node.url)) {
      issues.push(
        issue(
          'invalid_bookmark_url',
          `/nodes/${index}/url`,
          'Bookmark URL must be an absolute RFC 3986 URI without control characters or an executable scheme.',
        ),
      );
    }
    if (node.canonicalUrl !== undefined && !isHttpUrl(node.canonicalUrl)) {
      issues.push(
        issue(
          'invalid_canonical_url',
          `/nodes/${index}/canonicalUrl`,
          'Canonical URL must be an absolute HTTP(S) URL without user information.',
        ),
      );
    }
    const urlHash = validateNodeUrlHashSemantics(node, `/nodes/${index}/urlHash`);
    if (!urlHash.valid) for (const entry of urlHash.issues) issues.push(entry);
  });

  if (snapshot.mode === 'publication') {
    nodes.forEach((node, index) => {
      if ('sourceRefs' in node && node.sourceRefs !== undefined) {
        issues.push(issue('source_ref_leak', `/nodes/${index}/sourceRefs`, 'Publication node exposes sourceRefs.'));
      }
      if (node.kind === 'bookmark' && node.redacted !== true && isBookmarkUrl(node.url)
        && !isHttpUrl(node.url)) {
        const scheme = absoluteUriScheme(node.url);
        const userinfo = scheme === 'http' || scheme === 'https';
        issues.push(issue(
          userinfo ? 'unsafe_publication_userinfo' : 'unsafe_publication_scheme',
          `/nodes/${index}/url`,
          userinfo
            ? 'Publication Bookmark URL authority must not contain user information.'
            : `Scheme ${scheme} is not publishable.`,
        ));
      }
    });
  }

  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues: Object.freeze(issues) };
}

/**
 * Merges Snapshot pages into one logical Snapshot, then runs full semantic validation.
 * Page framing / identity work lives in `assembleSnapshotPagePayload`.
 */
export function assembleSnapshotPages(
  pages: readonly Snapshot[],
  context: SnapshotAssemblyContext = {},
): SnapshotAssemblyResult {
  const assembled = assembleSnapshotPagePayload(pages, {
    ...context,
    ...(context.maxMembers === undefined ? {} : { maxMembers: context.maxMembers }),
    ...(context.maxObjects === undefined ? {} : { maxObjects: context.maxObjects }),
  });
  if (!assembled.valid) {
    return { valid: false, issues: assembled.issues };
  }
  const semantic = validateSnapshotSemantics(assembled.snapshot, context);
  return semantic.valid
    ? {
        valid: true,
        issues: [],
        snapshot: assembled.snapshot,
        extensionRemovals: assembled.extensionRemovals,
      }
    : { valid: false, issues: semantic.issues };
}
