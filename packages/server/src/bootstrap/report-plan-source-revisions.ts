import { createHash } from 'node:crypto';
import { McpReportPlanError, type McpReportPlan, type McpReportPlanOperation } from '../modules/mcp/index.js';
import type { ReportSourceFacts, ReportUnitOfWork } from '../modules/reports/index.js';

function sourceRevision(source: ReportSourceFacts): string {
  return `source.${createHash('sha256').update(JSON.stringify([
    source.contentRevision, source.policyRevision,
  ])).digest('hex')}`;
}

/** Read and lock authoritative source facts in the caller's report transaction. */
export async function currentReportSourceRevisions(
  reports: ReportUnitOfWork, plan: McpReportPlan,
): Promise<Record<string, string>> {
  return reports.execute(async ports => {
    const facts = await ports.source.getMany(Object.keys(plan.sourceRevisions).sort());
    return Object.fromEntries(facts.filter(source => !source.deleted && source.ownerAccountActive).map(source => [
      source.collectionId,
      // Existing persisted plans used content-only revisions. New plans bind both.
      plan.sourceRevisions[source.collectionId]?.startsWith('source.')
        ? sourceRevision(source) : source.contentRevision,
    ]));
  });
}

/** Source bindings are captured by the host, even if the client omits them. */
export async function captureReportSourceRevisions(
  reports: ReportUnitOfWork, operations: readonly McpReportPlanOperation[],
  declared: Readonly<Record<string, string>>, subjectId: string,
): Promise<Record<string, string>> {
  return reports.execute(async ports => {
    const ids = new Set(Object.keys(declared));
    for (const operation of operations) {
      if (operation.action === 'edition.attach') ids.add(operation.sourceCollectionId!);
      if (operation.action === 'edition.publish' || operation.action === 'edition.update') {
        const edition = await ports.editions.lockById(operation.targetId!);
        if (!edition) throw new McpReportPlanError('stale_source', 'Report source is unavailable.');
        ids.add(edition.sourceCollectionId);
      }
    }
    const result: Record<string, string> = {};
    for (const id of [...ids].sort()) {
      const read = await ports.source.getForActor?.(id, { subjectId });
      if (!read?.facts || (read.verdict !== 'authorized' && read.verdict !== 'public')) {
        throw new McpReportPlanError('stale_source', 'Report source is unavailable.');
      }
      const revision = sourceRevision(read.facts);
      if (declared[id] !== undefined && declared[id] !== read.facts.contentRevision && declared[id] !== revision) {
        throw new McpReportPlanError('stale_source', 'Report source revision changed.');
      }
      result[id] = revision;
    }
    return result;
  });
}
