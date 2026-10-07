import { defineProfileRepositoryContract } from '../../contracts/profile-repository.contract.js';
import { createIdentityMemoryProfileRepository } from '../../support/identity-memory-adapter-shared.js';

defineProfileRepositoryContract({
  name: 'identity memory profile repository contract',
  createRepository: () => createIdentityMemoryProfileRepository(new Map()),
});
