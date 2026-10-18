import type { PullApplierOptions } from './pull-applier-types.js';
import { createPullApplyRuntime } from './pull-apply-runtime.js';
import { createChromePullBookmarkApi } from './pull-bookmark-api.js';
import { createPullPageStager } from './pull-page-stager.js';

export type { PullBookmarkApi } from './pull-applier-types.js';

export function createPullApplier(options: PullApplierOptions) {
  const api = options.api ?? createChromePullBookmarkApi();
  const now = options.now ?? Date.now;
  const runtime = createPullApplyRuntime(options, api, now);
  const stager = createPullPageStager(options, now, runtime);
  return Object.freeze({
    pull: stager.pull,
    stage: async (...args: Parameters<typeof stager.stage>) => { await options.assertCurrent?.(); return stager.stage(...args); },
    resume: async (mode: { readonly recoveryOnly?: boolean } = {}) => { await options.assertCurrent?.(); return runtime.resume(mode); },
    observe: runtime.observe,
  });
}
