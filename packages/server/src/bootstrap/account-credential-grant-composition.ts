import { createHash } from 'node:crypto';
import { captureReportSourceRevisions, currentReportSourceRevisions } from './report-plan-source-revisions.js';
import type { Kysely } from 'kysely';
import {
  assertGrantStillValidForPlan,
  assertReportPublishAuthorized,
  consumeReportPublishAuthorization,
  composeAccountKeyRuntime,
  machineCredentialBindingId,
  type CredentialGrantCommandPorts,
  type CredentialGrantMachineBindingPort,
  type CredentialPlanPort,
} from '../modules/auth/index.js';
import type { ReportPublishGuard } from '../modules/reports/index.js';
import {
  approveMcpReportPlan,
  createReportMcpWriteToolPort,
  requireMcpAccountSubjectId,
  type McpApplicationWritePort,
  type McpReportPlan,
} from '../modules/mcp/index.js';
import {
  createDigestSeries,
  publishEdition,
  updateDigestSeries,
  updateEdition,
  attachEdition,
  type ReportTransactionPorts,
  type ReportUnitOfWork,
} from '../modules/reports/index.js';
import {
  createPostgresAccountCredentialPorts,
  type AccountCredentialGrantRuntime,
} from '../infrastructure/auth/account-credentials-postgres.js';
import type { DatabaseTransaction } from '../infrastructure/database/index.js';
import {
  createCredentialPlanPort,
  createPostgresMcpReportPlanStore,
} from '../infrastructure/auth/account-credential-grants-postgres.js';
import type { DatabaseSchema, PostgresMcpStoredPlan } from '../infrastructure/database/index.js';
import {
  createPostgresReportsUnitOfWork,
  type PostgresReportsUnitOfWorkOptions,
} from '../infrastructure/reports/index.js';
import { strongEntityTag } from '../modules/collections/index.js';
import type { AppConfig } from './config.js';

export function composeCredentialGrantMcp(input: {
  readonly config: AppConfig;
  readonly db: Kysely<DatabaseSchema>;
  readonly securityEpoch: CredentialGrantMachineBindingPort['securityEpoch'];
  readonly reportsUnitOfWork?: ReportUnitOfWork;
  readonly reportsUnitOfWorkOptions?: Pick<
    PostgresReportsUnitOfWorkOptions, 'publicSurfacePurgeEnabled'
  >;
  readonly incomingReportWritePort?: McpApplicationWritePort;
}): {
  readonly grantRuntime?: AccountCredentialGrantRuntime;
  readonly reportWritePort?: McpApplicationWritePort;
  readonly reportPlanStore: ReturnType<typeof createPostgresMcpReportPlanStore>;
  bindCollectionPlanStore(store: {
    readonly planStore: { get(planId: string): PostgresMcpStoredPlan | undefined | PromiseLike<PostgresMcpStoredPlan | undefined> };
    readonly commitApprovalStore: { markApproved(transaction: DatabaseTransaction, input: {
      readonly planId: string;
      readonly binding: PostgresMcpStoredPlan['binding'];
      readonly operationsDigest: string;
    }): void | PromiseLike<void> };
  }): void;
} {
  const reportPlanStore = createPostgresMcpReportPlanStore(input.db);
  let getCollectionPlan: Parameters<typeof createGrantPlanPort>[0]['getCollectionPlan'] = async () => undefined;
  let markCollectionPlanApproved: (transaction: DatabaseTransaction, plan: PostgresMcpStoredPlan) => Promise<void>
    = async () => undefined;
  const machine = input.config.accountCredentials.enabled
    ? createGrantMachineBindingPort(input.config, input.securityEpoch)
    : undefined;
  const plansInTransaction = machine
    ? (transaction: DatabaseTransaction) => createGrantPlanPort({
      getCollectionPlan: (planId) => getCollectionPlan(planId),
      approveCollectionPlan: (plan) => markCollectionPlanApproved(transaction, plan),
      reportPlans: createPostgresMcpReportPlanStore(transaction),
      transaction,
    })
    : undefined;
  const grantRuntime = machine && plansInTransaction
    ? { plansInTransaction, machine }
    : undefined;
  let reportWritePort = input.incomingReportWritePort;
  if (input.config.reports.mcpWriteEnabled && input.reportsUnitOfWork !== undefined && reportWritePort === undefined) {
    reportWritePort = createDurableReportWritePort({
      reports: input.reportsUnitOfWork,
      store: reportPlanStore,
      ...(grantRuntime
        ? {
          reportsForExecutePlan: (planId) => createPostgresReportsUnitOfWork(input.db, {
            ...sharedReportsUnitOfWorkOptions(input.reportsUnitOfWorkOptions),
            beforeExecute: async (transaction) => {
              // Hold grant row locks until this execute transaction ends.
              await assertGrantStillValidForPlan(
                grantCommandPorts(transaction, grantRuntime),
                { planKind: 'report', planId },
                { lock: true },
              );
            },
            afterExecute: async (transaction) => {
              await consumeReportPublishAuthorization(grantCommandPorts(transaction, grantRuntime), planId);
            },
          }),
        }
        : {}),
    });
  }
  return {
    ...(grantRuntime === undefined ? {} : { grantRuntime }),
    ...(reportWritePort === undefined ? {} : { reportWritePort }),
    reportPlanStore,
    bindCollectionPlanStore(store) {
      getCollectionPlan = (planId) => Promise.resolve(store.planStore.get(planId));
      markCollectionPlanApproved = async (transaction, plan) => {
        await store.commitApprovalStore.markApproved(transaction, {
          planId: plan.planId,
          binding: plan.binding,
          operationsDigest: plan.operationsDigest,
        });
      };
    },
  };
}

