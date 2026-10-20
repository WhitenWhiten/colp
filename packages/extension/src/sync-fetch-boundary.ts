/** A caller's current content proof and the exact moment its bytes leave this process. */
export interface SyncFetchBoundary {
  readonly check?: () => Promise<void>;
  readonly started: () => void;
}

type Dispatch = (input: RequestInfo | URL, init?: RequestInit, boundary?: SyncFetchBoundary) => Promise<Response>;
type BoundaryFetch = typeof fetch & { readonly withSyncBoundary?: Dispatch };

/** Async admission wrappers must forward this capability instead of consuming it early. */
export function createSyncBoundaryFetch(dispatch: Dispatch): typeof fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => dispatch(input, init),
    { withSyncBoundary: dispatch });
}

/** Only the raw transport consumes the proof; no async admission follows started(). */
export async function dispatchSyncFetch(fetcher: typeof fetch, input: RequestInfo | URL,
  init: RequestInit | undefined, boundary: SyncFetchBoundary): Promise<Response> {
  const dispatch = (fetcher as BoundaryFetch).withSyncBoundary;
  if (dispatch) return dispatch(input, init, boundary);
  if (boundary.check) await boundary.check();
  boundary.started();
  return fetcher(input, init);
}
