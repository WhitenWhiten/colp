/**
 * Registration of the periodic bookmark-reconciliation alarm.
 *
 * `chrome.alarms.create` cancels and replaces a registration with the same name,
 * which reschedules it for a full period from *now*. The MV3 worker is cold
 * started constantly while the user browses, so registering unconditionally on
 * every boot pushed the alarm forward on each wake and a 180-minute
 * reconciliation could never come due — the guarantee this alarm exists to
 * provide would never fire.
 *
 * Registering therefore means "create it if it is not there", not "create it".
 */
export interface ReconcileAlarmChrome {
  readonly alarms: {
    get(name: string): Promise<{ readonly name: string } | undefined>;
    create(name: string, info: { periodInMinutes: number }): void;
  };
}

/** True when this call registered the alarm, false when it already existed. */
export async function ensurePeriodicAlarm(
  chromeApi: ReconcileAlarmChrome,
  name: string,
  periodInMinutes: number,
): Promise<boolean> {
  try {
    const existing = await chromeApi.alarms.get(name);
    // The platform's schedule is authoritative: replacing it would restart the
    // countdown we are trying to guarantee.
    if (existing !== undefined) return false;
  } catch {
    // `get` unavailable or rejected. Creating is still better than leaving no
    // reconciliation scheduled, even though it may reset a live period.
  }
  try {
    chromeApi.alarms.create(name, { periodInMinutes });
    return true;
  } catch {
    // alarms unavailable: the opportunistic recovery paths still run.
    return false;
  }
}
