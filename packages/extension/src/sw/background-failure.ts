/**
 * Failures that must not reverse a user action (a boot wake, an alarm tick or
 * a cleanup) still need a reason. Chrome keeps service-worker console output
 * in the extension's inspection surface; tests can assert the reason without
 * routing every background task through a generic best-effort helper.
 */
export function logBackgroundFailure(reason: string, error: unknown): void {
  console.error(`[known] background task failed (${reason})`, error);
}
