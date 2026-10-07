import { types as nodeTypes } from 'node:util';

import { createValidatorRegistry, validateWireDocument } from '../schema/index.js';
import type { Problem } from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';
import { getProblemDefinition, problemRegistry, type ProblemCode } from './problems.js';
import { createPublicationJsonResponse } from './publication-http-utf8.js';

export const PUBLICATION_PROBLEM_CONTENT_TYPE = 'application/problem+json' as const;

const CORE_PROBLEM_TYPE_BASE = 'https://know-n.com/colp/problems/';
const MAX_EXTENSION_CODE_LENGTH = 2_048;
const MAX_PROBLEM_BODY_BYTES = 65_536;
const MAX_RECOVERY_ARRAY_ITEMS = 64;
const validators = createValidatorRegistry();
const acceptSemantics = (): { readonly valid: true; readonly issues: readonly [] } => ({
  valid: true,
  issues: [],
});

export interface PublicationProblemRecovery {
  readonly currentRevision?: string;
  readonly currentEtag?: string;
  readonly expectedSequence?: number;
  readonly supportedVersions?: readonly string[];
  readonly retryAfterSeconds?: number;
  readonly snapshotUrl?: string;
  readonly conflictId?: string;
  readonly errors?: readonly PublicationProblemFieldError[];
  readonly links?: Readonly<Record<string, string>>;
}

export interface PublicationProblemFieldError {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface CorePublicationProblemInput {
  readonly code: ProblemCode;
  readonly recovery?: PublicationProblemRecovery;
}

export interface ExtensionPublicationProblemInput {
  readonly code: string;
  readonly status: number;
  readonly retryable?: boolean;
  readonly recovery?: PublicationProblemRecovery;
}

export type PublicationProblemInput = CorePublicationProblemInput | ExtensionPublicationProblemInput;

export interface PublicationProblemDescriptor {
  readonly status: number;
  readonly headers: Readonly<{ 'content-type': typeof PUBLICATION_PROBLEM_CONTENT_TYPE }>;
  readonly problem: Readonly<Problem>;
}

/**
 * Builds a Publication Problem without accepting human-authored wire text.
 * Applications that expose reviewed detail text must add it in a separate,
 * authorization-aware layer rather than passing exception messages here.
 */
export function createPublicationProblemDescriptor(
  input: PublicationProblemInput,
): PublicationProblemDescriptor {
  assertStrictInput(input);
  const code = input.code;
  const coreDefinition = isProblemCode(code) ? getProblemDefinition(code) : undefined;
  if (coreDefinition === undefined) assertHttpsExtensionCode(code);

  const status = coreDefinition?.status ?? assertHttpErrorStatus(
    (input as ExtensionPublicationProblemInput).status,
  );
  const retryable = coreDefinition?.retryable ?? (input as ExtensionPublicationProblemInput).retryable;
  const recovery = cloneRecovery(input.recovery);
  const problemCandidate = {
    type: coreDefinition === undefined ? code : `${CORE_PROBLEM_TYPE_BASE}${code.replaceAll('_', '-')}`,
    title: code,
    status,
    code,
    ...(retryable === undefined ? {} : { retryable }),
    ...recovery,
  };
  if (new TextEncoder().encode(JSON.stringify(problemCandidate)).byteLength > MAX_PROBLEM_BODY_BYTES) {
    throw new RangeError(`Publication Problem body must not exceed ${MAX_PROBLEM_BODY_BYTES} bytes.`);
  }
  const validation = validateWireDocument<Problem, never>(
    validators,
    'problem',
    problemCandidate,
    acceptSemantics,
  );
  if (!validation.valid) {
    const message = validation.stage === 'structural'
      ? validation.errors[0]?.message
      : validation.issues[0];
    throw new TypeError(`Publication Problem input is not wire-valid: ${String(message ?? 'invalid input')}.`);
  }

  const problem = deepFreeze(structuredClone(validation.value));
  return Object.freeze({
    status,
    headers: Object.freeze({ 'content-type': PUBLICATION_PROBLEM_CONTENT_TYPE }),
    problem,
  });
}

/** Creates a fresh, one-shot Fetch Response suitable for an HTTP adapter. */
export function createPublicationProblemResponse(input: PublicationProblemInput): Response {
  const descriptor = createPublicationProblemDescriptor(input);
  return createPublicationJsonResponse(descriptor.problem, {
    status: descriptor.status,
    headers: descriptor.headers,
  });
}

function assertStrictInput(input: PublicationProblemInput): void {
  assertPlainDataObject(input, 'Publication Problem input');
  assertOnlyDataProperties(
    input,
    new Set(['code', 'status', 'retryable', 'recovery']),
    'Publication Problem input',
  );
  if (typeof input.code !== 'string' || input.code.length === 0) {
    throw new TypeError('Publication Problem code must be a non-empty string.');
  }
  if (isProblemCode(input.code) && ('status' in input || 'retryable' in input)) {
    throw new TypeError('Registered Publication Problem status and retryable are determined by the registry.');
  }
}

function cloneRecovery(recovery: PublicationProblemRecovery | undefined): PublicationProblemRecovery {
  if (recovery === undefined) return Object.freeze({});
  assertPlainDataObject(recovery, 'Publication Problem recovery');
  assertOnlyDataProperties(
    recovery,
    new Set([
      'currentRevision',
      'currentEtag',
      'expectedSequence',
      'supportedVersions',
      'retryAfterSeconds',
      'snapshotUrl',
      'conflictId',
      'errors',
      'links',
    ]),
    'Publication Problem recovery',
  );
  const safeRecovery = recovery as PublicationProblemRecovery;
  if (safeRecovery.supportedVersions !== undefined) {
    assertDataArray(safeRecovery.supportedVersions, 'Publication Problem recovery.supportedVersions');
  }
  if (safeRecovery.errors !== undefined) {
    assertDataArray(safeRecovery.errors, 'Publication Problem recovery.errors');
    for (const error of safeRecovery.errors) {
      assertPlainDataObject(error, 'Publication Problem recovery.errors item');
      assertOnlyDataProperties(
        error,
        new Set(['path', 'keyword', 'message']),
        'Publication Problem recovery.errors item',
      );
    }
  }
  if (safeRecovery.links !== undefined) {
    assertPlainDataObject(safeRecovery.links, 'Publication Problem recovery.links');
    if (Object.keys(safeRecovery.links).length > MAX_RECOVERY_ARRAY_ITEMS) {
      throw new RangeError(
        `Publication Problem recovery.links must not contain more than ${MAX_RECOVERY_ARRAY_ITEMS} entries.`,
      );
    }
    assertOnlyDataProperties(
      safeRecovery.links,
      new Set(Object.keys(safeRecovery.links)),
      'Publication Problem recovery.links',
    );
  }
  return {
    ...(safeRecovery.currentRevision === undefined ? {} : { currentRevision: safeRecovery.currentRevision }),
    ...(safeRecovery.currentEtag === undefined ? {} : { currentEtag: safeRecovery.currentEtag }),
    ...(safeRecovery.expectedSequence === undefined ? {} : { expectedSequence: safeRecovery.expectedSequence }),
    ...(safeRecovery.supportedVersions === undefined
      ? {}
      : { supportedVersions: [...safeRecovery.supportedVersions] }),
    ...(safeRecovery.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: safeRecovery.retryAfterSeconds }),
    ...(safeRecovery.snapshotUrl === undefined ? {} : { snapshotUrl: safeRecovery.snapshotUrl }),
    ...(safeRecovery.conflictId === undefined ? {} : { conflictId: safeRecovery.conflictId }),
    ...(safeRecovery.errors === undefined
      ? {}
      : { errors: safeRecovery.errors.map((error) => ({ ...error })) }),
    ...(safeRecovery.links === undefined ? {} : { links: { ...safeRecovery.links } }),
  };
}

