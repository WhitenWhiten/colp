import type { SiteCollection } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
import { requireSourceAuthority, type createSourceLedger } from './ledger.js';
import { rows } from './source-db.js';
export type CatalogSource = Pick<SourceContext, 'installationId' | 'installationGeneration' | 'sourceSessionGeneration'>;
/** Only current, validated source facts may populate observation-only archive setup. This is not an exhaustive catalog. */
export async function observedCatalog(ledger: ReturnType<typeof createSourceLedger>, context: SourceContext): Promise<SiteCollection[]> {
  return ledger.db.transaction(['collections', 'authorities', 'documentLeases'], 'readonly', async tx => {
    await requireSourceAuthority(tx, context);
    const facts = await rows<{ entity: SiteCollection; source?: CatalogSource }>(tx, 'collections', context.connectionId);
    const catalog = facts.filter(r => r.source?.installationId === ledger.definition.adapterId
      && r.source.installationGeneration === context.installationGeneration && r.source.sourceSessionGeneration === context.sourceSessionGeneration
      && r.entity.identity === 'siteId' && r.entity.parentId === null && ledger.definition.validateCollection(r.entity.id)).map(r => r.entity);
    if (catalog.length > 2000) throw new Error('capacity'); return catalog;
  });
}
