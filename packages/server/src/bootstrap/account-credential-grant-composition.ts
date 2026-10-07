import type { Kysely } from 'kysely';
import {
  assertGrantStillValidForPlan,
  composeAccountKeyRuntime,
  machineCredentialBindingId,
  type CredentialGrantCommandPorts,
  type CredentialGrantMachineBindingPort,
  type CredentialPlanPort,
} from '../modules/auth/index.js';
import {
  createPostgresAccountCredentialPorts,
  type AccountCredentialGrantRuntime,
} from '../infrastructure/auth/account-credentials-postgres.js';
import type { DatabaseTransaction } from '../infrastructure/database/index.js';
import { createCredentialPlanPort } from '../infrastructure/auth/account-credential-grants-postgres.js';
import type { DatabaseSchema, PostgresMcpStoredPlan } from '../infrastructure/database/index.js';
import type { AppConfig } from './config.js';

export function composeCredentialGrantMcp(input: {
  readonly config: AppConfig;
  readonly securityEpoch: CredentialGrantMachineBindingPort['securityEpoch'];
}): {
  readonly grantRuntime?: AccountCredentialGrantRuntime;
  bindCollectionPlanStore(store: {
    readonly planStore: { get(planId: string): PostgresMcpStoredPlan | undefined | PromiseLike<PostgresMcpStoredPlan | undefined> };
    readonly commitApprovalStore: { markApproved(transaction: DatabaseTransaction, input: {
      readonly planId: string;
      readonly binding: PostgresMcpStoredPlan['binding'];
      readonly operationsDigest: string;
    }): void | PromiseLike<void> };
  }): void;
} {
  let getCollectionPlan: (planId: string) => Promise<PostgresMcpStoredPlan | undefined> = async () => undefined;
  let markCollectionPlanApproved: (transaction: DatabaseTransaction, plan: PostgresMcpStoredPlan) => Promise<void>
    = async () => undefined;
  const machine = input.config.accountCredentials.enabled
    ? createGrantMachineBindingPort(input.config, input.securityEpoch)
    : undefined;
  const plansInTransaction = machine
    ? (transaction: DatabaseTransaction) => createGrantPlanPort({
      getCollectionPlan: (planId) => getCollectionPlan(planId),
      approveCollectionPlan: (plan) => markCollectionPlanApproved(transaction, plan),
    })
    : undefined;
  const grantRuntime = machine && plansInTransaction
    ? { plansInTransaction, machine }
    : undefined;
  return {
    ...(grantRuntime === undefined ? {} : { grantRuntime }),
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
}): CredentialPlanPort {
  return createCredentialPlanPort({
    getCollectionPlan: input.getCollectionPlan,
    approveCollectionPlan: input.approveCollectionPlan,
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
