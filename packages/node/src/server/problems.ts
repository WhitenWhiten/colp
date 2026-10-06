import { types as nodeTypes } from 'node:util';

import type { NodeWriteGuardDenial, NodeWriteGuardDenialCode } from './node-write-guard.js';
import type {
  PublisherWritePreconditionFailure,
  PublisherWritePreconditionResult,
} from '../publisher/preconditions.js';
import {
  getProblemDefinition,
  type ProblemCode,
} from '../shared/problems.js';

export {
  getProblemDefinition,
  problemRegistry,
  type ProblemCode,
} from '../shared/problems.js';

export interface NodeWriteProblemMappingContext {
  /** Result selected by endpoint Authentication, Authorization, and Concealment Policy. */
  readonly authorizationFailure: 'insufficient_scope' | 'resource_not_found';
}

export interface NodeWriteProblemDefinition {
  readonly code: ProblemCode;
  readonly status: number;
  readonly retryable: boolean;
}

/**
 * Maps a Publisher precondition rejection to the registered wire Problem.
 *
 * The evaluator carries authoritative revision/ETag values for adapters that
 * have already passed concealment and authorization.  This boundary exposes
 * only the stable Problem contract, so a caller cannot accidentally disclose
 * hidden-resource state while selecting the HTTP status.
 */
export function mapPublisherPreconditionToProblem(
  failure: Pick<PublisherWritePreconditionFailure, 'code' | 'status'>
    & Partial<Pick<PublisherWritePreconditionFailure, 'currentRevision' | 'currentEtag'>>,
): NodeWriteProblemDefinition {
  const snapshot = snapshotPublisherPreconditionFailure(failure);
  const code = snapshot.code;
  if (code !== 'precondition_required' && code !== 'precondition_failed') {
    throw new TypeError('Publisher precondition failure has an invalid Problem code.');
  }
  const definition = getProblemDefinition(code);
  if (snapshot.status !== definition.status) {
    throw new TypeError('Publisher precondition failure status does not match its Problem code.');
  }
  if (snapshot.currentRevision !== undefined && (typeof snapshot.currentRevision !== 'string'
    || snapshot.currentRevision.length === 0 || /[\r\n\u0000]/u.test(snapshot.currentRevision))) {
    throw new TypeError('Publisher precondition failure current revision is invalid.');
  }
  if (snapshot.currentEtag !== undefined
    && (typeof snapshot.currentEtag !== 'string' || snapshot.currentEtag.length === 0
      || /[\r\n\u0000]/u.test(snapshot.currentEtag))) {
    throw new TypeError('Publisher precondition failure current ETag is invalid.');
  }
  // Validators are carried by the evaluator for an authorized adapter to put
  // into response headers/recovery; the stable Problem mapper must not echo
  // them and accidentally disclose state from a concealed resource.
  return Object.freeze({ code, ...definition });
}

