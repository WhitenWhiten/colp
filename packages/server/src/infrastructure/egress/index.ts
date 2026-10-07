/**
 * Shared hardened egress port facade (FIX-M-019). Consumers receive the
 * planner, the pinned lookup and the hardened fetch; tests inject their own
 * resolver/connector so no real network is involved.
 */
export {
  classifyEgressAddress,
  createHardenedEgressFetch,
  createPinnedLookup,
  createProductionEgressConnector,
  HardenedEgressError,
  planHardenedEgressTarget,
  type EgressAddressVerdict,
  type HardenedEgressConnector,
  type HardenedEgressErrorReason,
  type HardenedEgressFetch,
  type HardenedEgressFetchOptions,
  type HardenedEgressResolver,
  type HardenedEgressTarget,
} from './hardened-egress.js';
