import { defineProductCommandReceiptCoreContract } from '../../contracts/product-command-receipt-core.contract.js';
import {
  createCollectionsMemoryReceipts,
} from '../../support/collections-memory-adapter-shared.js';

defineProductCommandReceiptCoreContract({
  name: 'collections memory product-command receipt contract',
  createPort: () => createCollectionsMemoryReceipts({ receipts: new Map() }),
});
