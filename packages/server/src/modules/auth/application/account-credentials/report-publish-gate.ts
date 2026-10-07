import { AccountCredentialCommandError } from './errors.js';
import { assertGrantStillValidForPlan } from './grant-commands.js';
import type { CredentialGrantCommandPorts } from './grant-types.js';

/** Scope the product HTTP publish route requires from machine bearer tokens. */
export const REPORT_PUBLISH_SCOPE = 'reports:publish';

export async function assertReportPublishAuthorized(
  ports: CredentialGrantCommandPorts,
  input: {
    readonly seriesId: string;
    readonly editionId: string;
    readonly accountId: string;
    readonly credentialId: string;
    readonly scopes: readonly string[];
  },
  options: { readonly lock?: boolean } = {},
): Promise<{ readonly planId: string }> {
  if (!input.scopes.includes(REPORT_PUBLISH_SCOPE)) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish requires the reports:publish scope.',
    );
  }
  const authorization = await ports.grants.findReportPublishAuthorization({
    seriesId: input.seriesId,
    editionId: input.editionId,
    ...(options.lock === true ? { lock: true } : {}),
  });
  if (!authorization) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish requires a valid approved plan authorization.',
    );
  }
  if (authorization.credentialId !== input.credentialId) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish plan authorization does not match this credential.',
    );
  }
  const grant = options.lock
    ? await ports.grants.lockById(authorization.grantId)
    : await ports.grants.findById(authorization.grantId);
  if (!grant || grant.ownerAccountId !== input.accountId) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish plan authorization does not match this account.',
    );
  }
  if (!grant.actions.includes('report.issue.publish')) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish requires a grant action of report.issue.publish.',
    );
  }
  const now = await ports.clock.now();
  await assertGrantStillValidForPlan(ports, {
    planKind: 'report',
    planId: authorization.planId,
  }, options.lock === true ? { lock: true } : {});
  const plan = await ports.plans.getPlan('report', authorization.planId);
  if (!plan || plan.approvalStatus !== 'approved') {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish plan is not approved.',
    );
  }
  if (Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new AccountCredentialCommandError(
      'insufficient_permission',
      'Report publish plan has expired.',
    );
  }
  return { planId: authorization.planId };
}

export async function consumeReportPublishAuthorization(
  ports: CredentialGrantCommandPorts,
  planId: string,
): Promise<void> {
  await ports.grants.consumeReportPublishAuthorization(planId);
}