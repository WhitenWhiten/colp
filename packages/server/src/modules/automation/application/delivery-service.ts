import type { DeliveryView } from '@know-n/colp/automation';
import type { PageAfter } from './ports.js';
export interface OwnerDeliveryStore {
  list(after: PageAfter | null,limit: number): Promise<{ view: DeliveryView; createdAt: string }[]>;
  retry(id: string): Promise<DeliveryView>;
}
