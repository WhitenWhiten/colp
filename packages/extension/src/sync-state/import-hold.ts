/**
 * Recovery code for a queued change parked because its import plan is paused or
 * needs attention. The plan's own UI reports that state; one parked row is not a
 * separate sync issue, so issue projections exclude this code.
 */
export const IMPORT_HOLD = 'import_hold';
