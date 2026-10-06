export const T06_REVIEW_BULLET_IDS = Object.freeze([
  'low-risk-security',
  'commit-cancel-approval-concurrency',
  'operation-scope-policy',
  'non-collection-revisions',
  'executor-results',
  'model-visible-uri-safety',
  'resource-and-store-limits',
  'tool-schema-runtime-alignment',
  'mutation-testing',
] as const);

export type T06ReviewBulletId = (typeof T06_REVIEW_BULLET_IDS)[number];

export type T06EvidenceReference = Readonly<{
  file: `tests/mcp/${string}.test.ts`;
  testName: string;
  kind: 'behavior' | 'configuration' | 'host_residual';
}>;

export type T06EvidenceArea = Readonly<{
  id: T06ReviewBulletId;
  reviewBullet: string;
  evidence: readonly T06EvidenceReference[];
  residualContract?: string;
}>;

export const T06_EVIDENCE_MATRIX = Object.freeze([
  Object.freeze({
    id: 'low-risk-security',
    reviewBullet: 'lowRiskTools binding, authorization, concealment/read-only, and input snapshot',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/h01-low-risk-security-contract.test.ts',
        testName: '[review:mcp-write.h01] rejects low-risk calls without a trusted authorization context',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h01-low-risk-security-contract.test.ts',
        testName: '[review:mcp-write.h01] snapshots before application code can mutate caller-owned input',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h01-low-risk-security-contract.test.ts',
        testName: '[review:mcp-write.h01] preserves the host residual authorization denial and returns no model-visible success',
        kind: 'host_residual',
      }),
      Object.freeze({
        file: 'tests/mcp/h01-low-risk-security-contract.test.ts',
        testName: '[review:mcp-write.h01] preserves the host residual concealment decision and returns no model-visible success',
        kind: 'host_residual',
      }),
      Object.freeze({
        file: 'tests/mcp/h01-low-risk-security-contract.test.ts',
        testName: '[review:mcp-write.h01] preserves the host residual read-only deployment decision and returns no model-visible success',
        kind: 'host_residual',
      }),
    ]),
    residualContract: 'authorization is intentionally opaque; the trusted host application port owns concealment and read-only decisions and must reject before returning structured output',
  }),
  Object.freeze({
    id: 'commit-cancel-approval-concurrency',
    reviewBullet: 'Commit/Cancel, Approval/Cancel, same-key, and different-key concurrency',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/h03-commit-cancel-transaction-contract.test.ts',
        testName: 'lets Cancel win the transaction lock and prevents the queued Commit from executing',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h03-commit-cancel-transaction-contract.test.ts',
        testName: 'lets Approval win the transaction lock before a queued Cancel transitions approved to cancelled',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h03-commit-cancel-transaction-contract.test.ts',
        testName: 'lets a lock-owning Cancel reject a queued Approval without reviving the cancelled Plan',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h03-commit-cancel-transaction-contract.test.ts',
        testName: 'rejects Approval for a cancelled Plan before staging any Approval or Plan update',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/plan-commit-contract.test.ts',
        testName: 'concurrent same idempotency key: executor once, both return firstResult [evidence:mcp.plan-commit]',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/plan-commit-contract.test.ts',
        testName: 'concurrent different idempotency keys: one executes and the loser is rejected [evidence:mcp.plan-commit]',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'operation-scope-policy',
    reviewBullet: 'canonical operation-to-scope mapping and mixed Plan union',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/h05-operation-scope-policy-contract.test.ts',
        testName: "derives the canonical base Scope for 'delete_collection' and consults the trusted policy",
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h05-operation-scope-policy-contract.test.ts',
        testName: 'forms a stable, first-seen, duplicate-free union across a mixed Plan',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h05-operation-scope-policy-contract.test.ts',
        testName: 'passes the exact persisted derived Scope union to the Commit scope gate',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'non-collection-revisions',
    reviewBullet: 'set_rate_limit and other host-owned non-Collection revision namespaces',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/h06-authoritative-revision-resolver-contract.test.ts',
        testName: 'persists the resolver-owned namespace for rate-limit target',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h06-authoritative-revision-resolver-contract.test.ts',
        testName: 'passes the persisted namespace map and binding to Commit current revision resolution',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h06-authoritative-revision-resolver-contract.test.ts',
        testName: 'detects set_rate_limit TOCTOU in its resolver-owned namespace before execution',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'executor-results',
    reviewBullet: 'malformed/partial executor results and canonical operationResult Schema',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/h08-executor-result-validation-contract.test.ts',
        testName: 'rolls back undefined, preserves Approval and approved Plan, and permits same-key retry',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h08-executor-result-validation-contract.test.ts',
        testName: 'rolls back an operationResult that violates the canonical schema, preserves Approval and approved Plan, and permits same-key retry',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/h08-executor-result-validation-contract.test.ts',
        testName: 'accepts multiple canonical operationResults without requiring one result per Plan operation',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'model-visible-uri-safety',
    reviewBullet: 'approvalBaseUri/revealUri scheme, userinfo, origin, length, and control characters',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/m04-summary-uri-safety-contract.test.ts',
        testName: 'rejects approvalBaseUri with non-HTTP scheme',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m04-summary-uri-safety-contract.test.ts',
        testName: 'rejects approvalBaseUri with userinfo',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m04-summary-uri-safety-contract.test.ts',
        testName: 'rejects an otherwise canonical approval URI from a non-authorized origin',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m04-summary-uri-safety-contract.test.ts',
        testName: 'rejects a reveal URI with overlong URI',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m04-summary-uri-safety-contract.test.ts',
        testName: 'rejects a reveal URI with control character',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'resource-and-store-limits',
    reviewBullet: 'operation, depth, node, output, transport body, and store-retention limits',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/m02-write-resource-budget-contract.test.ts',
        testName: '[review:mcp-write.m02] accepts exactly maxOperations and rejects the next leaf',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m02-write-resource-budget-contract.test.ts',
        testName: '[review:mcp-write.m02] maps exact depth node and byte boundaries into stable risk errors',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m02-write-resource-budget-contract.test.ts',
        testName: '[review:mcp-write.m02] carries maxBytes into model-facing output without reflecting output',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m02-write-resource-budget-contract.test.ts',
        testName: '[review:mcp-write.m02] exposes an explicit pre-parse body-byte host contract',
        kind: 'host_residual',
      }),
      Object.freeze({
        file: 'tests/mcp/m05-in-memory-store-retention-contract.test.ts',
        testName: 'retains the immutable first result for replay until the configured deadline',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m05-in-memory-store-retention-contract.test.ts',
        testName: 'rejects a full Plan store without silently evicting an unexpired Plan',
        kind: 'behavior',
      }),
    ]),
    residualContract: 'the library publishes maxRequestBodyBytes; the host transport must enforce it on raw bytes before JSON parsing',
  }),
  Object.freeze({
    id: 'tool-schema-runtime-alignment',
    reviewBullet: 'canonical Tool input Schema/runtime alignment and published output validation',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/m03-write-tool-schema-contract.test.ts',
        testName: 'compiles every published input/output schema against the canonical graph [review:mcp-write.m03]',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m03-write-tool-schema-contract.test.ts',
        testName: "keeps schema and runtime acceptance aligned for canonical 'delete_collection' [review:mcp-write.m03]",
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m03-write-tool-schema-contract.test.ts',
        testName: 'validates actual Plan, Commit, and Cancel structured output [review:mcp-write.m03]',
        kind: 'behavior',
      }),
      Object.freeze({
        file: 'tests/mcp/m03-write-tool-schema-contract.test.ts',
        testName: 'fails closed before returning dynamic output that violates outputSchema [review:mcp-write.m03]',
        kind: 'behavior',
      }),
    ]),
  }),
  Object.freeze({
    id: 'mutation-testing',
    reviewBullet: 'MCP Write production code mutation testing',
    evidence: Object.freeze([
      Object.freeze({
        file: 'tests/mcp/t01-quality-gates-contract.test.ts',
        testName: 'mutates all MCP sources using the MCP contract tests and existing mutation floor',
        kind: 'configuration',
      }),
      Object.freeze({
        file: 'tests/mcp/t01-quality-gates-contract.test.ts',
        testName: 'defines critical and release mutation aggregates over the required partitions',
        kind: 'configuration',
      }),
    ]),
  }),
] as const satisfies readonly T06EvidenceArea[]);
