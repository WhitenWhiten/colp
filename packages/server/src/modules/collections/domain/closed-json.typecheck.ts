import type { JsonObject } from './canonical-mutation.js';

type Payload<T extends JsonObject> = T;

// @ts-expect-error a function cannot enter a closed canonical payload
export type RejectFunctionPayload = Payload<{ fn: () => number }>;
// @ts-expect-error a Date cannot enter a closed canonical payload
export type RejectDatePayload = Payload<{ at: Date }>;
// @ts-expect-error undefined cannot enter a closed canonical payload
export type RejectUndefinedPayload = Payload<{ missing: undefined }>;
