import { types as nodeTypes } from 'node:util';

import { assertPlainStructuredData, assertPlainStructuredSource } from '../shared/plain-structured-data.js';

import { resolveRequestIdentities, type IdentityResolution } from '../security/index.js';
import {
  NodeWriteGuardError,
  executeGuardedNodeWrite,
  type GuardedNodeWriteMutation,
  type GuardedNodeWritePersistenceWriter,
  type GuardedNodeWritePlan,
  type NodeWriteGuardDecision,
  type NodeWriteLimits,
  type NodeWriteResolver,
} from '../server/node-write-guard.js';
import {
  getProblemDefinition,
  mapNodeWriteDenialToProblem,
  type NodeWriteProblemDefinition,
} from '../server/problems.js';
import type { PrincipalRef } from '../types/index.js';
import type { PublisherInternalFailureObserver } from './internal-failure.js';
import { notifyPublisherInternalFailureFromPorts } from './internal-failure.js';

export type PublisherNodeWriteAuthenticationDecision =
  | { readonly authenticated: true; readonly identityResolution: IdentityResolution }
  | { readonly authenticated: false };

export type PublisherNodeWriteAuthorizationDecision =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: string };

export type PublisherNodeWriteConcealmentDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly problem: 'insufficient_scope' | 'resource_not_found';
    };

export type PublisherNodeWriteAuthorizationSubject =
  | { readonly kind: 'request-target' }
  | {
      readonly kind: 'affected-node';
      readonly nodeId: string;
      readonly plan: GuardedNodeWritePlan;
    };

export interface PublisherNodeWriteConcealmentInput {
  readonly subject: PublisherNodeWriteAuthorizationSubject;
  readonly authorized: boolean;
}

/**
 * Framework-neutral security and application ports for one ordinary Node write.
 * Implementations decide authentication, authorization, and concealment; the
 * Core guard remains the sole owner of graph expansion and read-only semantics.
 */
export interface PublisherGuardedNodeWritePorts<
  Context extends NodeWriteResolver,
  Candidate,
  Result,
> {
  /** Commit only if the callback resolves; reject on rollback or unknown commit. */
  readonly unitOfWork: PublisherNodeWriteUnitOfWork<Context>;
  authenticate(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
  ): Promise<PublisherNodeWriteAuthenticationDecision>;
  authorize(
    context: Context,
    identities: readonly PrincipalRef[],
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    subject: PublisherNodeWriteAuthorizationSubject,
  ): Promise<PublisherNodeWriteAuthorizationDecision>;
  /**
   * Select visibility after each authorization decision. It may conceal an
   * otherwise authorized target, but it cannot turn an authorization denial
   * into an allow decision.
   */
  conceal(
    context: Context,
    identities: readonly PrincipalRef[],
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    input: PublisherNodeWriteConcealmentInput,
  ): Promise<PublisherNodeWriteConcealmentDecision>;
  /**
   * Optional HTTP gate for a business conflict discovered during Core
   * planning. It runs only after every affected-node Authorization and
   * Concealment decision. Returning a value gives the HTTP precondition
   * precedence; returning undefined allows the business conflict to surface.
   */
  beforeBusinessConflict?(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    plan: GuardedNodeWritePlan,
  ): Promise<Result | undefined>;
  validate(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
  ): Promise<NodeWriteGuardDecision>;
  /** Operation policy only; read-only policy must remain in the Core guard. */
  evaluatePolicy(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    nodeId: string,
    plan: GuardedNodeWritePlan,
  ): Promise<NodeWriteGuardDecision>;
  write: GuardedNodeWritePersistenceWriter<Context, Candidate, Result>;
  /**
   * Optional host hook invoked when this coordinator maps an unexpected failure
   * to registered internal_error. Never affects the wire Problem.
   */
  readonly onInternalFailure?: PublisherInternalFailureObserver;
}

export interface PublisherNodeWriteUnitOfWork<Context extends NodeWriteResolver> {
  run<WorkResult>(work: (context: Context) => Promise<WorkResult>): Promise<WorkResult>;
}

