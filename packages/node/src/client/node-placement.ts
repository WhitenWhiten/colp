import {
  cloneAndFreezeJsonData,
  createValidatorRegistry,
  type DefinitionName,
  type ValidatorRegistry,
} from '../schema/index.js';
import { validateNodeCreateRequestUrlHashSemantics } from '../semantic/index.js';
import type { CreateNodeOperationPayload, MoveOperationPayload, OpaqueId } from '../types/index.js';

let validators: ValidatorRegistry | undefined;

function getValidators(): ValidatorRegistry {
  validators ??= createValidatorRegistry();
  return validators;
}

function assertValidPayload(
  definition: DefinitionName,
  value: unknown,
): void {
  const result = getValidators().validate(definition, value);
  if (!result.valid) {
    const first = result.errors[0];
    const location = first?.instancePath === '' ? '/' : first?.instancePath;
    throw new TypeError(
      `${definition} is not a valid Collection Protocol payload at ${location ?? '/'}: ${first?.message ?? 'validation failed'}.`,
    );
  }
}

function assertConsistentAnchors(
  afterId: OpaqueId | null | undefined,
  beforeId: OpaqueId | null | undefined,
): void {
  if (afterId !== null && afterId !== undefined && afterId === beforeId) {
    throw new TypeError('afterId and beforeId cannot identify the same Node.');
  }
}

/**
 * Builds the payload shared by a Publisher Node-create request and a Sync
 * `create_node` operation. Position is intentionally absent and server-owned.
 */
export function buildCreateNodePayload(
  payload: Readonly<CreateNodeOperationPayload>,
): Readonly<CreateNodeOperationPayload> {
  const result = cloneAndFreezeJsonData(payload);
  assertValidPayload('nodeCreateRequest', result);
  const semantic = validateNodeCreateRequestUrlHashSemantics(result);
  if (!semantic.valid) {
    throw new TypeError(`nodeCreateRequest semantic validation failed: ${semantic.issues[0]?.message}`);
  }
  assertConsistentAnchors(result.afterId, result.beforeId);
  return result;
}

/**
 * Builds the payload shared by a Publisher Node-move request and a Sync
 * `move_node` operation. The server validates anchor context and assigns Position.
 */
export function buildMoveNodePayload(
  payload: Readonly<MoveOperationPayload>,
): Readonly<MoveOperationPayload> {
  const result = cloneAndFreezeJsonData(payload);
  assertValidPayload('nodeMoveRequest', result);
  assertConsistentAnchors(result.afterId, result.beforeId);
  return result;
}
