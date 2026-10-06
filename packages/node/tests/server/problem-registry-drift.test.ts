import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as packageBoundary from '../../src/server/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  mapNodeWriteDenialToProblem,
  problemRegistry,
  type ProblemCode,
} from '../../src/server/index.js';
import type { NodeWriteGuardDenialCode } from '../../src/server/node-write-guard.js';

const protocolProblemRegistry = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'docs',
  '09-problem-registry.md',
);

const denialCodes = [
  'invalid_node_mutation',
  'authorization_denied',
  'collection_unresolved',
  'node_unresolved',
  'node_already_exists',
  'node_ancestry_unresolved',
  'parent_cycle',
  'node_ancestry_cycle',
  'node_ancestry_too_deep',
  'node_subtree_cycle',
  'node_subtree_unresolved',
  'node_subtree_too_deep',
  'node_subtree_too_large',
  'node_collection_mismatch',
  'invalid_parent_kind',
  'root_invariant',
  'invalid_node_constraints',
  'node_read_only',
  'node_policy_denied',
  'folder_not_empty',
  'affected_nodes_mismatch',
] as const satisfies readonly NodeWriteGuardDenialCode[];

function problem(code: string, status: number): Record<string, unknown> {
  return {
    type: `https://errors.example.test/${code}`,
    title: code,
    status,
    code,
  };
}

describe('Problem Registry drift and endpoint mapping [evidence:core.problem-registry] [evidence:core.limit-wire-mapping]', () => {
  it('matches every protocol table code and status exactly', async () => {
    const markdown = await readFile(protocolProblemRegistry, 'utf8');
    const rows = [...markdown.matchAll(/^\|\s*(\d{3})\s*\|\s*`([a-z][a-z0-9_]*)`\s*\|/gmu)];
    const protocol = Object.fromEntries(rows.map((row) => [row[2]!, Number(row[1])]));
    const implementation = Object.fromEntries(
      Object.entries(problemRegistry).map(([code, definition]) => [code, definition.status]),
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(implementation).toEqual(protocol);
  });

  it('exports one immutable implementation Registry from server and package boundaries', () => {
    expect(packageBoundary.problemRegistry).toBe(problemRegistry);
    expect(Object.isFrozen(problemRegistry)).toBe(true);
    expect(Object.keys(problemRegistry)).toHaveLength(36);
    expect(problemRegistry.unsupported_operation).toEqual({ status: 422, retryable: false });
    expect(problemRegistry.sequence_blocked).toEqual({ status: 409, retryable: true });
    for (const definition of Object.values(problemRegistry)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(typeof definition.retryable).toBe('boolean');
    }
  });

  it('accepts registered short codes and HTTPS extension codes, but rejects unregistered short codes', () => {
    const validators = createValidatorRegistry();
    for (const [code, definition] of Object.entries(problemRegistry)) {
      expect(validators.validate('problem', problem(code, definition.status))).toEqual({
        valid: true,
        errors: [],
      });
    }
    expect(validators.validate(
      'problem',
      problem('https://vendor.example/problems/custom', 409),
    )).toEqual({ valid: true, errors: [] });
    expect(validators.validate('problem', problem('unregistered_short_code', 409)).valid).toBe(false);
  });

  it('maps every Node guard denial to a registered code/status pair', () => {
    for (const denialCode of denialCodes) {
      const mapped = mapNodeWriteDenialToProblem(
        { code: denialCode },
        { authorizationFailure: 'insufficient_scope' },
      );
      expect(problemRegistry[mapped.code]).toEqual({
        status: mapped.status,
        retryable: mapped.retryable,
      });
    }
  });

  it('preserves concealment policy for authorization denials', () => {
    expect(mapNodeWriteDenialToProblem(
      { code: 'authorization_denied' },
      { authorizationFailure: 'insufficient_scope' },
    )).toEqual({ code: 'insufficient_scope', status: 403, retryable: false });
    expect(mapNodeWriteDenialToProblem(
      { code: 'authorization_denied' },
      { authorizationFailure: 'resource_not_found' },
    )).toEqual({ code: 'resource_not_found', status: 404, retryable: false });
  });

  it.each([
    ['node_read_only', 'node_read_only', 403],
    ['folder_not_empty', 'folder_not_empty', 409],
    ['node_ancestry_too_deep', 'payload_too_large', 413],
    ['node_subtree_too_large', 'payload_too_large', 413],
    ['parent_cycle', 'invalid_document', 422],
    ['node_ancestry_unresolved', 'internal_error', 500],
    ['affected_nodes_mismatch', 'internal_error', 500],
  ] as const)('maps %s to %s', (denialCode, code, status) => {
    expect(mapNodeWriteDenialToProblem(
      { code: denialCode },
      { authorizationFailure: 'resource_not_found' },
    )).toMatchObject({ code: code as ProblemCode, status });
  });
});
