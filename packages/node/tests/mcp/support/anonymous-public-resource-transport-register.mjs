/**
 * Registers the source loader for `node --import` in the transport test child
 * process. Node's `register` hooks are process-global; the test runs this in a
 * dedicated child so Vitest's own module runner cannot interfere.
 */
import { register } from 'node:module';

register('./anonymous-public-resource-transport-loader.mjs', import.meta.url);
