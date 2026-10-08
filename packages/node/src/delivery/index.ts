import { types as nodeTypes } from 'node:util';

export type DeliveryStageId =
  | 'core-publication'
  | 'publisher'
  | 'feed-release'
  | 'sync'
  | 'mcp-read-write';

export type DeliveryComponent =
  | 'core'
  | 'publication'
  | 'publisher'
  | 'feed'
  | 'sync'
  | 'mcp-read'
  | 'mcp-write';

export type DeliveryCompletionClaim =
  | { readonly profile: Exclude<DeliveryComponent, 'feed'> }
  | { readonly profile: 'feed'; readonly mode: 'release' };

export interface DeliveryStageDefinition {
  readonly ordinal: 1 | 2 | 3 | 4 | 5;
  readonly id: DeliveryStageId;
  readonly components: readonly DeliveryComponent[];
  readonly initialMode?: 'release';
}

export type DeliveryStageState = 'delivered' | 'in-progress' | 'pending';

export interface DeliveryStageStatus extends DeliveryStageDefinition {
  readonly state: DeliveryStageState;
  readonly completedComponents: readonly DeliveryComponent[];
  readonly missingComponents: readonly DeliveryComponent[];
}

export interface DeliveryPlan {
  readonly stages: readonly DeliveryStageStatus[];
  readonly completedComponents: readonly DeliveryComponent[];
  readonly deliveredStageCount: number;
  readonly currentStage: DeliveryStageStatus | null;
  readonly complete: boolean;
}

function freezeStage<const Stage extends DeliveryStageDefinition>(stage: Stage): Readonly<Stage> {
  Object.freeze(stage.components);
  return Object.freeze(stage);
}

/**
 * The recommended Node package and service delivery order from CORE-0037.
 * This implementation-planning policy is deliberately independent of Profile
 * dependency closure and conformance evidence.
 */
export const deliveryStages = Object.freeze([
  freezeStage({ ordinal: 1, id: 'core-publication', components: ['core', 'publication'] }),
  freezeStage({ ordinal: 2, id: 'publisher', components: ['publisher'] }),
  freezeStage({
    ordinal: 3,
    id: 'feed-release',
    components: ['feed'],
    initialMode: 'release',
  }),
  freezeStage({ ordinal: 4, id: 'sync', components: ['sync'] }),
  freezeStage({
    ordinal: 5,
    id: 'mcp-read-write',
    components: ['mcp-read', 'mcp-write'],
  }),
] as const satisfies readonly DeliveryStageDefinition[]);

const knownProfiles = new Set<unknown>(deliveryStages.flatMap((stage) => stage.components));
const MAX_COMPLETION_CLAIMS = deliveryStages.reduce((total, stage) => total + stage.components.length, 0);
const stageIndexByProfile = new Map<DeliveryComponent, number>(
  deliveryStages.flatMap((stage, stageIndex) =>
    stage.components.map((component) => [component, stageIndex] as const),
  ),
);

