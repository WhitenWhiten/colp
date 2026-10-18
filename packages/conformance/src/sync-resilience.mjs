import { isDeepStrictEqual } from 'node:util';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { Report } from './report.mjs';

export const SYNC_RESILIENCE_CHECKS = Object.freeze([
  ['SYNC-0032', 'Consumed conflicts hold only dependent operations and release fresh captures'],
  ['SYNC-0033', 'Unapplied Pull items are durable, independent events apply, and Ack warns'],
  ['SYNC-0034', 'Page integrity failures mutate nothing and advance no cursor'],
  ['SYNC-0035', 'Subtree deletion preserves protected members, ancestors and repair evidence'],
  ['SYNC-0036', 'Health is bounded, installation-authorized and changes no Sync authority'],
  ['SYNC-0037', 'Commands execute at most once and report durable outcomes'],
].map(([id, title]) => Object.freeze({ id, title, level: 'MUST' })));
const checks = new Map(SYNC_RESILIENCE_CHECKS.map(check => [check.id, check]));
let validators;
const unsafe = /https?:\/\/|javascript:|chrome:|authorization|bearer|token=|secret|native[_ -]?id/iu;
const warningCodes = new Set(['apply_set_aside', 'placement_unproven', 'identity_unproven', 'record_invalid', 'delete_held']);

