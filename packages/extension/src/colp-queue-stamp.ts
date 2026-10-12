import { digestJson, validateOperation } from './bookmark-event-codec.js';

/** Production COLP enqueue must pass these. Fixtures may omit them only with allowUnstamped. */
export const COLP_QUEUE_STAMP = Object.freeze({
  validateOperation,
  digestOperation: digestJson,
});