export type PublisherGuardedNodeWriteResult<Result> =
  | { readonly state: 'committed'; readonly value: Result }
  | ({ readonly state: 'rejected' } & NodeWriteProblemDefinition);

type PortMethods<Context extends NodeWriteResolver, Candidate, Result> = Omit<
  PublisherGuardedNodeWritePorts<Context, Candidate, Result>,
  'unitOfWork'
>;

type WorkEnvelope<Result> = PublisherGuardedNodeWriteResult<Result>;

/** Carries a concealed Problem across the transaction's rollback boundary. */
class PublisherNodeWriteRollback extends Error {
  constructor(readonly problem: NodeWriteProblemDefinition, cause: NodeWriteGuardError) {
    super('Publisher Node write must roll back before returning a Problem.', { cause });
    this.name = 'PublisherNodeWriteRollback';
  }
}

/**
 * Compose Authentication -> Authorization -> Concealment -> authoritative Core
 * guard ordering. A `node_read_only` result is therefore possible only after
 * every request/affected-node security gate has allowed the operation.
 */
export async function executePublisherGuardedNodeWrite<
  Candidate,
  Context extends NodeWriteResolver,
  Result,
>(
  candidate: Candidate,
  mutation: GuardedNodeWriteMutation,
  ports: PublisherGuardedNodeWritePorts<Context, Candidate, Result>,
  limits: NodeWriteLimits = {},
): Promise<PublisherGuardedNodeWriteResult<Result>> {
  try {
    const checkedCandidate = immutableSnapshot(candidate, 'Publisher Node write candidate');
    const checkedMutation = immutableSnapshot(mutation, 'Publisher Node write mutation');
    const checkedLimits = immutableSnapshot(limits, 'Publisher Node write limits');
    const checkedPorts = snapshotPorts(ports);

    let callbackCount = 0;
    let callbackActive = true;
    let completedEnvelope: WorkEnvelope<Result> | undefined;
    const pending = checkedPorts.runUnitOfWork(async (context) => {
      if (!callbackActive || callbackCount !== 0) {
        throw new TypeError('Publisher Node write unit of work invoked its callback more than once or too late.');
      }
      callbackCount += 1;
      completedEnvelope = await executeInContext(
        context,
        checkedCandidate,
        checkedMutation,
        checkedPorts,
        checkedLimits,
      );
      return completedEnvelope;
    });
    let outcome: WorkEnvelope<Result>;
    try {
      outcome = await requirePromise(pending, 'Publisher Node write unit of work');
    } finally {
      // A malformed UoW that settles before invoking work must never be able to
      // start the security/write pipeline later in a detached task.
      callbackActive = false;
    }
    if (callbackCount !== 1 || completedEnvelope === undefined || outcome !== completedEnvelope) {
      throw new TypeError('Publisher Node write unit of work did not durably return its callback result.');
    }
    return outcome;
  } catch (error) {
    // This catch runs after UoW rejection, never inside its commit callback.
    if (error instanceof PublisherNodeWriteRollback) {
      if (error.problem.code === 'internal_error') {
        await notifyPublisherInternalFailureFromPorts(ports, 'guarded-node-write', error.cause);
      }
      return rejectedProblem(error.problem);
    }
    await notifyPublisherInternalFailureFromPorts(
      ports,
      'guarded-node-write',
      error,
    );
    return rejectedProblem(problem('internal_error'));
  }
}

