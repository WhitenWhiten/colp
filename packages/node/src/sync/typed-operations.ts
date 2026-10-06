import type { StrictOperation } from '../types/strict.js';

export type SyncTypedUpdateOperation = Extract<
  StrictOperation,
  {
    readonly type:
      | 'update_collection_metadata'
      | 'update_node_content'
      | 'update_annotation'
      | 'update_attachment'
      | 'update_relation';
  }
>;

export type SyncTypedUpdateSemanticValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly status: 422;
      readonly code: 'invalid_document';
      readonly message: string;
    };

const VALID_RESULT: SyncTypedUpdateSemanticValidationResult = Object.freeze({ valid: true });
const INVALID_RESULT: SyncTypedUpdateSemanticValidationResult = Object.freeze({
  valid: false,
  status: 422,
  code: 'invalid_document',
  message: 'Sync update payload base and value must have identical own enumerable string data-property keys.',
});

interface DataObjectInspection {
  readonly value: object;
  readonly keys: ReadonlySet<string>;
}

function inspectDataObject(candidate: unknown): DataObjectInspection | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;

  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = new Set<string>();
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return undefined;
    }
    keys.add(key);
  }

  return { value: candidate, keys };
}

function ownDataProperty(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

function hasBypassField(keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (key.startsWith('/')) return true;
  }
  return false;
}

/**
 * Performs the post-wire cross-object check required for typed Sync updates.
 * The complete Operation must already have passed canonical JSON Schema validation.
 */
export function validateSyncTypedUpdateOperationPayload(
  operation: SyncTypedUpdateOperation,
): SyncTypedUpdateSemanticValidationResult {
  const payloadDescriptor = Object.getOwnPropertyDescriptor(operation, 'payload');
  if (
    payloadDescriptor === undefined
    || !payloadDescriptor.enumerable
    || !('value' in payloadDescriptor)
  ) {
    return INVALID_RESULT;
  }

  const payload = inspectDataObject(payloadDescriptor.value);
  if (
    payload === undefined
    || payload.keys.size !== 2
    || !payload.keys.has('base')
    || !payload.keys.has('value')
  ) {
    return INVALID_RESULT;
  }

  const base = inspectDataObject(ownDataProperty(payload.value, 'base'));
  const value = inspectDataObject(ownDataProperty(payload.value, 'value'));
  if (
    base === undefined
    || value === undefined
    || hasBypassField(base.keys)
    || hasBypassField(value.keys)
    || !sameKeys(base.keys, value.keys)
  ) {
    return INVALID_RESULT;
  }

  return VALID_RESULT;
}

export class SyncTypedUpdateSemanticError extends TypeError {
  readonly status = 422;
  readonly code = 'invalid_document';

  constructor() {
    super(INVALID_RESULT.valid ? '' : INVALID_RESULT.message);
    this.name = 'SyncTypedUpdateSemanticError';
  }
}

/** Throws a stable invalid_document error when post-wire typed-update semantics fail. */
export function assertSyncTypedUpdateOperationPayload(
  operation: SyncTypedUpdateOperation,
): void {
  if (!validateSyncTypedUpdateOperationPayload(operation).valid) {
    throw new SyncTypedUpdateSemanticError();
  }
}