function snapshotPublisherPreconditionFailure(
  failure: Pick<PublisherWritePreconditionFailure, 'code' | 'status'>
    & Partial<Pick<PublisherWritePreconditionFailure, 'currentRevision' | 'currentEtag'>>,
): Readonly<typeof failure> {
  if (failure === null || typeof failure !== 'object' || Array.isArray(failure)
    || nodeTypes.isProxy(failure) || Object.getPrototypeOf(failure) !== Object.prototype) {
    throw new TypeError('Publisher precondition failure must be a plain data object.');
  }
  const allowedKeys = new Set(['state', 'code', 'status', 'currentRevision', 'currentEtag']);
  const keys = Reflect.ownKeys(failure);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || !Object.hasOwn(failure, 'code') || !Object.hasOwn(failure, 'status')) {
    throw new TypeError('Publisher precondition failure contains unknown or missing fields.');
  }
  const dataValue = (key: 'state' | 'code' | 'status' | 'currentRevision' | 'currentEtag'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(failure, key);
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Publisher precondition failure ${key} must be an enumerable data property.`);
    }
    return descriptor.value;
  };
  const state = dataValue('state');
  if (state !== undefined && state !== 'rejected') {
    throw new TypeError('Publisher precondition failure state is invalid.');
  }
  const currentRevision = dataValue('currentRevision');
  const currentEtag = dataValue('currentEtag');
  return Object.freeze({
    code: dataValue('code') as PublisherWritePreconditionFailure['code'],
    status: dataValue('status') as PublisherWritePreconditionFailure['status'],
    ...(currentRevision === undefined ? {} : { currentRevision: currentRevision as string }),
    ...(currentEtag === undefined ? {} : { currentEtag: currentEtag as string }),
  });
}

/**
 * Selects the wire outcome after the HTTP If-Match gate and business checks.
 * A revision conflict is legal only after the evaluator has returned satisfied;
 * malformed or unknown outcomes fail closed rather than becoming a 409.
 */
export function mapPublisherWriteConflictToProblem(
  precondition: PublisherWritePreconditionResult,
  businessConflict: boolean,
): NodeWriteProblemDefinition | undefined {
  if (precondition === null || typeof precondition !== 'object' || typeof businessConflict !== 'boolean') {
    throw new TypeError('Publisher write conflict input is invalid.');
  }
  assertPublisherWritePreconditionResultShape(precondition);
  if (precondition.state === 'rejected') {
    return mapPublisherPreconditionToProblem(precondition);
  }
  if (precondition.state !== 'satisfied' || precondition.status !== 200
    || !['etag', 'revision', 'wildcard', 'not-required'].includes(precondition.matched)) {
    throw new TypeError('Publisher precondition result is unknown or malformed.');
  }
  return businessConflict
    ? Object.freeze({ code: 'revision_conflict' as const, ...getProblemDefinition('revision_conflict') })
    : undefined;
}

function assertPublisherWritePreconditionResultShape(precondition: object): void {
  if (nodeTypes.isProxy(precondition) || Object.getPrototypeOf(precondition) !== Object.prototype) {
    throw new TypeError('Publisher precondition result must be a plain object.');
  }
  const stateDescriptor = Object.getOwnPropertyDescriptor(precondition, 'state');
  if (stateDescriptor === undefined || !('value' in stateDescriptor)) {
    throw new TypeError('Publisher precondition result state must be a data property.');
  }
  const allowed = stateDescriptor.value === 'rejected'
    ? new Set(['state', 'status', 'code', 'currentRevision', 'currentEtag'])
    : new Set(['state', 'status', 'matched']);
  for (const key of Reflect.ownKeys(precondition)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Publisher precondition result contains an unsupported property.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(precondition, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Publisher precondition result ${key} must be an enumerable data property.`);
    }
  }
}

const nodeWriteProblemCodeByDenial = {
  invalid_node_mutation: 'invalid_document',
  authorization_denied: undefined,
  collection_unresolved: 'resource_not_found',
  node_unresolved: 'resource_not_found',
  node_already_exists: 'revision_conflict',
  node_ancestry_unresolved: 'internal_error',
  parent_cycle: 'invalid_document',
  node_ancestry_cycle: 'internal_error',
  node_ancestry_too_deep: 'payload_too_large',
  node_subtree_cycle: 'internal_error',
  node_subtree_unresolved: 'internal_error',
  node_subtree_too_deep: 'payload_too_large',
  node_subtree_too_large: 'payload_too_large',
  node_collection_mismatch: 'invalid_document',
  invalid_parent_kind: 'invalid_document',
  root_invariant: 'invalid_document',
  invalid_node_constraints: 'internal_error',
  node_read_only: 'node_read_only',
  node_policy_denied: 'insufficient_scope',
  folder_not_empty: 'folder_not_empty',
  affected_nodes_mismatch: 'internal_error',
} as const satisfies Readonly<Record<NodeWriteGuardDenialCode, ProblemCode | undefined>>;

/** Maps an internal guard denial to a registered wire Problem after concealment is known. */
export function mapNodeWriteDenialToProblem(
  denial: Pick<NodeWriteGuardDenial, 'code'>,
  context: NodeWriteProblemMappingContext,
): NodeWriteProblemDefinition {
  const code = denial.code === 'authorization_denied'
    ? context.authorizationFailure
    : nodeWriteProblemCodeByDenial[denial.code];
  if (code === undefined) throw new TypeError(`No wire Problem mapping for ${denial.code}.`);
  return Object.freeze({ code, ...getProblemDefinition(code) });
}
