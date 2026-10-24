import { startAdapterRuntime } from './page-runtime.js';
import { bilibiliDefinition } from './bilibili/definition.js';
import { createBilibiliAdapter } from './bilibili/adapter.js';
// Bundled page composition. New sites provide a factory; lifecycle/SDK code stays unchanged.
startAdapterRuntime(bilibiliDefinition, createBilibiliAdapter);