function readClaim(value: unknown, index: number): { profile: DeliveryComponent; mode?: 'release' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Delivery completion claim ${index} must be an object.`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`Delivery completion claim ${index} must not be a Proxy.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Delivery completion claim ${index} must be a plain object.`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`Delivery completion claim ${index} has an unsupported symbol field.`);
  }
  const unknownKeys = (keys as string[]).filter((key) => key !== 'profile' && key !== 'mode');
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `Delivery completion claim ${index} has unknown fields: ${unknownKeys.sort().join(', ')}.`,
    );
  }
  const profileDescriptor = descriptors.profile;
  if (profileDescriptor === undefined || !('value' in profileDescriptor)) {
    throw new TypeError(`Delivery completion claim ${index} requires a data property named profile.`);
  }
  if (!profileDescriptor.enumerable) {
    throw new TypeError(`Delivery completion claim ${index} profile must be enumerable.`);
  }
  const profile = profileDescriptor.value;
  if (!knownProfiles.has(profile)) {
    throw new TypeError(`Unknown or legacy delivery profile: ${String(profile)}.`);
  }

  const modeDescriptor = descriptors.mode;
  if (modeDescriptor !== undefined && !('value' in modeDescriptor)) {
    throw new TypeError(`Delivery completion claim ${index} mode must be a data property.`);
  }
  if (modeDescriptor !== undefined && !modeDescriptor.enumerable) {
    throw new TypeError(`Delivery completion claim ${index} mode must be enumerable.`);
  }
  const mode = modeDescriptor?.value;
  if (profile === 'feed') {
    if (mode !== 'release') {
      throw new TypeError('The first feed delivery requires mode "release".');
    }
    return { profile, mode: 'release' };
  }
  if (modeDescriptor !== undefined) {
    throw new TypeError(`Delivery profile ${String(profile)} does not accept a mode.`);
  }
  return { profile: profile as DeliveryComponent };
}

function immutableStatus(
  stage: DeliveryStageDefinition,
  completed: ReadonlySet<DeliveryComponent>,
): DeliveryStageStatus {
  const completedComponents = Object.freeze(
    stage.components.filter((component) => completed.has(component)),
  );
  const missingComponents = Object.freeze(
    stage.components.filter((component) => !completed.has(component)),
  );
  const state: DeliveryStageState =
    missingComponents.length === 0
      ? 'delivered'
      : completedComponents.length > 0
        ? 'in-progress'
        : 'pending';
  const status: DeliveryStageStatus = {
    ordinal: stage.ordinal,
    id: stage.id,
    components: Object.freeze([...stage.components]),
    state,
    completedComponents,
    missingComponents,
    ...(stage.initialMode === undefined ? {} : { initialMode: stage.initialMode }),
  };
  return Object.freeze(status);
}

/**
 * Produces an immutable delivery status and rejects skipped stages. Completion
 * claims describe implementation progress only; they are not conformance
 * evidence and cannot produce supported or verified Manifest Profile claims.
 */
export function planDelivery(completionClaims: readonly DeliveryCompletionClaim[]): DeliveryPlan {
  if (!Array.isArray(completionClaims)) {
    throw new TypeError('Delivery completion claims must be an array.');
  }
  if (nodeTypes.isProxy(completionClaims) || Object.getPrototypeOf(completionClaims) !== Array.prototype) {
    throw new TypeError('Delivery completion claims must be an ordinary array.');
  }

  const claimDescriptors = Object.getOwnPropertyDescriptors(completionClaims) as unknown as Record<
    PropertyKey,
    PropertyDescriptor | undefined
  >;
  const lengthDescriptor = claimDescriptors.length;
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    throw new TypeError('Delivery completion claims must have an ordinary array length.');
  }
  const length = lengthDescriptor.value as number;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COMPLETION_CLAIMS) {
    throw new RangeError(`Delivery completion claims cannot contain more than ${MAX_COMPLETION_CLAIMS} entries.`);
  }
  const allowedArrayKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const extraArrayKeys = Reflect.ownKeys(claimDescriptors).filter(
    (key) => typeof key !== 'string' || !allowedArrayKeys.has(key),
  );
  if (extraArrayKeys.length > 0) {
    throw new TypeError('Delivery completion claims must not have extra properties.');
  }

  const completed = new Set<DeliveryComponent>();
  let previousStageIndex = -1;
  for (let index = 0; index < length; index += 1) {
    const itemDescriptor = claimDescriptors[String(index)];
    if (itemDescriptor === undefined) {
      throw new TypeError(`Delivery completion claims must not contain a hole at index ${index}.`);
    }
    if (!('value' in itemDescriptor)) {
      throw new TypeError(`Delivery completion claim ${index} must be an array data property.`);
    }
    if (!itemDescriptor.enumerable) {
      throw new TypeError(`Delivery completion claim ${index} must be enumerable.`);
    }
    const claim = readClaim(itemDescriptor.value, index);
    if (completed.has(claim.profile)) {
      throw new TypeError(`Duplicate or contradictory delivery completion: ${claim.profile}.`);
    }
    const stageIndex = stageIndexByProfile.get(claim.profile)!;
    if (stageIndex < previousStageIndex) {
      throw new TypeError(
        `Delivery completion claim ${claim.profile} is out of order: chronological claims must not return to an earlier stage.`,
      );
    }
    completed.add(claim.profile);
    previousStageIndex = stageIndex;
  }

  let earlierStageDelivered = true;
  for (const stage of deliveryStages) {
    const stageHasProgress = stage.components.some((component) => completed.has(component));
    if (stageHasProgress && !earlierStageDelivered) {
      throw new TypeError(`Delivery stage ${stage.id} cannot start before every earlier stage is delivered.`);
    }
    earlierStageDelivered =
      earlierStageDelivered && stage.components.every((component) => completed.has(component));
  }

  const stages = Object.freeze(deliveryStages.map((stage) => immutableStatus(stage, completed)));
  const completedComponents = Object.freeze(
    deliveryStages.flatMap((stage) => stage.components.filter((component) => completed.has(component))),
  );
  const deliveredStageCount = stages.filter((stage) => stage.state === 'delivered').length;
  const currentStage = stages.find((stage) => stage.state !== 'delivered') ?? null;
  return Object.freeze({
    stages,
    completedComponents,
    deliveredStageCount,
    currentStage,
    complete: currentStage === null,
  });
}

/** Asserts the CORE-0037 order and returns the same detached status as planDelivery. */
export function assertDeliveryOrder(
  completionClaims: readonly DeliveryCompletionClaim[],
): DeliveryPlan {
  return planDelivery(completionClaims);
}
