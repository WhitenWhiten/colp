import type { CaptureTask } from '../capture/contracts.js';
let check: (task: CaptureTask) => Promise<void> = async () => { throw new Error('reconcileAuthorizationUnavailable'); };
export const installReconcileAuthorization = (value: typeof check) => { check = value; };
export const assertReconcileAuthorization = (task: CaptureTask) => check(task);
