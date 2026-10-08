import type { CollectionFacade } from '../../modules/collections/index.js';
import type { CollectionApplication } from '../../modules/collections/application/use-case.js';

export type UnlistedRepository = CollectionFacade & CollectionApplication;