async function executeInContext<Candidate, Context extends NodeWriteResolver, Result>(
  context: Context,
  candidate: Readonly<Candidate>,
  mutation: GuardedNodeWriteMutation,
  ports: SnapshottedPorts<Context, Candidate, Result>,
  limits: NodeWriteLimits,
): Promise<WorkEnvelope<Result>> {
  const authentication = inspectAuthentication(await requirePromise(
    ports.authenticate(context, candidate, mutation),
    'Publisher Node write authentication port',
  ));
  if (!authentication.authenticated) {
    return rejectedProblem(problem('authentication_required'));
  }
  const identities = resolveRequestIdentities(authentication.identityResolution);
  if (identities.some((identity) => identity.type === 'public')) {
    throw new TypeError('Authenticated Publisher identities cannot contain the public principal.');
  }

  const targetSubject = Object.freeze({ kind: 'request-target' as const });
  const targetAuthorization = inspectAuthorization(await requirePromise(
    ports.authorize(context, identities, candidate, mutation, targetSubject),
    'Publisher Node write authorization port',
  ));
  const targetConcealment = await applyConcealment(
    ports,
    context,
    identities,
    candidate,
    mutation,
    targetSubject,
    targetAuthorization,
  );
  if (targetConcealment !== undefined) return rejectedProblem(targetConcealment);

  let concealedAffectedProblem: NodeWriteProblemDefinition | undefined;
  const inlineUnitOfWork = Object.freeze({
    async run<InlineResult>(work: (inlineContext: Context) => Promise<InlineResult>): Promise<InlineResult> {
      return requirePromise(work(context), 'Publisher inline Core guard work');
    },
  });

  try {
    const value = await executeGuardedNodeWrite(
      candidate,
      mutation,
      inlineUnitOfWork,
      {
        validate: async (guardContext, guardCandidate, guardMutation) => inspectGuardDecision(
          await requirePromise(
            ports.validate(guardContext, guardCandidate, guardMutation),
            'Publisher Node write validation port',
          ),
          'validation',
        ),
        preAuthorize: async () => Object.freeze({ allowed: true as const }),
        authorize: async (guardContext, guardCandidate, guardMutation, nodeId, plan) => {
          const subject = Object.freeze({ kind: 'affected-node' as const, nodeId, plan });
          const authorization = inspectAuthorization(await requirePromise(
            ports.authorize(guardContext, identities, guardCandidate, guardMutation, subject),
            'Publisher Node write affected-node authorization port',
          ));
          const concealed = await applyConcealment(
            ports,
            guardContext,
            identities,
            guardCandidate,
            guardMutation,
            subject,
            authorization,
          );
          if (concealed !== undefined) {
            concealedAffectedProblem = concealed;
            return Object.freeze({ allowed: false as const, reason: 'Publisher security gate denied.' });
          }
          return Object.freeze({ allowed: true as const });
        },
        evaluatePolicy: async (guardContext, guardCandidate, guardMutation, nodeId, plan) =>
          inspectGuardDecision(await requirePromise(
            ports.evaluatePolicy(guardContext, guardCandidate, guardMutation, nodeId, plan),
            'Publisher Node write policy port',
          ), 'policy'),
        ...(ports.beforeBusinessConflict === undefined ? {} : {
          beforeDeferredDenial: async (
            guardContext: Context,
            guardCandidate: Readonly<Candidate>,
            guardMutation: GuardedNodeWriteMutation,
            plan: GuardedNodeWritePlan,
          ) => {
            const early = await requirePromise(
              ports.beforeBusinessConflict!(guardContext, guardCandidate, guardMutation, plan),
              'Publisher Node write pre-conflict port',
            );
            if (early === undefined) return undefined;
            return Object.freeze({
              result: immutableSnapshot(early, 'Publisher Node write pre-conflict result'),
              modifiedNodeIds: plan.modifiedNodeIds,
              deletedNodeIds: plan.deletedNodeIds,
              deletedNodeCount: plan.deletedNodeCount,
            });
          },
        }),
      },
      ports.write,
      limits,
    );
    return Object.freeze({ state: 'committed' as const, value });
  } catch (error) {
    if (!(error instanceof NodeWriteGuardError)) throw error;
    if (error.denial.code === 'authorization_denied') {
      if (concealedAffectedProblem === undefined) {
        throw new TypeError('Core authorization denial lacks a concealment decision.');
      }
      throw new PublisherNodeWriteRollback(concealedAffectedProblem, error);
    }
    // Includes writer-outcome validation: a normal return here would commit
    // business writes even though the response claims the operation failed.
    throw new PublisherNodeWriteRollback(mapNodeWriteDenialToProblem(error.denial, {
      authorizationFailure: 'insufficient_scope',
    }), error);
  }
}

