import type { CollectionContract } from '../modules/collections/index.js';
import type { IdentityContract } from '../modules/identity/index.js';
import type { PublisherContract } from '../modules/publisher/index.js';
import type { ApplicationModule } from '../modules/index.js';
import type { TransportContract } from '../transport/app.js';
import type { CollectionsInfrastructure } from '../infrastructure/collections/index.js';
import type { DatabaseInfrastructure } from '../infrastructure/database/index.js';
import type { IdentityInfrastructure } from '../infrastructure/identity/index.js';
import type { OutboxInfrastructure } from '../infrastructure/outbox/index.js';
import type { PublisherInfrastructure } from '../infrastructure/publisher/index.js';
import type { TelemetryInfrastructure } from '../infrastructure/telemetry/index.js';

export type BootstrapDependencies =
  & ApplicationModule
  & CollectionContract
  & CollectionsInfrastructure
  & DatabaseInfrastructure
  & IdentityContract
  & IdentityInfrastructure
  & OutboxInfrastructure
  & PublisherContract
  & PublisherInfrastructure
  & TelemetryInfrastructure
  & TransportContract;
