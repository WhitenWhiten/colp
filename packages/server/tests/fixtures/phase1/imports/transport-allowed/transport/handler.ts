import type { CollectionContract } from '../modules/collections/index.js';
import type { CommandContract } from '../modules/commands/index.js';
import type { IdentityContract } from '../modules/identity/index.js';

export type TransportDependencies = CollectionContract & CommandContract & IdentityContract;
