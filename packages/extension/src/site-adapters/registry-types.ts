import type { AdapterIcon, AdapterManifest, AdapterMessage, ContentIdentity, SiteItem } from './contracts.js';
/** Host-authored mark. Package icons stay data URLs; bundled adapters may point at a packaged asset. */
export type SiteIcon = AdapterIcon | { readonly kind: 'asset'; readonly path: string } | { readonly kind: 'url'; readonly url: string };
/** Audited host metadata. Page/package claims never populate this registry. */
export interface SiteDefinition {
  adapterId: string; version: string; siteKey: string; identityVersion: number;
  label: string; origin: string; matches: readonly string[];
  /** Missing means the supported site's favicon. */
  icon?: SiteIcon;
  /** Page sources use a verified opaque source identity without an account-connection UI. */
  connectionKind?: 'account' | 'page';
  /** A qualified single-list source can enumerate items without exposing a collection catalog. */
  defaultCollection?: import('./contracts.js').SiteCollection;
  capabilities: AdapterManifest['capabilities'];
  negativeReadback: boolean;
  /** Missing means document-local. Account-wide reads must be explicitly qualified. */
  readScope?: 'document' | 'account';
  /** Missing means account-local content. Site-wide IDs must be explicitly qualified. */
  contentIdScope?: 'site' | 'account';
  /** Qualified enumeration semantics. EOF/best-effort pages alone never prove absence. */
  collectionSnapshot?: 'positiveOnly' | 'pointInTime';
  /** Entry lists allowing repeated content require a separately qualified host implementation. */
  membershipModel?: 'set';
  /** v1 layout supports proven roots only. Tree collections need a qualified host layout. */
  collectionHierarchy?: 'flat';
  readPolicy?: Partial<import('./read-policy.js').SiteReadPolicy>;
  /** Missing means bundled page code. 'userScript' is an installed package in its own USER_SCRIPT world. */
  runtime?: 'bundled' | 'userScript';
  importResume: 'stableCursor' | 'restartAndDeduplicate';
  scripts: { adapter: string; probe?: string };
  /** Host-authored source entries, relative to src/. Required when this definition ships in the bundled registry. */
  build?: { adapter: string; probe?: string };
  validateAccount(id: unknown): boolean;
  validateCollection(id: unknown): boolean;
  validateItem(item: SiteItem): boolean;
  validateMessage(message: AdapterMessage): boolean;
  contentIdentity(url: string): ContentIdentity | null;
  itemUrl(itemId: string): string | null;
  sameResolutionTarget(requested: string, current: string): boolean;
}
