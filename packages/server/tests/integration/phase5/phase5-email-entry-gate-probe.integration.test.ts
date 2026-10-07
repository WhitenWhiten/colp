import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  classifyDirectMailEventBridgeEvent,
  classifyLegacyMnsNotificationMessage,
  suppressionDecision,
} from '../../../src/infrastructure/email/aliyun-directmail-contract.js';
import {
  EMAIL_ENTRY_FIXTURE_TAGS,
  loadEmailEntryReplayManifest,
  startEmailEntryFixture,
  type StartedEmailEntryFixture,
} from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import {
  PROBE_REQUIRED_ENV,
  computeFixtureReplayDigest,
  runControlledFixtureProbe,
  sendSignedRpcRequest,
} from '../../../scripts/evidence/phase5-email-delivery-target-probe.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const probePath = resolve(backendRoot,
  'scripts/evidence/phase5-email-delivery-target-probe.ts');

describe('P5-27 controlled-fixture email delivery entry gate probe', () => {
  let fixture: StartedEmailEntryFixture;
  let manifest: ReturnType<typeof loadEmailEntryReplayManifest>;

  beforeAll(async () => {
    manifest = loadEmailEntryReplayManifest();
    fixture = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  test('fixture serves the documented RPC endpoint shape over https and verifies HMAC-SHA1 signatures', async () => {
    assert.match(fixture.origin, /^https:\/\/127\.0\.0\.1:\d+$/u);
    const signed = await sendSignedRpcRequest({
      origin: fixture.origin,
      fixtureTls: true,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      params: {
        AccessKeyId: manifest.fixedInputs.accessKeyId,
        Action: 'SingleSendMail',
        Format: 'JSON',
        RegionId: 'cn-hangzhou',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: '11111111-2222-3333-4444-555555555555',
        SignatureVersion: '1.0',
        Timestamp: '2026-08-02T00:00:00Z',
        Version: '2015-11-23',
        AccountName: manifest.fixedInputs.sender,
        AddressType: '1',
        ReplyToAddress: 'true',
        Subject: manifest.fixedInputs.subjectMarker,
        ToAddress: manifest.fixedInputs.recipient,
        TextBody: manifest.fixedInputs.textBodyMarker,
        TagName: EMAIL_ENTRY_FIXTURE_TAGS.success,
      },
    });
    assert.equal(signed.httpStatus, 200);
    const body = signed.body as { EnvId?: string; RequestId?: string };
    assert.ok(typeof body.EnvId === 'string' && body.EnvId.length > 0);
    assert.ok(typeof body.RequestId === 'string');

    const tampered = await sendSignedRpcRequest({
      origin: fixture.origin,
      fixtureTls: true,
      accessKeySecret: 'P527-WRONG-SIGNING-KEY',
      params: {
        AccessKeyId: manifest.fixedInputs.accessKeyId,
        Action: 'SingleSendMail',
        Format: 'JSON',
        RegionId: 'cn-hangzhou',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        SignatureVersion: '1.0',
        Timestamp: '2026-08-02T00:00:00Z',
        Version: '2015-11-23',
        AccountName: manifest.fixedInputs.sender,
        AddressType: '1',
        ReplyToAddress: 'true',
        Subject: manifest.fixedInputs.subjectMarker,
        ToAddress: manifest.fixedInputs.recipient,
        TextBody: manifest.fixedInputs.textBodyMarker,
        TagName: EMAIL_ENTRY_FIXTURE_TAGS.success,
      },
    });
    assert.equal(tampered.httpStatus, 403);
    const errorBody = tampered.body as { Code?: string; Message?: string; RequestId?: string };
    assert.equal(errorBody.Code, 'SignatureDoesNotMatch');
    assert.ok(typeof errorBody.Message === 'string');
    assert.ok(typeof errorBody.RequestId === 'string');
  });

  test('fixture returns documented JSON error bodies with correct HTTP statuses', async () => {
    const cases = [
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.throttling, status: 400, code: 'Throttling' },
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.rateLimit429, status: 429, code: 'Throttling' },
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.internalError, status: 500, code: 'InternalError' },
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.serviceUnavailable, status: 503, code: 'ServiceUnavailable' },
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.invalidRecipient, status: 400, code: 'InvalidToAddress' },
      { tag: EMAIL_ENTRY_FIXTURE_TAGS.senderNotFound, status: 404, code: 'InvalidMailAddress.NotFound' },
    ] as const;
    for (const expected of cases) {
      const response = await sendSignedRpcRequest({
        origin: fixture.origin,
        fixtureTls: true,
        accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
        params: {
          AccessKeyId: manifest.fixedInputs.accessKeyId,
          Action: 'SingleSendMail',
          Format: 'JSON',
          RegionId: 'cn-hangzhou',
          SignatureMethod: 'HMAC-SHA1',
          SignatureNonce: `nonce-${expected.tag}`,
          SignatureVersion: '1.0',
          Timestamp: '2026-08-02T00:00:00Z',
          Version: '2015-11-23',
          AccountName: manifest.fixedInputs.sender,
          AddressType: '1',
          ReplyToAddress: 'true',
          Subject: manifest.fixedInputs.subjectMarker,
          ToAddress: manifest.fixedInputs.recipient,
          TextBody: manifest.fixedInputs.textBodyMarker,
          TagName: expected.tag,
        },
      });
      assert.equal(response.httpStatus, expected.status, expected.tag);
      const body = response.body as { Code?: string; Message?: string; RequestId?: string };
      assert.equal(body.Code, expected.code, expected.tag);
      assert.ok(typeof body.Message === 'string', expected.tag);
      assert.ok(typeof body.RequestId === 'string', expected.tag);
    }
  });

  test('probe covers send, duplicate key, timeout, 429/5xx, callbacks and provider unavailable deterministically', async () => {
    const evidence = await runControlledFixtureProbe({ fixture });
    assert.equal(evidence.evidence, 'email_delivery_controlled_fixture_probe');
    assert.equal(evidence.redactionVerified, true);
    assert.equal(evidence.replayDigest, manifest.recordedOutcomes.digest);

    const byId = new Map(evidence.scenarios.map((scenario) => [scenario.id, scenario]));
    assert.equal(byId.get('success')?.classification, 'success');
    assert.equal(byId.get('success')?.httpStatus, 200);
    assert.equal(byId.get('duplicate')?.duplicate, true);
    assert.equal(fixture.sentTagCounts.get(EMAIL_ENTRY_FIXTURE_TAGS.duplicate), 1,
      'duplicate TagName must hit the fixture exactly once');
    assert.deepEqual(byId.get('throttling'), {
      id: 'throttling', httpStatus: 400, code: 'Throttling',
      classification: 'retryable', lastErrorCategory: 'dependency',
    });
    assert.deepEqual(byId.get('rateLimit429'), {
      id: 'rateLimit429', httpStatus: 429, code: 'Throttling',
      classification: 'retryable', lastErrorCategory: 'dependency',
    });
    assert.deepEqual(byId.get('internalError'), {
      id: 'internalError', httpStatus: 500, code: 'InternalError',
      classification: 'retryable', lastErrorCategory: 'provider_unavailable',
    });
    assert.deepEqual(byId.get('serviceUnavailable'), {
      id: 'serviceUnavailable', httpStatus: 503, code: 'ServiceUnavailable',
      classification: 'retryable', lastErrorCategory: 'provider_unavailable',
    });
    assert.deepEqual(byId.get('invalidRecipient'), {
      id: 'invalidRecipient', httpStatus: 400, code: 'InvalidToAddress',
      classification: 'permanent', lastErrorCategory: 'invalid_contract',
    });
    assert.deepEqual(byId.get('senderNotFound'), {
      id: 'senderNotFound', httpStatus: 404, code: 'InvalidMailAddress.NotFound',
      classification: 'permanent', lastErrorCategory: 'invalid_contract',
    });
    assert.deepEqual(byId.get('badSignature'), {
      id: 'badSignature', httpStatus: 403, code: 'SignatureDoesNotMatch',
      classification: 'permanent', lastErrorCategory: 'invalid_contract',
    });
    assert.deepEqual(byId.get('timeout'), {
      id: 'timeout', classification: 'retryable', lastErrorCategory: 'provider_unavailable',
    });
    assert.deepEqual(byId.get('providerUnavailable'), {
      id: 'providerUnavailable', classification: 'retryable',
      lastErrorCategory: 'provider_unavailable',
    });
    assert.deepEqual(byId.get('reconciliation'), {
      id: 'reconciliation', httpStatus: 200, classification: 'success',
      lastErrorCategory: null, outcome: 'delivered',
    });

    const callbackById = new Map(evidence.callbacks.map((callback) => [callback.id, callback]));
    assert.equal(callbackById.get('callback-deliver-success')?.outcome, 'delivered');
    assert.equal(callbackById.get('callback-deliver-bounce')?.outcome, 'bounced');
    assert.equal(callbackById.get('callback-deliver-bounce')?.suppression, 'suppress_recipient');
    assert.equal(callbackById.get('callback-fbl-report')?.outcome, 'complaint');
    assert.equal(callbackById.get('callback-fbl-report')?.suppression, 'suppress_recipient');
    assert.equal(callbackById.get('callback-unsubscribe')?.outcome, 'unsubscribed');
    assert.equal(callbackById.get('callback-unsubscribe')?.suppression, 'suppress_recipient');
    assert.equal(callbackById.get('callback-subscribe')?.outcome, 'subscribed');
    assert.equal(callbackById.get('callback-mns-legacy-deliver-fail')?.outcome, 'bounced');
    assert.equal(callbackById.get('callback-mns-legacy-deliver-fail')?.source, 'mns-legacy');
  }, 30000);

  test('fixture callback event shapes parse to the documented delivery facts', async () => {
    const bounceEvent = JSON.parse((await fixture.readText('/__fixture/events/deliver-bounce')).bodyText) as
      Record<string, unknown>;
    const fact = classifyDirectMailEventBridgeEvent(bounceEvent);
    assert.equal(fact.outcome, 'bounced');
    assert.equal(suppressionDecision(fact.outcome), 'suppress_recipient');

    const complaintEvent = JSON.parse((await fixture.readText('/__fixture/events/fbl-report')).bodyText) as
      Record<string, unknown>;
    assert.equal(classifyDirectMailEventBridgeEvent(complaintEvent).outcome, 'complaint');

    const unsubscribeEvent = JSON.parse((await fixture.readText('/__fixture/events/unsubscribe')).bodyText) as
      Record<string, unknown>;
    assert.equal(classifyDirectMailEventBridgeEvent(unsubscribeEvent).outcome, 'unsubscribed');

    const legacy = (await fixture.readText('/__fixture/events/mns-legacy-deliver-fail')).bodyText;
    assert.equal(classifyLegacyMnsNotificationMessage(legacy).outcome, 'bounced');
  });

  test('probe evidence and fixture records never leak credentials, recipients or content markers', async () => {
    const markerSecret = `P527_TEST_ACCESS_KEY_SECRET_${'x'.repeat(24)}`;
    const markerRecipient = 'p527-redaction-probe@example.invalid';
    const markerSubject = 'P527-REDACTION-SUBJECT';
    const markerBody = 'P527-REDACTION-BODY';
    const isolated = await startEmailEntryFixture({
      accessKeyId: 'P527REDACTFIXTUREAK',
      signingKeyMaterial: markerSecret,
      sender: 'known-redaction@example.invalid',
      recipient: markerRecipient,
    });
    try {
      const overrideManifest = {
        ...manifest,
        fixedInputs: {
          ...manifest.fixedInputs,
          accessKeyId: 'P527REDACTFIXTUREAK',
          signingKeyMaterial: markerSecret,
          sender: 'known-redaction@example.invalid',
          recipient: markerRecipient,
          subjectMarker: markerSubject,
          textBodyMarker: markerBody,
          htmlBodyMarker: markerBody,
        },
      };
      const evidence = await runControlledFixtureProbe({ fixture: isolated, manifest: overrideManifest });
      const serialized = JSON.stringify(evidence);
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(markerSecret), 'u'));
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(markerRecipient), 'u'));
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(markerSubject), 'u'));
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(markerBody), 'u'));
      assert.doesNotMatch(serialized, /P527REDACTFIXTUREAK/u);
      const records = JSON.stringify(isolated.requestRecords);
      assert.doesNotMatch(records, new RegExp(escapeRegExp(markerSecret), 'u'));
      assert.doesNotMatch(records, new RegExp(escapeRegExp(markerRecipient), 'u'));
      assert.doesNotMatch(records, new RegExp(escapeRegExp(markerSubject), 'u'));
      assert.doesNotMatch(records, new RegExp(escapeRegExp(markerBody), 'u'));
      assert.equal(evidence.redactionVerified, true);
    } finally {
      await isolated.close();
    }
  }, 30000);

  test('controlled fixture probe is replayable: identical digest and outcomes across runs', async () => {
    const first = await runControlledFixtureProbe({ fixture });
    const second = await runControlledFixtureProbe({ fixture });
    assert.equal(first.replayDigest, second.replayDigest);
    assert.deepEqual(first.scenarios, second.scenarios);
    assert.deepEqual(first.callbacks, second.callbacks);
    assert.equal(computeFixtureReplayDigest(second), second.replayDigest);
  }, 30000);
});

