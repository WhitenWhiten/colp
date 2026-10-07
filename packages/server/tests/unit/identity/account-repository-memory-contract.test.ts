import { defineAccountRepositoryContract } from '../../contracts/account-repository.contract.js';
import { createIdentityMemoryAccountRepository } from '../../support/identity-memory-adapter-shared.js';

defineAccountRepositoryContract({
  name: 'identity memory account repository contract',
  createRepository: () => createIdentityMemoryAccountRepository({
    accounts: new Map(),
    accountsByEmail: new Map(),
  }),
});