export function createGrantMachineBindingPort(
  config: AppConfig,
  securityEpoch: CredentialGrantMachineBindingPort['securityEpoch'],
): CredentialGrantMachineBindingPort {
  const runtime = composeAccountKeyRuntime({
    productOrigin: config.productOrigin,
    betterAuthBasePath: config.betterAuth.basePath,
    ...(config.mcp?.oauth.issuer ? { mcpIssuer: config.mcp.oauth.issuer } : {}),
    ...(config.mcp?.oauth.audience ? { mcpStrictAudience: config.mcp.oauth.audience } : {}),
    ...(config.mcp?.oauth.scopes ? { mcpScopes: config.mcp.oauth.scopes } : {}),
    privateJwk: config.accountCredentials.es256PrivateJwk,
    previousPublicJwks: config.accountCredentials.es256PreviousPublicJwks,
  });
  return {
    issuer: () => runtime.issuer,
    securityEpoch,
    expectedBindingId: (input) => machineCredentialBindingId({
      iss: runtime.issuer,
      ...input,
    }),
  };
}

export function createGrantPlanPort(input: {
  readonly getCollectionPlan: (planId: string) => Promise<PostgresMcpStoredPlan | undefined>;
  readonly approveCollectionPlan: (plan: PostgresMcpStoredPlan) => Promise<void>;
  readonly reportPlans: ReturnType<typeof createPostgresMcpReportPlanStore>;
  readonly transaction: DatabaseTransaction;
}): CredentialPlanPort {
  return createCredentialPlanPort({
    getCollectionPlan: input.getCollectionPlan,
    approveCollectionPlan: input.approveCollectionPlan,
    getReportPlan: (planId) => input.reportPlans.get(planId),
    approveReportPlan: async (plan) => {
      await approveMcpReportPlan(input.reportPlans, plan.planId, plan.binding);
    },
    transaction: input.transaction,
  });
}

export function createDurableReportWritePort(input: {
  readonly reports: ReportUnitOfWork;
  readonly store: ReturnType<typeof createPostgresMcpReportPlanStore>;
  readonly reportsForExecutePlan?: (planId: string) => ReportUnitOfWork;
}): McpApplicationWritePort {
  return createReportMcpWriteToolPort({
    store: input.store,
    captureSourceRevisions: (operations, declared, context) => captureReportSourceRevisions(
      input.reports, operations, declared, requireMcpAccountSubjectId(context.authorization)),
    revisions: {
      currentReportRevision: (plan) => currentReportRevision(input.reports, plan),
      currentSourceRevisions: (plan) => currentReportSourceRevisions(input.reports, plan),
    },
    executePlanWithValidation: (plan, context, validate) => {
      const reports = input.reportsForExecutePlan?.(plan.planId) ?? input.reports;
      return reports.execute(async ports => {
        const binding = { principalId: context.principal.principalId,
          commandScope: 'mcp.reports.commit', commandId: commandIdFrom(plan.planId, 'commit', 'plan') };
        const fingerprint = createHash('sha256').update(JSON.stringify({
          digest: plan.operationsDigest, binding: plan.binding, key: plan.commitIdempotencyKey,
        })).digest('hex');
        const claim = await ports.receipts.claim(binding, fingerprint);
        if (claim.kind === 'replay') return JSON.parse(Buffer.from(claim.result.body).toString('utf8')) as unknown;
        if (claim.kind !== 'claimed') throw new Error(`Report Plan execution ${claim.kind}`);
        const transactionReports: ReportUnitOfWork = { execute: work => work(ports) };
        await validate({
          currentReportRevision: candidate => currentReportRevision(transactionReports, candidate),
          currentSourceRevisions: candidate => currentReportSourceRevisions(transactionReports, candidate),
        });
        const value = await executeReportPlan(transactionReports, plan, context);
        await ports.receipts.complete(binding, fingerprint, {
          status: 200, body: Buffer.from(JSON.stringify(value)), stableHeaders: {},
          mediaType: 'application/json', contractVersion: 'reports.plan.v1', targetIdentity: plan.planId,
        });
        return value;
      });
    },
    executePlan: (plan, context) => executeReportPlan(
      input.reportsForExecutePlan?.(plan.planId) ?? input.reports,
      plan,
      context,
    ),
  });
}

