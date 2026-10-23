/** Snapshots and validates operation payloads, revisions, execution results and impact. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { createValidatorRegistry } from '../schema/index.js';
import { encodePlainCanonicalJson } from '../shared/plain-canonical-json.js';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  ChangePlanRequest,
  OperationResult,
} from '../types/generated.js';
import type { ResolvedServiceOptions } from './change-plan-options.js';
import type { McpChangePlanCommitTransaction, McpChangePlanRevisionMap } from './change-plan-types.js';
import { MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH, McpChangePlanError } from './change-plan-types.js';
import { snapshotMcpData, type McpWriteInputBudget } from './safe-data.js';
import { type McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';

const validators = createValidatorRegistry();

const NativePromise = Promise;

const nativePromisePrototype = Promise.prototype;

const nativePromiseThen = Promise.prototype.then;

const nativePromiseSpeciesGetter = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

const untrustedNoteControlCharacter = /[\u0000-\u001F\u007F]/u;

export function computeOperationsDigest(operations: readonly unknown[]): string {
  const canonical = encodePlainCanonicalJson(operations);
  if (canonical === undefined) {
    throw new McpChangePlanError('invalid_plan_request', 'Operations are not JSON-canonicalizable.');
  }
  return `sha-256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

export function validatePlanRequest(
  request: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): ChangePlanRequest {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(request, inputBudget);
  } catch {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan request exceeds the configured JSON resource budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request must be an object.');
  }

  // Reject open payload guessing: operations must be typed discriminant unions.
  const opsDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'operations');
  if (opsDescriptor === undefined || !('value' in opsDescriptor) || !Array.isArray(opsDescriptor.value)) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request requires operations[].');
  }
  if (opsDescriptor.value.length > inputBudget.maxOperations) {
    throw new McpChangePlanError('invalid_plan_request', 'Change plan request exceeds the operation budget.');
  }
  for (const operation of opsDescriptor.value as unknown[]) {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw new McpChangePlanError('invalid_plan_request', 'Each operation must be a typed object.');
    }
    if (Object.prototype.hasOwnProperty.call(operation, 'payload')) {
      throw new McpChangePlanError(
        'open_payload_rejected',
        'Open payload operations are rejected; use typed changePlanOperation discriminants.',
      );
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(operation, 'type');
    if (
      typeDescriptor === undefined
      || !('value' in typeDescriptor)
      || typeof typeDescriptor.value !== 'string'
    ) {
      throw new McpChangePlanError('invalid_plan_request', 'Each operation requires a type discriminant.');
    }
  }

  const reasonDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'reason');
  if (reasonDescriptor === undefined
    || !('value' in reasonDescriptor)
    || typeof reasonDescriptor.value !== 'string'
    || reasonDescriptor.value.length > MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH
    || untrustedNoteControlCharacter.test(reasonDescriptor.value)) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan reason is an untrusted note and must not contain control characters or exceed 1000 characters.',
    );
  }

  const structural = validators.validate('changePlanRequest', snapshot);
  if (!structural.valid) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'Change plan request failed changePlanRequest schema validation.',
    );
  }

  return snapshot as ChangePlanRequest;
}

export function assertKeyRevealCapability(
  operations: readonly ChangePlanOperation[],
  revealUriForKey: ((keyId: string) => string) | undefined,
): void {
  if (revealUriForKey !== undefined) return;
  if (operations.some(({ type }) => type === 'create_key' || type === 'rotate_key')) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      'create_key and rotate_key Plans require a host-owned revealUriForKey boundary.',
    );
  }
}

export async function resolveBaseRevisions<
  Transaction extends McpChangePlanCommitTransaction,
>(
  operations: readonly ChangePlanOperation[],
  binding: McpAuthenticatedAuthorizationBinding,
  port: ResolvedServiceOptions<Transaction>['revisions'],
  inputBudget: Required<McpWriteInputBudget>,
): Promise<McpChangePlanRevisionMap> {
  const revisions = new Map<string, string>();
  for (const operation of operations) {
    const candidate = Reflect.apply(port.resolveBaseRevisions, port.receiver, [operation, binding]);
    const resolved = await resolveRevisionMap(candidate, 'plan', inputBudget);
    assertOperationRevisionCoverage(operation, resolved);

    for (const [namespace, revision] of Object.entries(resolved)) {
      const prior = revisions.get(namespace);
      if (prior !== undefined && prior !== revision) {
        throw new McpChangePlanError(
          'invalid_plan_request',
          `Revision resolver returned conflicting values for namespace ${namespace}.`,
        );
      }
      revisions.set(namespace, revision);
    }
  }
  return Object.freeze(Object.fromEntries(revisions));
}

export async function resolveRevisionMap(
  candidate: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): Promise<McpChangePlanRevisionMap> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) throw invalidRevisionMap(phase);
    if (nodeTypes.isPromise(candidate)) {
      const settled = await new Promise<unknown>((resolve, reject) => {
        Reflect.apply(Promise.prototype.then, candidate, [resolve, reject]);
      });
      return readRevisionMap(settled, phase, inputBudget);
    }
  }
  return readRevisionMap(candidate, phase, inputBudget);
}

function readRevisionMap(
  value: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): McpChangePlanRevisionMap {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(value, inputBudget);
  } catch {
    throw invalidRevisionMap(phase);
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw invalidRevisionMap(phase);
  }

  const entries: [string, string][] = [];
  for (const [namespace, revision] of Object.entries(snapshot)) {
    // baseRevisions is a resource-keyed map: the protocol constrains values,
    // not property names, to opaqueId. Namespace syntax remains host-owned.
    if (typeof revision !== 'string'
      || !validators.validate('opaqueId', revision).valid) {
      throw invalidRevisionMap(phase);
    }
    entries.push([namespace, revision]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function invalidRevisionMap(phase: 'plan' | 'commit'): McpChangePlanError {
  return new McpChangePlanError(
    phase === 'plan' ? 'invalid_plan_request' : 'commit_failed',
    `Revision resolver returned an invalid canonical namespace map during ${phase}.`,
  );
}

export async function resolveOperationResults(
  candidate: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): Promise<readonly OperationResult[]> {
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    if (nodeTypes.isProxy(candidate)) throw invalidOperationResults();
    if (nodeTypes.isPromise(candidate)) {
      let settled: unknown;
      try {
        assertUnmodifiedNativePromise(candidate);
        settled = await new NativePromise<unknown>((resolve, reject) => {
          Reflect.apply(nativePromiseThen, candidate, [resolve, reject]);
        });
      } catch {
        throw invalidOperationResults();
      }
      return readOperationResults(settled, inputBudget);
    }
  }
  return readOperationResults(candidate, inputBudget);
}

function assertUnmodifiedNativePromise(candidate: object): void {
  if (Object.getOwnPropertyDescriptor(candidate, 'constructor') !== undefined
    || Object.getPrototypeOf(candidate) !== nativePromisePrototype) {
    throw invalidOperationResults();
  }

  const thenDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'then');
  const constructorDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor');
  const speciesDescriptor = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species);
  if (thenDescriptor === undefined
    || !('value' in thenDescriptor)
    || thenDescriptor.value !== nativePromiseThen
    || constructorDescriptor === undefined
    || !('value' in constructorDescriptor)
    || constructorDescriptor.value !== NativePromise
    || speciesDescriptor === undefined
    || !('get' in speciesDescriptor)
    || speciesDescriptor.get !== nativePromiseSpeciesGetter) {
    throw invalidOperationResults();
  }
}

function readOperationResults(
  value: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): readonly OperationResult[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(value, inputBudget);
  } catch {
    throw invalidOperationResults();
  }
  if (!Array.isArray(snapshot)) throw invalidOperationResults();
  if (snapshot.length > inputBudget.maxOperations) throw invalidOperationResults();

  for (const operationResult of snapshot) {
    if (!validators.validate('operationResult', operationResult).valid) {
      throw invalidOperationResults();
    }
  }
  return snapshot as readonly OperationResult[];
}

function invalidOperationResults(): McpChangePlanError {
  return new McpChangePlanError(
    'commit_failed',
    'Executor returned an invalid canonical Operation result array.',
  );
}

function assertOperationRevisionCoverage(
  operation: ChangePlanOperation,
  resolved: McpChangePlanRevisionMap,
): void {
  if (!('baseRevision' in operation)) return;

  const entries = Object.entries(resolved);
  if (!entries.some(([, revision]) => revision === operation.baseRevision)) {
    throw new McpChangePlanError(
      'invalid_plan_request',
      `Revision resolver omitted the declared base revision for ${operation.type}.`,
    );
  }

  if (operation.type === 'set_visibility' || operation.type === 'set_access_policy') {
    if (resolved[operation.collectionId] === operation.baseRevision) {
      throw new McpChangePlanError(
        'invalid_plan_request',
        `Revision resolver must not alias the ${operation.type} access revision as the bare collection revision.`,
      );
    }
  }
}

export function buildSummary(
  operations: readonly ChangePlanOperation[],
  impact: ChangePlanImpact,
): string {
  const types = operations.map((op) => op.type).join(', ');
  return `Plan ${operations.length} canonical operation(s) [${types}]. Authoritative impact: `
    + `${impact.collections} collection(s), ${impact.nodes} node(s), `
    + `${impact.annotations} annotation(s), ${impact.attachments} attachment(s), `
    + `${impact.relations} relation(s).`;
}

function freezeImpact(
  impact: unknown,
  inputBudget: Required<McpWriteInputBudget>,
): ChangePlanImpact {
  const snapshot = snapshotMcpData(impact, inputBudget);
  if (!validators.validate('changePlanImpact', snapshot).valid) {
    throw new TypeError('Impact is not a canonical changePlanImpact.');
  }
  const canonical = snapshot as ChangePlanImpact;
  return Object.freeze({
    collections: canonical.collections,
    nodes: canonical.nodes,
    annotations: canonical.annotations,
    attachments: canonical.attachments,
    relations: canonical.relations,
    privateFieldsExcluded: [...canonical.privateFieldsExcluded],
  });
}

export async function resolveImpact(
  candidate: unknown,
  phase: 'plan' | 'commit',
  inputBudget: Required<McpWriteInputBudget>,
): Promise<ChangePlanImpact> {
  try {
    if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
      if (nodeTypes.isProxy(candidate)) throw new TypeError('Proxy impact');
      if (nodeTypes.isPromise(candidate)) {
        assertUnmodifiedNativePromise(candidate);
        const settled = await new NativePromise<unknown>((resolve, reject) => {
          Reflect.apply(nativePromiseThen, candidate, [resolve, reject]);
        });
        return freezeImpact(settled, inputBudget);
      }
    }
    return freezeImpact(candidate, inputBudget);
  } catch {
    throw new McpChangePlanError(
      phase === 'plan' ? 'invalid_plan_request' : 'commit_failed',
      `Impact port returned an invalid canonical result during ${phase}.`,
    );
  }
}

export function impactExceeds(planned: ChangePlanImpact, live: ChangePlanImpact): boolean {
  // `privateFieldsExcluded` is a protection set, not an ordinary count.  A
  // live assessment that omits any field excluded by the approved plan would
  // expose more private data even when all numeric counters are unchanged.
  const liveExcluded = new Set(live.privateFieldsExcluded);
  return (
    live.collections > planned.collections
    || live.nodes > planned.nodes
    || live.annotations > planned.annotations
    || live.attachments > planned.attachments
    || live.relations > planned.relations
    || planned.privateFieldsExcluded.some((field) => !liveExcluded.has(field))
  );
}

export function revisionsMatch(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  const expectedKeys = Object.keys(expected);
  if (Object.keys(actual).length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) return false;
  }
  return true;
}
