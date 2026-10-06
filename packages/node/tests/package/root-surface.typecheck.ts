import {
  packageStatus,
  protocolVersion,
  supportedProfiles,
} from '../../src/index.js';

// The package root is deliberately metadata-only. Representative business
// values and types must remain available only from their owning subpaths.
// @ts-expect-error Publisher APIs belong to ./publisher.
import { executePublisherDelete } from '../../src/index.js';
// @ts-expect-error Sync APIs belong to ./sync.
import { coordinateSequenceOperation } from '../../src/index.js';
// @ts-expect-error Server APIs belong to ./server.
import { problemRegistry } from '../../src/index.js';
// @ts-expect-error Protocol contract types belong to ./types.
import type { ColpContract } from '../../src/index.js';

void packageStatus;
void protocolVersion;
void supportedProfiles;
void executePublisherDelete;
void coordinateSequenceOperation;
void problemRegistry;
void (undefined as unknown as ColpContract<'collection'>);