export function createCollectionGrantCommitGuard(input: {
  readonly db: Kysely<DatabaseSchema>;
  readonly plansInTransaction: (transaction: DatabaseTransaction) => CredentialPlanPort;
  readonly machine: CredentialGrantMachineBindingPort;
}): (input: { readonly planId: string; readonly transaction: DatabaseTransaction }) => Promise<void> {
  return async ({ planId, transaction }) => {
    const ports = createPostgresAccountCredentialPorts(transaction, undefined, {
      plansInTransaction: input.plansInTransaction,
      machine: input.machine,
    }) as CredentialGrantCommandPorts;
    await assertGrantStillValidForPlan(ports, { planKind: 'collection', planId }, { lock: true });
  };
}

export function createReportPublishGuard(input: {
  readonly db: Kysely<DatabaseSchema>;
  readonly plansInTransaction: (transaction: DatabaseTransaction) => CredentialPlanPort;
  readonly machine: CredentialGrantMachineBindingPort;
  readonly publicSurfacePurgeEnabled?: boolean;
}): ReportPublishGuard {
  const grantRuntime = {
    plansInTransaction: input.plansInTransaction,
    machine: input.machine,
  };
  return {
    reportsUnitOfWorkFor(publishInput) {
      let planId: string | undefined;
      return createPostgresReportsUnitOfWork(input.db, {
        ...sharedReportsUnitOfWorkOptions(input),
        beforeExecute: async (transaction) => {
          // Hold grant row locks until this publish transaction ends.
          const authorized = await assertReportPublishAuthorized(
            grantCommandPorts(transaction, grantRuntime),
            publishInput,
            { lock: true },
          );
          planId = authorized.planId;
        },
        afterExecute: async (transaction, result) => {
          if (planId === undefined || !isSucceededReportMutation(result)) return;
          await consumeReportPublishAuthorization(grantCommandPorts(transaction, grantRuntime), planId);
        },
      });
    },
  };
}

function grantCommandPorts(
  transaction: DatabaseTransaction,
  grantRuntime: AccountCredentialGrantRuntime,
): CredentialGrantCommandPorts {
  return createPostgresAccountCredentialPorts(transaction, undefined, grantRuntime) as CredentialGrantCommandPorts;
}

function sharedReportsUnitOfWorkOptions(input: {
  readonly publicSurfacePurgeEnabled?: boolean;
} | undefined): Pick<PostgresReportsUnitOfWorkOptions, 'publicSurfacePurgeEnabled'> {
  return {
    ...(input?.publicSurfacePurgeEnabled === true ? { publicSurfacePurgeEnabled: true } : {}),
  };
}

function isSucceededReportMutation(result: unknown): boolean {
  return typeof result === 'object' && result !== null
    && (result as { kind?: unknown }).kind === 'succeeded';
}

async function currentReportRevision(reports: ReportUnitOfWork, plan: McpReportPlan): Promise<string> {
  return reports.execute(async ports => {
    for (const operation of plan.operations) {
      let seriesId: string | undefined;
      if (operation.action === 'series.update') seriesId = operation.targetId;
      else if (operation.action === 'edition.attach') seriesId = operation.seriesId;
      else if (operation.action === 'edition.publish' || operation.action === 'edition.update') {
        const edition = await ports.editions.lockById(operation.targetId!);
        if (!edition) return `${plan.reportRevision}\0missing`;
        seriesId = edition.seriesId;
      }
      if (seriesId !== undefined) {
        const series = await ports.series.lockById(seriesId);
        return series?.resourceRevision ?? `${plan.reportRevision}\0missing`;
      }
    }
    // Creation has no pre-existing report revision to fence.
    return plan.reportRevision;
  });
}

