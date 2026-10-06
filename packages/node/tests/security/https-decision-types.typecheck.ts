/**
 * H-18: compile-time contract for HTTPS decision types on `./security`.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 *
 * - `HttpsEndpointDecision` and sibling decision types are public names on
 *   `src/security/index.ts`;
 * - `enforceHttpsFromTransport` returns that named decision type;
 * - atomic `enforceHttpsEndpoint`, `HttpsEndpointInput`, and transport
 *   evidence types stay off the barrel so hosts cannot self-assert `remote`.
 */
import {
  enforceHttpsFromTransport,
  type HttpsEndpointApplicability,
  type HttpsEndpointDecision,
  type HttpsEndpointDenialReason,
  type HttpsEndpointLocation,
} from '../../src/security/index.js';

export const decision: HttpsEndpointDecision = {
  allowed: false,
  reason: 'https_required',
};
export const denialReason: HttpsEndpointDenialReason = 'invalid_input';
export const applicability: HttpsEndpointApplicability = 'applicable';
export const location: HttpsEndpointLocation = 'remote';

type CompositionReturnsNamedDecision =
  ReturnType<typeof enforceHttpsFromTransport> extends HttpsEndpointDecision ? true : never;
export const compositionReturnsNamedDecision: CompositionReturnsNamedDecision = true;

// @ts-expect-error atomic HTTPS function is not a public security export
import { enforceHttpsEndpoint } from '../../src/security/index.js';
// @ts-expect-error atomic HTTPS input is not a public security export
import type { HttpsEndpointInput } from '../../src/security/index.js';
// @ts-expect-error HTTPS transport evidence is not a public security export
import type { HttpsEndpointTransport } from '../../src/security/index.js';
