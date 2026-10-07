import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const backendRoot = process.cwd();

export const KNOWN_BACKEND_SETUP = './.github/actions/known-backend-setup';

const actionPins = JSON.parse(
  readFileSync(resolve(backendRoot, '../scripts/github-action-pins.json'), 'utf8'),
) as Record<string, { sha: string; tag: string }>;

export function usesAction(uses: string | undefined, name: string): boolean {
  const sha = actionPins[name]?.sha;
  return Boolean(sha) && uses === `${name}@${sha}`;
}

export const ACTIONS_CHECKOUT = `actions/checkout@${actionPins['actions/checkout'].sha}`;

export function findBackendSetupStep(steps?: WorkflowStep[]): WorkflowStep | undefined {
  return steps?.find((step) => step.uses === KNOWN_BACKEND_SETUP);
}

export function findCallerCheckoutBeforeSetup(steps?: WorkflowStep[]): WorkflowStep | undefined {
  if (!steps) return undefined;
  const setupIndex = steps.findIndex((step) => step.uses === KNOWN_BACKEND_SETUP);
  if (setupIndex < 0) return undefined;
  for (let index = setupIndex - 1; index >= 0; index -= 1) {
    if (steps[index]?.uses === ACTIONS_CHECKOUT) return steps[index];
  }
  return undefined;
}

export function jobsMissingCallerCheckout(
  jobs: NonNullable<Workflow['jobs']>,
): string[] {
  return Object.entries(jobs).flatMap(([name, job]) => {
    const steps = job.steps ?? [];
    if (!findBackendSetupStep(steps)) return [];
    const checkout = findCallerCheckoutBeforeSetup(steps);
    return checkout ? [] : [name];
  });
}

export function inputIsTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function inputIsFalse(value: unknown): boolean {
  return value === false || value === 'false';
}

export function inputIsZero(value: unknown): boolean {
  return value === 0 || value === '0';
}

export interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
}

export interface Workflow {
  jobs?: Record<string, {
    name?: string;
    if?: string;
    needs?: string[];
    services?: Record<string, { image?: string; ports?: unknown; options?: string }>;
    steps?: WorkflowStep[];
    strategy?: { matrix?: { shard?: number[] }; 'fail-fast'?: boolean };
  }>;
}

export const PHASE5_FREE_SOCIAL_DEPENDENCIES_IF =
  "needs.changes.outputs.full == 'true' || needs.changes.outputs.phase5_free_social_dependencies == 'true' || (needs.changes.outputs.phase5_follow == 'true' && needs.changes.outputs.phase5_feed == 'true' && needs.changes.outputs.phase5_notification == 'true' && needs.changes.outputs.phase5_feed_operations == 'true' && needs.changes.outputs.phase5_notification_operations == 'true')";

export const FOLLOW_ONLY_PRODUCER_OR_IF =
  "needs.changes.outputs.full == 'true' || needs.changes.outputs.phase5_follow == 'true' || needs.changes.outputs.phase5_feed == 'true' || needs.changes.outputs.phase5_notification == 'true' || needs.changes.outputs.phase5_feed_operations == 'true' || needs.changes.outputs.phase5_notification_operations == 'true' || needs.changes.outputs.phase5_free_social_dependencies == 'true'";

export const FOLLOW_ONLY_CHANGE_OUTPUTS = {
  full: false,
  phase5_follow: true,
  phase5_feed: false,
  phase5_notification: false,
  phase5_feed_operations: false,
  phase5_notification_operations: false,
  phase5_free_social_dependencies: false,
} as const;

export const DEDICATED_ONLY_CHANGE_OUTPUTS = {
  ...FOLLOW_ONLY_CHANGE_OUTPUTS,
  phase5_follow: false,
  phase5_free_social_dependencies: true,
} as const;

export const PHASE5_FREE_SOCIAL_PRODUCER_OWN_FILTERS = {
  'phase5-follow-acceptance': 'phase5_follow',
  'phase5-feed-acceptance': 'phase5_feed',
  'phase5-notification-acceptance': 'phase5_notification',
  'phase5-feed-operations-acceptance': 'phase5_feed_operations',
  'phase5-notification-operations-acceptance': 'phase5_notification_operations',
} as const;