async function executeReportPlan(
  reports: ReportUnitOfWork,
  plan: McpReportPlan,
  context: { readonly principal: { readonly principalId: string }; readonly authorization: Readonly<Record<string, unknown>> },
): Promise<unknown> {
  const actor = {
    principalId: context.principal.principalId,
    subjectId: requireMcpAccountSubjectId(context.authorization),
  };
  const results = [];
  for (const [index, operation] of plan.operations.entries()) {
    const commandId = commandIdFrom(plan.planId, operation.action, String(index));
    if (operation.action === 'series.update') {
      results.push(await updateDigestSeries(reports, {
        actor,
        commandId,
        seriesId: String(operation.targetId),
        expectedRevision: asEtag(String(operation.expectedRevision)),
        ...(typeof operation.patch.title === 'string' ? { title: operation.patch.title } : {}),
        ...(operation.patch.summary === undefined ? {} : { summary: operation.patch.summary as string | null }),
        ...(operation.patch.slug === undefined ? {} : { slug: operation.patch.slug as string | null }),
        ...(typeof operation.patch.visibility === 'string'
          ? { visibility: operation.patch.visibility as 'private' | 'protected' | 'unlisted' | 'public' }
          : {}),
        ...(typeof operation.patch.allowSearchIndexing === 'boolean'
          ? { allowSearchIndexing: operation.patch.allowSearchIndexing }
          : {}),
      }));
    } else if (operation.action === 'series.create') {
      results.push(await createDigestSeries(reports, {
        actor,
        commandId,
        title: String(operation.patch.title),
        summary: (operation.patch.summary as string | null | undefined) ?? null,
        slug: (operation.patch.slug as string | null | undefined) ?? null,
        visibility: operation.patch.visibility as 'private' | 'protected' | 'unlisted' | 'public' | undefined,
        allowSearchIndexing: operation.patch.allowSearchIndexing as boolean | undefined,
      }));
    } else if (operation.action === 'edition.publish') {
      results.push(await publishEdition(reports, {
        actor,
        commandId,
        editionId: String(operation.targetId),
        expectedRevision: asEtag(String(operation.expectedRevision)),
      }));
    } else if (operation.action === 'edition.update') {
      results.push(await updateEdition(reports, {
        actor,
        commandId,
        editionId: String(operation.targetId),
        expectedRevision: asEtag(String(operation.expectedRevision)),
        ...(typeof operation.patch.titleSnapshot === 'string' ? { titleSnapshot: operation.patch.titleSnapshot } : {}),
        ...(operation.patch.summarySnapshot === undefined
          ? {}
          : { summarySnapshot: operation.patch.summarySnapshot as string | null }),
        ...editionPeriodPatch(operation.patch),
      }));
    } else if (operation.action === 'edition.attach') {
      results.push(await attachEdition(reports, {
        actor,
        commandId,
        seriesId: String(operation.seriesId),
        sourceCollectionId: String(operation.sourceCollectionId),
        issueKey: String(operation.patch.issueKey),
        titleSnapshot: String(operation.patch.titleSnapshot),
        summarySnapshot: (operation.patch.summarySnapshot as string | null | undefined) ?? null,
        ...editionPeriodPatch(operation.patch),
      }));
    }
  }
  if (results.some(result => result.kind !== 'succeeded')) throw new Error('Report Plan operation did not complete');
  return results;
}

function editionPeriodPatch(patch: Readonly<Record<string, unknown>>): {
  periodStart?: string | null; periodEnd?: string | null;
} {
  return {
    ...(patch.periodStart === undefined ? {} : { periodStart: patch.periodStart as string | null }),
    ...(patch.periodEnd === undefined ? {} : { periodEnd: patch.periodEnd as string | null }),
  };
}

function asEtag(value: string): string {
  return value.startsWith('"') ? value : strongEntityTag(value);
}

function commandIdFrom(planId: string, action: string, target: string): string {
  const hex = createHash('sha256').update(`${planId}\0${action}\0${target}`, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
