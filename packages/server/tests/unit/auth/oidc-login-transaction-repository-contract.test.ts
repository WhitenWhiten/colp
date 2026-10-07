import { defineOidcLoginTransactionRepositoryContract } from '../../contracts/oidc-login-transaction-repository.contract.js';
import { createMemoryOidcLoginTransactionRepository } from '../../support/memory-oidc.js';

defineOidcLoginTransactionRepositoryContract({
  name: 'memory OIDC login transaction repository contract',
  createRepository: () => createMemoryOidcLoginTransactionRepository(new Map()),
});
