/**
 * Pure mapping from a probe observation to the stored link-health fact.
 * No I/O. Redirect comparison uses the same normalizer as GET duplicates.
 */
import { normalizeBookmarkUrl } from './link-health-url.js';
import type { LinkHealthStatus } from './get-my-link-health.js';

export type LinkHealthErrorClass = 'invalid_url' | 'timeout' | 'denied' | 'dns' | 'http';

export interface LinkHealthProbeFact {
  readonly status: Exclude<LinkHealthStatus, 'pending'>;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly errorClass: LinkHealthErrorClass | null;
}

export type LinkHealthProbeObservation =
  | { readonly kind: 'invalid_url' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'dns' }
  | { readonly kind: 'http'; readonly httpStatus?: number }
  | {
      readonly kind: 'completed';
      readonly httpStatus: number;
      readonly startUrl: string;
      readonly finalUrl: string;
    };

const BROKEN = (errorClass: LinkHealthErrorClass, httpStatus: number | null = null): LinkHealthProbeFact =>
  Object.freeze({ status: 'broken', httpStatus, finalUrl: null, errorClass });

export function mapLinkHealthProbeObservation(
  observation: LinkHealthProbeObservation,
): LinkHealthProbeFact {
  switch (observation.kind) {
    case 'invalid_url':
      return BROKEN('invalid_url');
    case 'timeout':
      return BROKEN('timeout');
    case 'denied':
      return BROKEN('denied');
    case 'dns':
      return BROKEN('dns');
    case 'http':
      return BROKEN('http', observation.httpStatus ?? null);
    case 'completed': {
      if (observation.httpStatus < 200 || observation.httpStatus > 299) {
        return BROKEN('http', observation.httpStatus);
      }
      const start = normalizeBookmarkUrl(observation.startUrl);
      const finalUrl = normalizeBookmarkUrl(observation.finalUrl);
      if (start === null || finalUrl === null) return BROKEN('invalid_url');
      if (start === finalUrl) {
        return Object.freeze({
          status: 'healthy', httpStatus: observation.httpStatus, finalUrl: null, errorClass: null,
        });
      }
      return Object.freeze({
        status: 'redirect', httpStatus: observation.httpStatus, finalUrl, errorClass: null,
      });
    }
    default: {
      const _never: never = observation;
      return _never;
    }
  }
}
