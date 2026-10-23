import type { ClosedPayload } from './envelope.js';

type Payload<T extends ClosedPayload> = T;

// @ts-expect-error a function cannot enter a closed outbox payload
export type RejectFunctionPayload = Payload<{ fn: () => number }>;
// @ts-expect-error a Date cannot enter a closed outbox payload
export type RejectDatePayload = Payload<{ at: Date }>;
// @ts-expect-error undefined cannot enter a closed outbox payload
export type RejectUndefinedPayload = Payload<{ missing: undefined }>;
