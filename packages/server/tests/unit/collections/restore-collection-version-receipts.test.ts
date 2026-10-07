import { defineCollectionVersionRestoreReceiptStoreContract } from '../../contracts/collection-version-restore-receipt-store.contract.js';
import { createMemoryCollectionVersionRestoreReceiptStore } from '../../support/collection-version-restore-receipts-memory.js';

defineCollectionVersionRestoreReceiptStoreContract({
  name: 'memory collection version restore receipt store contract',
  createStore: () => createMemoryCollectionVersionRestoreReceiptStore(),
});