async function applyConcealment<Candidate, Context extends NodeWriteResolver, Result>(
  ports: SnapshottedPorts<Context, Candidate, Result>,
  context: Context,
  identities: readonly PrincipalRef[],
  candidate: Readonly<Candidate>,
  mutation: GuardedNodeWriteMutation,
  subject: PublisherNodeWriteAuthorizationSubject,
  authorization: PublisherNodeWriteAuthorizationDecision,
): Promise<NodeWriteProblemDefinition | undefined> {
  const input = Object.freeze({ subject, authorized: authorization.authorized });
  const concealment = inspectConcealment(await requirePromise(
    ports.conceal(context, identities, candidate, mutation, input),
    'Publisher Node write concealment port',
  ));
  if (!authorization.authorized && concealment.allowed) {
    throw new TypeError('Publisher concealment cannot allow an authorization denial.');
  }
  return concealment.allowed ? undefined : problem(concealment.problem);
}

interface SnapshottedPorts<Context extends NodeWriteResolver, Candidate, Result>
  extends PortMethods<Context, Candidate, Result> {
  runUnitOfWork<WorkResult>(work: (context: Context) => Promise<WorkResult>): Promise<WorkResult>;
}

function snapshotPorts<Context extends NodeWriteResolver, Candidate, Result>(
  ports: PublisherGuardedNodeWritePorts<Context, Candidate, Result>,
): SnapshottedPorts<Context, Candidate, Result> {
  if (ports === null || typeof ports !== 'object' || nodeTypes.isProxy(ports)) {
    throw new TypeError('Publisher Node write ports are required and cannot be a Proxy.');
  }
  const unitDescriptor = findDataProperty(ports, 'unitOfWork');
  const unitOfWork = unitDescriptor?.value;
  if (unitOfWork === null || typeof unitOfWork !== 'object' || nodeTypes.isProxy(unitOfWork)) {
    throw new TypeError('Publisher Node write unit of work is required and cannot be a Proxy.');
  }
  const beforeBusinessConflict = snapshotOptionalMethod<
    typeof ports.beforeBusinessConflict
  >(ports, 'beforeBusinessConflict');
  return Object.freeze({
    runUnitOfWork: snapshotMethod<PublisherNodeWriteUnitOfWork<Context>['run']>(unitOfWork, 'run'),
    authenticate: snapshotMethod<typeof ports.authenticate>(ports, 'authenticate'),
    authorize: snapshotMethod<typeof ports.authorize>(ports, 'authorize'),
    conceal: snapshotMethod<typeof ports.conceal>(ports, 'conceal'),
    ...(beforeBusinessConflict === undefined ? {} : { beforeBusinessConflict }),
    validate: snapshotMethod<typeof ports.validate>(ports, 'validate'),
    evaluatePolicy: snapshotMethod<typeof ports.evaluatePolicy>(ports, 'evaluatePolicy'),
    write: snapshotMethod<typeof ports.write>(ports, 'write'),
  });
}

function snapshotOptionalMethod<Method extends ((...args: any[]) => unknown) | undefined>(
  owner: object,
  name: string,
): Method {
  const descriptor = findDataProperty(owner, name);
  if (descriptor === undefined) return undefined as Method;
  if (typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`Publisher Node write ${name} port must be a non-Proxy data method.`);
  }
  const method = descriptor.value;
  return ((...args: unknown[]) => Reflect.apply(method, owner, args)) as Method;
}

