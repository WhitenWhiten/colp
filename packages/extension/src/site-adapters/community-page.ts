import { startAdapterRuntime } from './page-runtime.js';
import { communitySiteDefinition, type CommunityManifest } from './community-definition.js';
import { abortableSleep, fail } from './read-errors.js';
import { siteDisplayTitle } from './title.js';
import type { AdapterServices, SiteAdapter } from './contracts.js';
/** What a package's script receives: the host's read budgets plus the helpers bundled adapters import. */
export type CommunitySdk = AdapterServices & { fail: typeof fail; abortableSleep: typeof abortableSleep; siteDisplayTitle: typeof siteDisplayTitle };
/** The page half of an installed package: the bundled adapter runtime, started by the generated wrapper in the package's world. */
Object.defineProperty(globalThis, '__knownCommunityAdapter', { configurable: true, value(input: { manifest: CommunityManifest; credential: string }, author: (sdk: CommunitySdk) => SiteAdapter) {
  startAdapterRuntime(communitySiteDefinition(input.manifest), services => author(Object.freeze({ ...services, fail, abortableSleep, siteDisplayTitle })), { credential: input.credential });
} });
