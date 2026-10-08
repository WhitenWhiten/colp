import { defineProfileHandleRepositoryContract } from '../../contracts/profile-handle-repository.contract.js';
import { createIdentityMemoryHandleRepository } from '../../support/identity-memory-adapter-shared.js';

defineProfileHandleRepositoryContract({
  name: 'identity memory profile-handle repository contract',
  createRepository: () => createIdentityMemoryHandleRepository({ handlesByHandle: new Map() }),
});
