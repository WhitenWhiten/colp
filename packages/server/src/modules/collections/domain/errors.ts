export type CollectionsErrorCode =
  | 'invalid_collection_input'
  | 'invalid_collection_title'
  | 'invalid_collection_summary'
  | 'invalid_collection_kind'
  | 'invalid_node_input'
  | 'invalid_node_title'
  | 'invalid_node_url'
  | 'invalid_node_description'
  | 'invalid_node_tags'
  | 'invalid_node_visibility'
  | 'invalid_node_kind'
  | 'invalid_node_parent'
  | 'invalid_node_anchor'
  | 'invalid_node_patch'
  /** Bookmark cannot use recursive delete (transport maps to 422 invalid_document). */
  | 'invalid_node_delete';

export class CollectionsError extends Error {
  readonly code: CollectionsErrorCode;

  constructor(code: CollectionsErrorCode, message: string) {
    super(message);
    this.name = 'CollectionsError';
    this.code = code;
  }
}

/**
 * Opaque Product Editor cursor is unusable (format, signature, version, scope, expiry).
 * Transport maps to 400 invalid_cursor without distinguishing reasons.
 */
export class EditorCursorError extends Error {
  readonly code = 'invalid_cursor' as const;

  constructor(message = 'The editor cursor is invalid.') {
    super(message);
    this.name = 'EditorCursorError';
  }
}

/**
 * content_revision or policy_revision no longer matches the fenced snapshot.
 * Transport maps to 409 snapshot_expired.
 */
export class SnapshotExpiredError extends Error {
  readonly code = 'snapshot_expired' as const;

  constructor(message = 'The editor snapshot has expired.') {
    super(message);
    this.name = 'SnapshotExpiredError';
  }
}

/**
 * Carries access-policy decision for Product concealment / denial mapping.
 * Transport maps via toProductDenial → 404 resource_not_found or 403 insufficient_permission.
 */
export class EditorAuthorizationError extends Error {
  readonly code = 'editor_authorization' as const;
  readonly outcome: 'conceal' | 'deny';
  readonly reasonCategory: string;

  constructor(input: {
    readonly outcome: 'conceal' | 'deny';
    readonly reasonCategory: string;
  }) {
    super('Editor access denied.');
    this.name = 'EditorAuthorizationError';
    this.outcome = input.outcome;
    this.reasonCategory = input.reasonCategory;
  }
}

/**
 * Same-origin favicon URL or bookmark-icon write admission failed.
 * Transport maps to 400 invalid_request (never 422 invalid_document).
 */
export class BookmarkFaviconValidationError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message = 'favicon URL is not a same-origin /api/v1/favicon/<uuid> URL') {
    super(message);
    this.name = 'BookmarkFaviconValidationError';
  }
}

/**
 * Collection mutation authorization failed (conceal / deny).
 * Transport maps conceal → 404, deny → 403 (same as editor).
 */
export class CollectionAuthorizationError extends Error {
  readonly code = 'collection_authorization' as const;
  readonly outcome: 'conceal' | 'deny';
  readonly reasonCategory: string;

  constructor(input: {
    readonly outcome: 'conceal' | 'deny';
    readonly reasonCategory: string;
  }) {
    super('Collection access denied.');
    this.name = 'CollectionAuthorizationError';
    this.outcome = input.outcome;
    this.reasonCategory = input.reasonCategory;
  }
}

/**
 * If-Match / If-Content-Match did not match the locked resource or Collection content.
 * Transport maps to 412 precondition_failed with precondition resource|content and currentEtag.
 * Only thrown after authorization so currentEtag does not leak concealed resources.
 */
export class CollectionPreconditionError extends Error {
  readonly code = 'precondition_failed' as const;
  readonly precondition: 'resource' | 'content';
  readonly currentEtag: string;

  constructor(input: {
    readonly currentEtag: string;
    readonly precondition?: 'resource' | 'content';
    readonly message?: string;
  }) {
    const precondition = input.precondition ?? 'resource';
    super(
      input.message
        ?? (precondition === 'content'
          ? 'The Collection content ETag does not match the current representation.'
          : 'The resource ETag does not match the current representation.'),
    );
    this.name = 'CollectionPreconditionError';
    this.precondition = precondition;
    this.currentEtag = input.currentEtag;
  }
}

/** Recursive deletion planning exceeded a configured resource bound. */
export class DeleteSubtreeLimitError extends Error {
  readonly code = 'payload_too_large' as const;

  constructor(message = 'The requested subtree is too large to delete in one operation.') {
    super(message);
    this.name = 'DeleteSubtreeLimitError';
  }
}

/**
 * Node mutation conflict: Root immutable, non-empty Folder without recursive,
 * stale position anchors / parent children revision, domain revision conflict after If-Match, etc.
 * Transport maps to 409 with the concrete product code.
 */
export class NodeConflictError extends Error {
  readonly code:
    | 'root_immutable'
    | 'folder_not_empty'
    | 'position_context_stale'
    | 'revision_conflict';

  constructor(
    code: NodeConflictError['code'],
    message?: string,
  ) {
    super(message ?? defaultNodeConflictMessage(code));
    this.name = 'NodeConflictError';
    this.code = code;
  }
}

/**
 * The configured local rebalance window cannot create position space.
 * This is an observable escalation boundary, not permission to rewrite more siblings.
 */
export class PositionRebalanceEscalationError extends NodeConflictError {
  readonly windowSize: number;

  constructor(windowSize: number) {
    super(
      'position_context_stale',
      `Position allocation exhausted the configured rebalance window of ${windowSize}; retry after position maintenance.`,
    );
    this.name = 'PositionRebalanceEscalationError';
    this.windowSize = windowSize;
  }
}

function defaultNodeConflictMessage(code: NodeConflictError['code']): string {
  switch (code) {
    case 'root_immutable':
      return 'Root nodes are immutable through Product Node operations.';
    case 'folder_not_empty':
      return 'Folder has live children; set recursive=true to delete the subtree.';
    case 'position_context_stale':
      return 'Position anchors are no longer valid for this parent.';
    case 'revision_conflict':
      return 'A parent children revision no longer matches the expected base.';
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