export function expectedPhase5ProducerIf(ownFilter: string): string {
  return `needs.changes.outputs.full == 'true' || needs.changes.outputs.${ownFilter} == 'true' || needs.changes.outputs.phase5_free_social_dependencies == 'true'`;
}

export function producerJobsMissingDedicatedFilter(
  jobs: NonNullable<Workflow['jobs']>,
): string[] {
  return Object.keys(PHASE5_FREE_SOCIAL_PRODUCER_OWN_FILTERS).filter((jobName) => {
    const expression = jobs[jobName]?.if;
    return typeof expression !== 'string'
      || !expression.includes('phase5_free_social_dependencies');
  });
}

export function evaluateChangeOutputIf(
  expression: string,
  outputs: Record<string, boolean>,
): boolean {
  if (/\balways\s*\(\s*\)/u.test(expression)) {
    return true;
  }
  const substituted = expression.replace(
    /needs\.changes\.outputs\.([A-Za-z0-9_]+)\s*==\s*'true'/gu,
    (_match, key: string) => (outputs[key] === true ? 'true' : 'false'),
  );
  const compact = substituted.replace(/\s+/gu, '');
  if (!/^(?:true|false|&&|\|\||\(|\))+$/u.test(compact)) {
    throw new Error(`cannot evaluate job if remainder: ${substituted}`);
  }
  const tokens = compact.match(/true|false|&&|\|\||\(|\)/gu) ?? [];
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const eat = (expected?: string): string => {
    const token = tokens[index];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expected ${expected ?? 'token'}, got ${token}`);
    }
    index += 1;
    return token;
  };
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (peek() === '||') {
      eat();
      value = parseAnd() || value;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parsePrimary();
    while (peek() === '&&') {
      eat();
      value = parsePrimary() && value;
    }
    return value;
  };
  const parsePrimary = (): boolean => {
    if (peek() === '(') {
      eat();
      const value = parseOr();
      eat(')');
      return value;
    }
    if (peek() === 'true') {
      eat();
      return true;
    }
    if (peek() === 'false') {
      eat();
      return false;
    }
    throw new Error(`unexpected token ${peek()}`);
  };
  const value = parseOr();
  if (index !== tokens.length) {
    throw new Error(`unconsumed if tokens: ${tokens.slice(index).join(' ')}`);
  }
  return value;
}

export function validatePublicationJob(workflow: Workflow): string[] {
  const steps = workflow.jobs?.['publication-acceptance']?.steps;
  if (!steps) return ['publication-acceptance job must exist and define steps'];

  const errors: string[] = [];
  const setup = findBackendSetupStep(steps);
  const setupIndex = setup ? steps.indexOf(setup) : -1;
  if (!setup) {
    errors.push('publication acceptance must use known-backend-setup');
  } else {
    if (!inputIsTrue(setup.with?.postgres)) {
      errors.push('publication acceptance setup must enable postgres');
    }
    if (!inputIsTrue(setup.with?.['frontend-install'])) {
      errors.push('publication acceptance must use a frozen web install');
    }
    if (setup.with?.playwright !== 'frontend') {
      errors.push('publication acceptance setup must use playwright: frontend');
    }
    const npmCache = setup.with?.['npm-cache'];
    if (typeof npmCache !== 'string' || !npmCache.includes('frontend')) {
      errors.push('setup-node cache must depend on the web lockfile');
    }
  }

  const harnessIndex = steps.findIndex((step) => (
    step.name === 'Phase 2 Publication black-box acceptance'
    && step.run === 'npm run evidence:phase2-publication'
    && step['working-directory'] === 'Known-Backend'
  ));
  if (harnessIndex < 0) errors.push('publication acceptance harness step must exist');
  if (setupIndex >= 0 && harnessIndex >= 0 && setupIndex >= harnessIndex) {
    errors.push('frozen web install must precede the harness');
  }
  const profileIndex = steps.findIndex((step) => (
    step.name === 'Phase 2 Profile conformance deployment probes'
    && step.run === 'npm run evidence:phase2-profile-conformance'
    && step['working-directory'] === 'Known-Backend'
  ));
  if (profileIndex < 0) errors.push('publication acceptance must own Profile conformance');
  if (setupIndex >= 0 && profileIndex >= 0 && setupIndex >= profileIndex) {
    errors.push('frozen web install must precede Profile conformance');
  }
  return errors;
}