/** Verify concrete observations from a disposable client/server scenario, never boolean attestations. */
export function verifySyncResilienceCase(id, observed) {
  if (!checks.has(id)) throw new TypeError(`Unknown Sync resilience case ${id}`);
  const errors = [];
  const require = (ok, detail) => { if (!ok) errors.push(detail); };
  const array = value => Array.isArray(value) ? value : [];
  try {
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) throw new TypeError('missing observation');
    const o = observed;
    if (id === 'SYNC-0032') {
      const conflict = o.results.find(row => row.status === 'conflicted');
      require(conflict?.sequence >= 1, 'missing consumed conflict receipt');
      const independent = o.results.filter(row => row.status === 'applied' && row.targetId !== conflict?.targetId);
      require(independent.some(row => row.sequence > conflict?.sequence), 'unrelated upload did not pass the conflict');
      require(o.held.length > 0 && o.held.every(row => row.status === 'set_aside'
        && row.targetId === conflict?.targetId), 'later target operations were not held');
      require(new Set(o.recaptured.map(row => row.originalOpId)).size === o.held.length
        && new Set(o.recaptured.map(row => row.opId)).size === o.held.length
        && o.recaptured.length === o.held.length && o.recaptured.every(row =>
        o.held.some(held => held.opId === row.originalOpId && held.opId !== row.opId && held.targetId === row.targetId)
        && row.sequence > Math.max(...independent.map(item => item.sequence))
        && row.title === o.currentNativeTitle), 'release did not capture current native state at the tail');
    } else if (id === 'SYNC-0033') {
      require(o.events.length === 3 && o.events[0].state === 'applied'
        && o.events[1].state === 'not_applied' && o.events[2].state === 'applied', 'middle item blocked independent events');
      const held = o.events[1];
      require(o.issues.some(issue => issue.nodeId === held.nodeId && issue.eventId && issue.code), 'unapplied evidence was not durable');
      require(typeof o.cursor === 'string' && o.cursor === o.ackedCursor, 'page cursor was not durably acknowledged');
      require(o.warnings.some(warning => warningCodes.has(warning.code) && warning.path === `/nodes/${held.nodeId}`
        && typeof warning.message === 'string' && warning.message.length <= 256 && !unsafe.test(warning.message)), 'missing safe warning naming the unapplied node');
    } else if (id === 'SYNC-0034') {
      require(typeof o.failureCode === 'string' && /(?:digest|binding|page|cursor|effect|event)/u.test(o.failureCode), 'missing integrity denial');
      require(o.cursorBefore === o.cursorAfter && typeof o.cursorBefore === 'string', 'integrity failure advanced the cursor');
      require(Array.isArray(o.nativeBefore) && isDeepStrictEqual(o.nativeBefore, o.nativeAfter), 'integrity failure mutated native state');
      require(o.setAside.length === 0, 'integrity failure was downgraded to an item');
    } else if (id === 'SYNC-0035') {
      require(o.protected.length > 0 && o.ancestors.length > 0 && o.independent.length > 0, 'missing mixed subtree fixture');
      require([...o.protected, ...o.ancestors].every(node => o.survivors.includes(node)), 'delete removed a protected member or needed ancestor');
      require(o.independent.every(node => !o.survivors.includes(node)), 'independent subtree members did not delete');
      require(o.protected.every(node => o.excluded.includes(node) && o.retainedIssues.includes(node)), 'retained member lost exclusion or repair evidence');
      require(typeof o.cursor === 'string' && o.cursor !== o.previousCursor, 'independent delete did not complete');
    } else if (id === 'SYNC-0036') {
      validators ??= createValidatorRegistry();
      require(validators.validate('syncReplicaHealthReport', o.report).valid, 'invalid health wire document');
      require(Buffer.byteLength(JSON.stringify(o.report), 'utf8') <= 32768, 'health UTF-8 body exceeds budget');
      require(o.report.issues.total >= o.report.issues.items.length, 'issue total lost omitted items');
      require(new Set(o.report.issues.items.map(item => item.issueId)).size === o.report.issues.items.length, 'duplicate issue IDs');
      require(o.report.issues.items.every(item => !item.title || !unsafe.test(item.title)), 'unsafe issue display text');
      require(validators.validate('syncReplicaHealthResult', o.response).valid, 'invalid health response');
      require(o.response.accepted === true && o.response.revision >= o.report.revision, 'new report was not accepted');
      require(new Set((o.report.commandResults ?? []).map(result => result.commandId)).size === (o.report.commandResults ?? []).length, 'duplicate command result IDs');
      require(new Set(o.response.commands.map(command => command.commandId)).size === o.response.commands.length, 'duplicate delivered command IDs');
      require(o.response.replicaId === o.report.replicaId, 'response names another replica');
      const authorityKeys = ['leaseExpiresAt', 'lastSeenAt', 'cursor', 'checkpoint', 'lifecycle'];
      require(authorityKeys.every(key => Object.hasOwn(o.authorityBefore, key) && o.authorityBefore[key] !== undefined)
        && isDeepStrictEqual(o.authorityBefore, o.authorityAfter), 'health touched or omitted Sync authority');
      require([401, 403, 404, 410].includes(o.foreignProofStatus), 'another installation reported or settled commands');
      require(o.olderResponse?.accepted === false && o.olderResponse.revision === o.response.revision,
        'older revision rolled health back');
      require(isDeepStrictEqual(o.storedWarnings, o.ackWarnings) && array(o.ackWarnings).length > 0, 'Ack warnings were not retained');
    } else if (id === 'SYNC-0037') {
      validators ??= createValidatorRegistry();
      require(o.deliveries.length >= 2 && o.deliveries[0].commandId === o.deliveries[1].commandId, 'fixture did not redeliver a command');
      require(o.deliveries.every(command => validators.validate('syncReplicaCommand', command).valid), 'commands contain data or invalid fields');
      const commandId = o.deliveries[0].commandId;
      require(o.executions.filter(id => id === commandId).length === 1, 'redelivery executed more or less than once');
      require(o.resultReports.length >= 2 && o.resultReports.every(report =>
        report.commandResults?.some(result => result.commandId === commandId && result.outcome === 'done')
        && validators.validate('syncReplicaHealthReport', report).valid), 'result did not survive response loss');
      require(o.refused.some(result => result.outcome === 'failed'
        && ['action_unavailable', 'issue_gone'].includes(result.code)), 'stale or unavailable action was executed');
    }
  } catch {
    errors.push('missing or malformed scenario observations');
  }
  return errors;
}

/**
 * Opt-in adapter runner. Each runScenario(id) must create an isolated scenario and
 * return the documented concrete observations. undefined means unsupported/skip.
 * The caller owns adapter teardown; the CLI always invokes close() in finally.
 */
export async function runSyncResilienceConformance(target, { cases = [...checks.keys()] } = {}) {
  for (const id of cases) if (!checks.has(id)) throw new TypeError(`Unknown Sync resilience case ${id}`);
  const report = new Report(target.name ?? 'Sync resilience adapter', SYNC_RESILIENCE_CHECKS);
  for (const id of cases) {
    try {
      const observed = await target.runScenario(id);
      if (observed === undefined) { report.skip(id, 'adapter does not support this scenario'); continue; }
      const errors = verifySyncResilienceCase(id, observed);
      if (!errors.length) report.record(id, true);
      for (const error of errors) report.record(id, false, error);
    } catch {
      report.record(id, false, 'scenario execution failed');
    }
  }
  report.skipRemaining('not selected');
  return { ...report.finish(0), profile: 'sync resilience (isolated adapter scenarios)' };
}