function snapshotMethod<Method extends (...args: any[]) => unknown>(owner: object, name: string): Method {
  const descriptor = findDataProperty(owner, name);
  if (descriptor === undefined || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`Publisher Node write ${name} port must be a non-Proxy data method.`);
  }
  const method = descriptor.value as Method;
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findDataProperty(owner: object, name: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError('Publisher Node write port prototype cannot be a Proxy.');
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`Publisher Node write ${name} must be a data property.`);
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function inspectAuthentication(value: unknown): PublisherNodeWriteAuthenticationDecision {
  assertPlainDecision(value, 'authentication');
  if (value.authenticated === false) {
    assertExactKeys(value, ['authenticated'], 'authentication');
    return Object.freeze({ authenticated: false });
  }
  if (value.authenticated !== true) throw new TypeError('Publisher authentication must explicitly decide.');
  assertExactKeys(value, ['authenticated', 'identityResolution'], 'authentication');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'identityResolution');
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('Publisher authentication identityResolution must be a data property.');
  }
  // The Security contract performs the authoritative, fail-closed snapshot.
  resolveRequestIdentities(descriptor.value as IdentityResolution);
  return Object.freeze({ authenticated: true, identityResolution: descriptor.value as IdentityResolution });
}

function inspectAuthorization(value: unknown): PublisherNodeWriteAuthorizationDecision {
  assertPlainDecision(value, 'authorization');
  if (value.authorized === true) {
    assertExactKeys(value, ['authorized'], 'authorization');
    return Object.freeze({ authorized: true });
  }
  if (value.authorized !== false || typeof value.reason !== 'string' || value.reason.length === 0) {
    throw new TypeError('Publisher authorization must explicitly allow or deny with a reason.');
  }
  assertExactKeys(value, ['authorized', 'reason'], 'authorization');
  return Object.freeze({ authorized: false, reason: value.reason });
}

function inspectConcealment(value: unknown): PublisherNodeWriteConcealmentDecision {
  assertPlainDecision(value, 'concealment');
  if (value.allowed === true) {
    assertExactKeys(value, ['allowed'], 'concealment');
    return Object.freeze({ allowed: true });
  }
  if (value.allowed !== false
    || (value.problem !== 'insufficient_scope' && value.problem !== 'resource_not_found')) {
    throw new TypeError('Publisher concealment must allow or select a registered authorization Problem.');
  }
  assertExactKeys(value, ['allowed', 'problem'], 'concealment');
  return Object.freeze({ allowed: false, problem: value.problem });
}

function inspectGuardDecision(value: unknown, label: string): NodeWriteGuardDecision {
  assertPlainDecision(value, label);
  if (value.allowed === true) {
    assertExactKeys(value, ['allowed'], label);
    return Object.freeze({ allowed: true });
  }
  if (value.allowed !== false || typeof value.reason !== 'string' || value.reason.length === 0) {
    throw new TypeError(`Publisher ${label} must explicitly allow or deny with a reason.`);
  }
  assertExactKeys(value, ['allowed', 'reason'], label);
  return Object.freeze({ allowed: false, reason: value.reason });
}

function assertPlainDecision(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Publisher ${label} decision must be a plain non-Proxy object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Publisher ${label} decision must contain only enumerable data properties.`);
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError(`Publisher ${label} decision contains unknown or missing fields.`);
  }
}

function immutableSnapshot<Value>(value: Value, label: string): Readonly<Value> {
  let snapshot: Value;
  try {
    assertPlainStructuredSource(value, label);
    snapshot = structuredClone(value) as Value;
  } catch {
    throw new TypeError(`${label} must contain cloneable plain structured data.`);
  }
  assertPlainStructuredData(snapshot, label);
  return deepFreeze(snapshot);
}


function deepFreeze<Value>(value: Value, visited = new WeakSet<object>()): Readonly<Value> {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  // Own enumerable string keys only (same set as Object.values; no temp values array).
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key], visited);
  }
  return Object.freeze(value);
}

function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}

function problem(code: 'authentication_required' | 'insufficient_scope' | 'resource_not_found' | 'internal_error'):
NodeWriteProblemDefinition {
  return Object.freeze({ code, ...getProblemDefinition(code) });
}

function rejectedProblem<Result>(definition: NodeWriteProblemDefinition): PublisherGuardedNodeWriteResult<Result> {
  return Object.freeze({ state: 'rejected' as const, ...definition });
}