describe('P5-27 executable probe CLI', () => {
  test('fixture mode exits zero and writes redaction-safe evidence', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'known-p527-probe-'));
    try {
      const outPath = join(evidenceRoot, 'fixture-evidence.json');
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', probePath, '--mode', 'fixture', '--out', outPath],
        { cwd: backendRoot, encoding: 'utf8', timeout: 60_000, windowsHide: true });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, output);
      assert.match(output, /email_delivery_controlled_fixture_probe/u);
      const written = readFileSync(outPath, 'utf8');
      const evidence = JSON.parse(written) as { replayDigest?: string; redactionVerified?: boolean };
      assert.equal(typeof evidence.replayDigest, 'string');
      assert.equal(evidence.redactionVerified, true);
      for (const marker of [
        'P527-FIXTURE-SIGNING-KEY',
        'P527FIXTUREAKID',
        'p527-recipient@example.invalid',
        'P527-SUBJECT-MARKER',
        'P527-TEXT-BODY-MARKER',
        'P527-HTML-BODY-MARKER',
      ]) {
        assert.doesNotMatch(written, new RegExp(escapeRegExp(marker), 'u'), marker);
      }
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }, 90000);

  test('target mode fails closed without provider credentials', () => {
    const environment = { ...process.env };
    for (const name of PROBE_REQUIRED_ENV) delete environment[name];
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', probePath, '--mode', 'target'],
      { cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    for (const name of PROBE_REQUIRED_ENV) {
      assert.match(output, new RegExp(escapeRegExp(name), 'u'), `must name missing env ${name}`);
    }
    assert.doesNotMatch(output, /"accepted"\s*:\s*true/u);
  }, 90000);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

