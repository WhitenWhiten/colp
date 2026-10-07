export {
  createPostgresAccountIdentityRepository,
  createPostgresAccountRepository,
  createPostgresVerifiedAccountEmailPort,
  createPostgresIdentityClock,
  createPostgresIdentityPorts,
  createPostgresOidcLoginTransactionRepository,
  createPostgresProfileHandleRepository,
  createPostgresProfileRepository,
  createPostgresSessionRepository,
} from './repositories.js';
export {
  createPostgresBookmarkPreferencesQuery,
  createPostgresBookmarkPreferencesUnitOfWork,
} from './postgres-bookmark-preferences.js';
export {
  createPostgresIdentityUnitOfWork,
  type PostgresIdentityUnitOfWorkOptions,
} from './unit-of-work.js';
export {
  createCachingJwksClient,
  type CachingJwksClientOptions,
} from './jwks-client.js';
export {
  buildPublicProfileFactsStatement,
  createPostgresPublicProfileFactsReadPort,
  type PublicProfileFactsStatement,
} from './postgres-public-profile-read.js';

export { createR2AvatarStore, type R2AvatarStoreOptions } from './avatar-r2-adapter.js';
export { createPostgresExtensionIdentityBindingPort, createPostgresExtensionOwnerSubjectPort,
  createPostgresExtensionOwnerAccountPort } from './postgres-extension-identity-binding.js';
export { createPostgresExploreCreatorsQueryPort } from './postgres-explore-creators-query.js';
export {
  createPostgresAccountCreditsPort, createCreditUnitOfWork, reconcileAccountCredits,
  type PostgresAccountCreditsFactory,
} from './credits-postgres.js';
export { rethrowCreditError } from './credit-errors.js';
export { createPostgresCreditLedgerReadPort } from './credit-ledger-read-postgres.js';
export { createPostgresCreditHealthObserver } from './credit-health-postgres.js';

export { createPersistentAvatarStore, type PersistentAvatarStore } from './avatar-lifecycle-store.js';
