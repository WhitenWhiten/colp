function freezeProblemRegistry<Registry extends Record<string, { status: number; retryable: boolean }>>(
  registry: Registry,
): Readonly<{ [Code in keyof Registry]: Readonly<Registry[Code]> }> {
  for (const definition of Object.values(registry)) Object.freeze(definition);
  return Object.freeze(registry);
}

export const problemRegistry = freezeProblemRegistry({
  invalid_json: { status: 400, retryable: false },
  invalid_query: { status: 400, retryable: false },
  invalid_cursor_scope: { status: 400, retryable: false },
  authentication_required: { status: 401, retryable: false },
  insufficient_scope: { status: 403, retryable: false },
  node_read_only: { status: 403, retryable: false },
  origin_not_allowed: { status: 403, retryable: false },
  csrf_failed: { status: 403, retryable: false },
  resource_not_found: { status: 404, retryable: false },
  method_not_allowed: { status: 405, retryable: false },
  unsupported_version: { status: 406, retryable: false },
  revision_conflict: { status: 409, retryable: false },
  position_context_stale: { status: 409, retryable: true },
  snapshot_expired: { status: 409, retryable: true },
  idempotency_key_reused: { status: 409, retryable: false },
  idempotency_in_progress: { status: 409, retryable: true },
  sequence_gap: { status: 409, retryable: true },
  sequence_blocked: { status: 409, retryable: true },
  sequence_reuse: { status: 409, retryable: false },
  op_id_reused: { status: 409, retryable: false },
  dependency_failed: { status: 409, retryable: true },
  folder_not_empty: { status: 409, retryable: false },
  feed_cursor_expired: { status: 410, retryable: false },
  sync_cursor_expired: { status: 410, retryable: false },
  stale_replica: { status: 410, retryable: false },
  replica_retired: { status: 410, retryable: false },
  resource_purged: { status: 410, retryable: false },
  precondition_failed: { status: 412, retryable: true },
  payload_too_large: { status: 413, retryable: false },
  unsupported_media_type: { status: 415, retryable: false },
  unsupported_operation: { status: 422, retryable: false },
  invalid_document: { status: 422, retryable: false },
  precondition_required: { status: 428, retryable: true },
  rate_limited: { status: 429, retryable: true },
  internal_error: { status: 500, retryable: true },
  service_unavailable: { status: 503, retryable: true },
} as const);

export type ProblemCode = keyof typeof problemRegistry;

export function getProblemDefinition(code: ProblemCode): (typeof problemRegistry)[ProblemCode] {
  return problemRegistry[code];
}
