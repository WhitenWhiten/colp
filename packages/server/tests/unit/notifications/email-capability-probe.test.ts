import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  EMAIL_CAPABILITY_PROBE_SCHEMA_VERSION,
  runEmailCapabilityProbe,
  type EmailCapabilityProbeDependencies,
} from '../../../scripts/email-capability-probe.js';

function fakeDeps(overrides: Partial<EmailCapabilityProbeDependencies> = {}): EmailCapabilityProbeDependencies {
  return {
    emailEnabled: true,
    callbackVerifierConfigured: () => Promise.resolve(true),
    suppressionTablePresent: () => Promise.resolve(true),
    migrationHead: () => Promise.resolve('202608020800_notification_email_suppressions'),
    workerComposed: () => Promise.resolve({ composed: true, running: true }),
    adapterReachable: () => Promise.resolve({ mode: 'fixture', classification: 'success', providerMessageId: 'env-probe' }),
    queueHealth: () => Promise.resolve({ pending: 0, retry: 0, deadLetter: 0, delivered: 1, suppressed: 0 }),
    suppressionFacts: () => Promise.resolve(0),
    readinessGauges: () => Promise.resolve([
      'notifications.email_delivery.enabled',
      'notifications.email_delivery.worker_running',
      'notifications.email_delivery.suppression_facts',
      'notifications.email_delivery.probe.status',
      'notifications.optional_delivery.available',
    ]),
    ...overrides,
  };
}

test('P5-31 probe reports disabled independently when the email feature flag is off (no false claims)', async () => {
  // N15: when the flag is off the probe must short-circuit WITHOUT touching any
  // of the heavier fakes (worker composition, adapter reachability, DB queues,
  // gauges) - a disabled capability never claims checks it did not run.
  const touched: string[] = [];
  const tracking = (name: string, impl: () => Promise<unknown>) => {
    const wrapped = async () => { touched.push(name); return impl(); };
    return wrapped as never;
  };
  const result = await runEmailCapabilityProbe({
    emailEnabled: false,
    callbackVerifierConfigured: tracking('callbackVerifierConfigured', async () => true),
    suppressionTablePresent: tracking('suppressionTablePresent', async () => true),
    migrationHead: tracking('migrationHead', async () => '202608020800_notification_email_suppressions'),
    workerComposed: tracking('workerComposed', async () => ({ composed: true, running: true })),
    adapterReachable: tracking('adapterReachable', async () => ({ mode: 'fixture', classification: 'success' })),
    queueHealth: tracking('queueHealth', async () => ({ pending: 0, retry: 0, deadLetter: 0, delivered: 0, suppressed: 0 })),
    suppressionFacts: tracking('suppressionFacts', async () => 0),
    readinessGauges: tracking('readinessGauges', async () => ['notifications.email_delivery.enabled']),
  });
  assert.equal(result.emailCapability, 'disabled');
  assert.equal(result.probeStatus, 'disabled');
  assert.equal(result.deploymentProven, false);
  assert.equal(result.checks.featureFlag.status, 'disabled');
  assert.equal(result.evidence, 'email_capability_probe');
  assert.equal(result.schemaVersion, EMAIL_CAPABILITY_PROBE_SCHEMA_VERSION);
  assert.deepEqual(touched, [],
    'a disabled probe must not invoke worker/adapter/queue/gauge dependencies (N15)');
});

test('P5-31 probe passes green for a composed worker + controlled fixture', async () => {
  const result = await runEmailCapabilityProbe(fakeDeps());
  assert.equal(result.emailCapability, 'enabled');
  assert.equal(result.probeStatus, 'passed');
  assert.equal(result.deploymentProven, false);
  assert.equal(JSON.stringify(result).includes('Deployment-proven'), false);
  for (const [name, check] of Object.entries(result.checks)) {
    assert.equal(check.status, 'passed', `${name} must pass`);
  }
  assert.equal(result.checks.adapterReachability.mode, 'fixture');
  assert.equal(result.checks.suppressionTable.migrationHead, '202608020800_notification_email_suppressions');
  assert.deepEqual(result.checks.deliveryQueue, {
    status: 'passed', pending: 0, retry: 0, deadLetter: 0, delivered: 1, suppressed: 0,
  });
});

test('P5-31 probe accepts a later migration head when the suppression migration remains in history', async () => {
  const result = await runEmailCapabilityProbe(fakeDeps({
    migrationHead: () => Promise.resolve('202608051000_mcp_write_change_plans'),
  }));
  assert.equal(result.probeStatus, 'passed');
  assert.equal(result.checks.suppressionTable.migrationHead, '202608051000_mcp_write_change_plans');
});

test('P5-31 probe fails closed when the callback verifier is not configured', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({ callbackVerifierConfigured: () => Promise.resolve(false) })),
    /callback verifier not configured|callback verifier/iu,
  );
});

test('P5-31 probe fails closed when the suppression table is missing', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({ suppressionTablePresent: () => Promise.resolve(false) })),
    /suppression table|suppression migration|migration head/iu,
  );
});

test('P5-31 probe fails closed on an empty or malformed migration head', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({
      migrationHead: () => Promise.resolve(''),
    })),
    /migration head/iu,
  );
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({
      migrationHead: () => Promise.resolve('not-a-migration'),
    })),
    /migration head/iu,
  );
});

test('P5-31 probe fails closed when the migration head predates the suppression migration', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({
      migrationHead: () => Promise.resolve('202608011000_other'),
    })),
    /migration head/iu,
  );
});

test('P5-31 probe fails closed when the worker is not composed or not running', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({ workerComposed: () => Promise.resolve({ composed: false, running: false }) })),
    /worker not composed|worker composition/iu,
  );
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({ workerComposed: () => Promise.resolve({ composed: true, running: false }) })),
    /worker not running/iu,
  );
});

test('P5-31 probe fails closed when the adapter is unreachable', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({
      adapterReachable: () => Promise.resolve({ mode: 'fixture', classification: 'permanent' }),
    })),
    /adapter|reachab/iu,
  );
});

test('P5-31 probe fails closed when readiness gauges are absent', async () => {
  await assert.rejects(
    () => runEmailCapabilityProbe(fakeDeps({
      readinessGauges: () => Promise.resolve(['notifications.queue.ready']),
    })),
    /readiness gauge|gauges/iu,
  );
});

test('P5-31 probe records exact low-cardinality metric names without PII labels', async () => {
  const result = await runEmailCapabilityProbe(fakeDeps());
  for (const name of result.metricNames) {
    assert.match(name, /^notifications\.(?:email_delivery|optional_delivery)\./u);
    assert.equal(name.includes('{'), false, `${name} must carry no label cardinality`);
    assert.doesNotMatch(name, /recipient|account|email_address|payload/iu);
  }
  assert.ok(result.metricNames.includes('notifications.email_delivery.suppression_facts'));
  assert.ok(result.metricNames.includes('notifications.email_delivery.probe.status'));
});
