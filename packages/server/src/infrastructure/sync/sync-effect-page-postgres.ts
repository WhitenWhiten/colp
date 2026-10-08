import { sql, type Kysely } from 'kysely';
import type { AuthoritativeEffectPage } from '@know-n/colp/types';
import { validateAuthoritativePullEventPage } from '@know-n/colp/sync';
import {
  SyncEffectPageReadError,
  SyncOperationEffectIntegrityError,
  type SyncEffectPageReadInput,
  type SyncEffectPageReadPort,
} from '../../modules/sync/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { validateStoredPageDigest } from './sync-operation-effects-postgres.js';
import { assertTransactionalPullAuthority } from './postgres/sync-pull-postgres.js';
import { transportBudgetFromBindingJson } from './sync-transport-budget.js';

export function createPostgresSyncEffectPageReadPort(db: Kysely<DatabaseSchema>): SyncEffectPageReadPort {
  return Object.freeze({
    async read(input: SyncEffectPageReadInput) {
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        let authority;
        try {
          authority = await assertTransactionalPullAuthority(transaction, input);
        } catch {
          throw new SyncEffectPageReadError('not_found');
        }
        if (authority.protocolVersion !== '0.2') throw new SyncEffectPageReadError('not_found');
        await sql`select set_config('known.sync_authority', 'server', true)`.execute(transaction);
        const effect = await transaction.selectFrom('sync_operation_effects').select([
          'effect_id', 'collection_id', 'effect_json',
        ]).where('effect_id', '=', input.effectId).where('collection_id', '=', authority.collectionId)
          .executeTakeFirst();
        const row = await transaction.selectFrom('sync_operation_effect_pages').selectAll()
          .where('effect_id', '=', input.effectId).where('page_number', '=', input.pageNumber)
          .executeTakeFirst();
        if (!effect || !row) throw new SyncEffectPageReadError('not_found');
        const session = await transaction.selectFrom('sync_sessions').select('binding_json')
          .where('session_id', '=', input.sessionId).executeTakeFirst();
        const page = structuredClone(row.page_json) as unknown as AuthoritativeEffectPage;
        const pageBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
        if (pageBytes > transportBudgetFromBindingJson(session?.binding_json).effectPageBytes) {
          throw new SyncEffectPageReadError('payload_too_large');
        }
        const effectRef = (effect.effect_json as { readonly effectRef?: {
          readonly pageCount?: unknown; readonly firstPageDigest?: unknown;
        } }).effectRef;
        try {
          const previous = page.pageNumber > 1
            ? await transaction.selectFrom('sync_operation_effect_pages').select('page_digest')
              .where('effect_id', '=', input.effectId).where('page_number', '=', page.pageNumber - 1)
              .executeTakeFirst() : undefined;
          const expectedPreviousDigest = page.pageNumber === 1 ? null : previous?.page_digest;
          if (expectedPreviousDigest === undefined) throw new SyncOperationEffectIntegrityError();
          validateAuthoritativePullEventPage(page, { effectId: effect.effect_id,
            expectedPageNumber: row.page_number, pageCount: row.page_count,
            previousPageDigest: expectedPreviousDigest });
          validateStoredPageDigest(page);
          if (page.effectId !== effect.effect_id || page.pageNumber !== row.page_number
              || page.pageCount !== row.page_count || page.memberCount !== row.member_count
              || page.pageDigest !== row.page_digest
              || page.previousPageDigest !== row.previous_page_digest
              || effectRef?.pageCount !== page.pageCount
              || (page.pageNumber === 1 && effectRef.firstPageDigest !== page.pageDigest)) {
            throw new SyncOperationEffectIntegrityError();
          }
          return Object.freeze(page);
        } catch {
          throw new SyncEffectPageReadError('integrity_failure');
        }
      });
    },
  });
}
