import type { CaptureTask } from '../capture/contracts.js';
let authorize: (task: CaptureTask) => Promise<void> = async () => { throw new Error('semanticSaveUnavailable'); };
export const installSemanticSaveAuthorization = (check: typeof authorize) => { authorize = check; };
export const assertSemanticSaveTask = (task: CaptureTask) => authorize(task);
