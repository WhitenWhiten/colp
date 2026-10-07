import { defineBookmarkIconWritePortContract } from '../../contracts/bookmark-icon-write-port.contract.js';
import {
  createMemoryBookmarkIconFields,
  createMemoryBookmarkIcons,
} from '../../support/memory-bookmark-icons.js';

defineBookmarkIconWritePortContract({
  name: 'memory bookmark icon write port contract',
  createPort: () => createMemoryBookmarkIcons({
    ...createMemoryBookmarkIconFields(),
    now: new Date('2026-08-30T09:00:00.000Z'),
  }, 'contract-icon-collection-a'),
});
