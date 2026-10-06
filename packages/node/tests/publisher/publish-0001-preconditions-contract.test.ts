import { describe, expect, it } from 'vitest';

import { endpointContracts } from '../../src/semantic/endpoint-contracts.js';
import { mapNodeWriteDenialToProblem } from '../../src/server/problems.js';
import { getProblemDefinition, problemRegistry } from '../../src/shared/problems.js';
import { evaluatePublisherWritePrecondition } from '../../src/publisher/preconditions.js';

const evidence = 'publisher.preconditions';
type ContractOperation = {
  readonly profile?: string;
  readonly method: string;
  readonly request?: string;
  readonly requiredRequestHeaders?: readonly string[];
};

describe(`PUBLISH-0001 existing-resource preconditions [evidence:${evidence}]`, () => {
  it(`requires If-Match for every publisher operation that mutates an existing resource [evidence:${evidence}]`, () => {
    const existingResourceWrites = Object.values(endpointContracts)
      .flatMap((endpoint) => endpoint.operations as readonly ContractOperation[])
      .filter((operation) => operation.profile === 'publisher')
      .filter((operation) => operation.method === 'PATCH' || operation.method === 'DELETE'
        || (operation.method === 'POST' && (operation.request === 'nodeMoveRequest' || operation.request === 'releaseCreate')));

    expect(existingResourceWrites.length).toBeGreaterThan(0);
    for (const operation of existingResourceWrites) {
      expect(operation.requiredRequestHeaders, `${operation.method} ${operation.request ?? 'delete'}`)
        .toContain('If-Match');
    }
  });

  it(`keeps missing and failed If-Match distinct from a domain conflict [evidence:${evidence}]`, () => {
    expect(problemRegistry.precondition_required).toEqual({ status: 428, retryable: true });
    expect(problemRegistry.precondition_failed).toEqual({ status: 412, retryable: true });
    expect(problemRegistry.revision_conflict).toEqual({ status: 409, retryable: false });
    expect(getProblemDefinition('precondition_required').status).toBe(428);
    expect(getProblemDefinition('precondition_failed').status).toBe(412);
    expect(getProblemDefinition('revision_conflict').status).toBe(409);
  });

  it(`preserves authorization and concealment ordering for read-only denials [evidence:${evidence}]`, () => {
    expect(mapNodeWriteDenialToProblem({ code: 'authorization_denied' }, {
      authorizationFailure: 'insufficient_scope',
    })).toMatchObject({ code: 'insufficient_scope', status: 403 });
    expect(mapNodeWriteDenialToProblem({ code: 'authorization_denied' }, {
      authorizationFailure: 'resource_not_found',
    })).toMatchObject({ code: 'resource_not_found', status: 404 });
    expect(mapNodeWriteDenialToProblem({ code: 'node_read_only' }, {
      authorizationFailure: 'insufficient_scope',
    })).toMatchObject({ code: 'node_read_only', status: 403 });
  });

  it(`does not expose internal principal or read-only details through mapped problems [evidence:${evidence}]`, () => {
    const mapped = mapNodeWriteDenialToProblem({ code: 'node_read_only' }, {
      authorizationFailure: 'resource_not_found',
    });
    expect(JSON.stringify(mapped)).not.toContain('resource_not_found');
    expect(JSON.stringify(mapped)).not.toContain('principal');
    expect(JSON.stringify(mapped)).not.toContain('read-only');
  });

  it(`evaluates HTTP If-Match fail-closed and lets creates bypass only the existing-resource gate [evidence:${evidence}]`, () => {
    const base = { existingResource: true, currentRevision: 'rev-2', currentEtag: '"etag-2"' } as const;
    expect(evaluatePublisherWritePrecondition({ ...base })).toMatchObject({ status: 428, code: 'precondition_required' });
    expect(evaluatePublisherWritePrecondition({ ...base, ifMatch: '"etag-2"' })).toMatchObject({ status: 200, matched: 'etag' });
    expect(evaluatePublisherWritePrecondition({ ...base, ifMatch: '"rev-2"' })).toMatchObject({ status: 200, matched: 'revision' });
    expect(evaluatePublisherWritePrecondition({ ...base, ifMatch: '*' })).toMatchObject({ status: 200, matched: 'wildcard' });
    expect(evaluatePublisherWritePrecondition({ ...base, ifMatch: 'rev-2' })).toMatchObject({ status: 412, code: 'precondition_failed' });
    expect(evaluatePublisherWritePrecondition({ ...base, ifMatch: '"etag-2", malformed' })).toMatchObject({ status: 412, code: 'precondition_failed' });
    expect(evaluatePublisherWritePrecondition({ ...base, existingResource: false })).toMatchObject({ status: 200, matched: 'not-required' });
  });
});
