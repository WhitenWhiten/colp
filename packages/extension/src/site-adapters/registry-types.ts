import type { AdapterManifest, AdapterMessage, ContentIdentity, SiteItem } from './contracts.js';
/** Audited host metadata. Page/package claims never populate this registry. */
export interface SiteDefinition {
  adapterId: string; version: string; siteKey: string; identityVersion: number;
  label: string; origin: string; matches: readonly string[];
  capabilities: AdapterManifest['capabilities'];
  negativeReadback: boolean;
  /** Missing means document-local. Account-wide reads must be explicitly qualified. */
  readScope?: 'document' | 'account';
  readPolicy?: Partial<import('./read-policy.js').SiteReadPolicy>;
  community?: { connectOrigins: readonly string[] };
  importResume: 'stableCursor' | 'restartAndDeduplicate';
  scripts: { adapter: string; probe?: string };
  validateAccount(id: unknown): boolean;
  validateCollection(id: unknown): boolean;
  validateItem(item: SiteItem): boolean;
  validateMessage(message: AdapterMessage): boolean;
  contentIdentity(url: string): ContentIdentity | null;
  itemUrl(itemId: string): string | null;
  sameResolutionTarget(requested: string, current: string): boolean;
}
