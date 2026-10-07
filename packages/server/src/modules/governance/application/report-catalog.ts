import { assertCanonicalCommandId } from '../../commands/index.js';
import { strongEntityTag } from '../../collections/index.js';
import {
  ReportsApplicationError,
  type ReportActor,
  type ReportMutationResult,
  type ReportUnitOfWork,
} from '../../reports/index.js';
import {
  parseCatalogPatch,
  type CatalogFields,
  type CatalogPatch,
} from '../domain/catalog.js';

export interface ReportCatalogView extends CatalogFields {
  readonly revision: string;
  readonly etag: string;
}

function catalogOf(series: {
  readonly resourceRevision: string;
  readonly tags?: readonly string[] | null;
  readonly language?: string | null;
}): ReportCatalogView {
  return Object.freeze({
    tags: Object.freeze([...(series.tags ?? [])]),
    language: series.language ?? null,
    revision: series.resourceRevision,
    etag: strongEntityTag(series.resourceRevision),
  });
}

export async function getReportCatalog(
  unit: ReportUnitOfWork,
  input: { readonly actor: ReportActor; readonly reportId: string },
): Promise<ReportCatalogView> {
  return unit.execute(async (ports) => {
    const series = await ports.series.lockById(input.reportId);
    if (!series || series.state === 'archived') {
      throw new ReportsApplicationError('resource_not_found', 'report not found');
    }
    if (series.ownerSubjectId !== input.actor.subjectId) {
      const member = await ports.members.get(series.id, input.actor.subjectId);
      if (!member || member.revokedAt) {
        throw new ReportsApplicationError('resource_not_found', 'report not found');
      }
    }
    return catalogOf(series);
  });
}

export async function updateReportCatalog(
  unit: ReportUnitOfWork,
  input: {
    readonly actor: ReportActor;
    readonly reportId: string;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly ifMatch: string;
    readonly patch: CatalogPatch;
  },
): Promise<ReportMutationResult<ReportCatalogView>> {
  return unit.execute(async (ports) => {
    assertCanonicalCommandId(input.commandId);
    const series = await ports.series.lockById(input.reportId);
    if (!series || series.state === 'archived') {
      throw new ReportsApplicationError('resource_not_found', 'report not found');
    }
    if (series.ownerSubjectId !== input.actor.subjectId) {
      const member = await ports.members.get(series.id, input.actor.subjectId);
      if (!member || member.revokedAt || member.role === 'viewer') {
        throw new ReportsApplicationError('forbidden', 'insufficient report membership');
      }
    }
    const binding = {
      principalId: input.actor.principalId,
      commandScope: input.commandScope,
      commandId: input.commandId,
    };
    const claim = await ports.receipts.claim(binding, input.fingerprint);
    if (claim.kind !== 'claimed') {
      return claim.kind === 'replay'
        ? { kind: 'replay', result: claim.result }
        : claim.kind === 'in_progress'
          ? claim
          : claim.kind === 'expired'
            ? claim
            : { kind: 'reused' };
    }
    if (!ports.revision.matches(series.resourceRevision, input.ifMatch)) {
      throw new ReportsApplicationError('precondition_failed', 'report revision mismatch');
    }
    const updated = await ports.series.update(series.id, {
      tags: input.patch.tags ?? series.tags ?? [],
      language: input.patch.language !== undefined ? input.patch.language : series.language ?? null,
      resourceRevision: ports.revision.next(),
    });
    const catalog = catalogOf(updated);
    const body = Buffer.from(JSON.stringify({
      tags: [...catalog.tags],
      language: catalog.language,
      revision: catalog.revision,
    }));
    await ports.receipts.complete(binding, input.fingerprint, {
      status: 200,
      body,
      stableHeaders: {
        etag: catalog.etag,
        'cache-control': 'private, no-store',
        'content-type': 'application/json',
      },
      mediaType: 'application/json',
      contractVersion: 'reports.catalog.v1',
      targetIdentity: series.id,
    });
    return { kind: 'succeeded', value: catalog };
  });
}

export { parseCatalogPatch };
