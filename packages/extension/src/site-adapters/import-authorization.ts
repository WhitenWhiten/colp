import type { SourceAuthority, SourceContext } from './ledger-types.js';
import type { SiteDefinition } from './registry-types.js';
import type { SourceDatabase } from './source-db.js';

export type ImportAuthorization = 'current' | 'renewed' | 'differentAccount' | 'unavailable';
export function importAuthorization(context: SourceContext, authority?: SourceAuthority): ImportAuthorization {
  if (!authority?.enabled || !authority.connectionId) return 'unavailable';
  if (authority.connectionId !== context.connectionId) return 'differentAccount';
  return authority.installationGeneration === context.installationGeneration && authority.sourceSessionGeneration === context.sourceSessionGeneration ? 'current' : 'renewed';
}

/** Repreparing retained facts requires the same confirmed account, not the old page lease or approval. */
export async function preparationContext(db: SourceDatabase, definition: SiteDefinition, context: SourceContext): Promise<SourceContext> {
  const authority = await db.read<SourceAuthority>('authorities', definition.adapterId), status = importAuthorization(context, authority);
  if (status === 'unavailable') throw new Error('sourceUnresolved');
  if (status === 'differentAccount') throw new Error('sourceAccountChanged');
  return { ...context, installationId: definition.adapterId, installationGeneration: authority!.installationGeneration,
    sourceSessionGeneration: authority!.sourceSessionGeneration };
}
