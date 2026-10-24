/**
 * The server's clock, as this computer saw it when a Session was minted.
 *
 * Sessions and replica leases expire in SERVER time. Judging them against this
 * computer's clock rejected every fresh Session once the clock ran 15 minutes
 * ahead and kept using an expired one while it ran behind (W2B-P0-1). The Session
 * response already carries the server's clock; the offset measured there is the
 * one correction every expiry decision needs.
 */

/** Past this the person is told the clock is off; sync itself keeps working (every decision below is in server time). */
export const CLOCK_SKEW_WARNING_MILLISECONDS = 120_000;

type Skewed = { readonly clientClockSkewMilliseconds?: number } | null | undefined;

/** This computer's clock minus the server's, measured at the Session's mint; 0 when it was never measured. */
export function clientClockSkew(session: Skewed): number {
  const value = session?.clientClockSkewMilliseconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The server's clock, given this computer's reading `localNow`. */
export function serverNow(session: Skewed, localNow: number = Date.now()): number {
  return localNow - clientClockSkew(session);
}

/** A server instant (an ISO string or epoch milliseconds) on this computer's clock. */
export function localTimeOf(session: Skewed, serverInstant: string | number): number {
  const instant = typeof serverInstant === 'number' ? serverInstant : Date.parse(serverInstant);
  return instant + clientClockSkew(session);
}

/**
 * Client minus server, taken at the middle of the request's round trip. `clientTime` is when the
 * request was built and `receivedAt` when its response arrived, so the answer is off by at most
 * half the round trip, not by the whole of it.
 */
export function measureClientClockSkew(input: { readonly clientTime: unknown; readonly serverTime: string;
  readonly receivedAt: number }): number {
  const sent = typeof input.clientTime === 'string' ? Date.parse(input.clientTime) : Number.NaN;
  const middle = Number.isFinite(sent) ? sent + Math.max(0, input.receivedAt - sent) / 2 : input.receivedAt;
  return Math.round(middle - Date.parse(input.serverTime));
}

export function clockSkewIsSignificant(skewMilliseconds: number): boolean {
  return Math.abs(skewMilliseconds) > CLOCK_SKEW_WARNING_MILLISECONDS;
}

/**
 * The skew last measured in this worker, for callers that hold no Session (credential expiry, status).
 * The Session stays the durable source: it is stored with the measurement and restores this on load.
 */
const lastKnown = { milliseconds: 0 };
export function lastKnownClientClockSkew(): number { return lastKnown.milliseconds; }
export function rememberClientClockSkew(session: Skewed): number {
  lastKnown.milliseconds = clientClockSkew(session);
  return lastKnown.milliseconds;
}