function assertDataArray(value: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a non-Proxy array.`);
  }
  if (value.length > MAX_RECOVERY_ARRAY_ITEMS) {
    throw new RangeError(`${label} must not contain more than ${MAX_RECOVERY_ARRAY_ITEMS} items.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} contains an unsupported array property.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${label}[${index}] must be a data element.`);
    }
  }
}

function assertPlainDataObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain non-Proxy object.`);
  }
}

function assertOnlyDataProperties(
  value: object,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable data property.`);
    }
  }
}

function isProblemCode(code: unknown): code is ProblemCode {
  return typeof code === 'string' && Object.hasOwn(problemRegistry, code);
}

function assertHttpsExtensionCode(code: string): void {
  if (code.length > MAX_EXTENSION_CODE_LENGTH || !/^[\x21-\x7e]+$/u.test(code)) {
    throw new TypeError('Publication extension Problem code must contain only visible ASCII and fit the length limit.');
  }
  let url: URL;
  try {
    url = new URL(code);
  } catch {
    throw new TypeError('Publication extension Problem code must be an absolute HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') {
    throw new TypeError('Publication extension Problem code must be an absolute HTTPS URL without user information.');
  }
}

function assertHttpErrorStatus(status: number): number {
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new RangeError('Publication extension Problem status must be a safe integer from 400 through 599.');
  }
  return status;
}


