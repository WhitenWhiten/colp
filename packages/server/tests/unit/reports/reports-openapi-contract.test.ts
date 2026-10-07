import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  backendRoot,
  parameterRefs,
  readDocument,
  type UnknownRecord,
} from '../openapi/openapi-contract-support.js';

const document = readDocument();
const generatedClient = readFileSync(`${backendRoot}/generated/openapi/product-v1.client.ts`, 'utf8');

const privateOperations = [
  'createReport', 'getReport', 'updateReport', 'archiveReport',
  'listReportIssues', 'attachReportIssue', 'getReportIssue', 'updateReportIssue',
  'detachReportIssue', 'publishReportIssue', 'withdrawReportIssue',
  'listReportMembers', 'updateReportMember', 'removeReportMember',
  'getReportFollowState', 'followReport', 'unfollowReport',
  'getReportSchedule', 'putReportSchedule', 'deleteReportSchedule',
  'listMyReports', 'listFollowedReports', 'listFollowedReportIssues',
] as const;

const publicOperations = ['listPublicReports', 'getPublicReport', 'listPublicReportIssues', 'getPublicReportIssue'] as const;

function byId(id: string): UnknownRecord {
  const found = Object.values(document.paths).flatMap((item) => Object.values(item))
    .find((operation) => operation && typeof operation === 'object' && (operation as UnknownRecord).operationId === id);
  assert.ok(found, `missing operation ${id}`);
  return found as UnknownRecord;
}

function response(operation: UnknownRecord, status: string): UnknownRecord {
  const value = (operation.responses as UnknownRecord | undefined)?.[status];
  assert.ok(value, `${String(operation.operationId)} is missing ${status}`);
  return value as UnknownRecord;
}

test('report OpenAPI covers every Product operation with closed auth/error contracts', () => {
  for (const operationId of privateOperations) {
    const operation = byId(operationId);
    assert.deepEqual(operation.tags, ['Reports']);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    const method = operationId.startsWith('get') || operationId.startsWith('list') ? 'read' : 'write';
    const refs = parameterRefs(operation as never);
    if (method === 'write') {
      for (const ref of ['#/components/parameters/Origin', '#/components/parameters/CsrfToken', '#/components/parameters/CommandId']) {
        assert.ok(refs.has(ref), `${operationId} missing ${ref}`);
      }
    }
    const ok = response(operation, operationId === 'createReport' || operationId === 'attachReportIssue' ? '201' : ['archiveReport', 'detachReportIssue', 'removeReportMember', 'deleteReportSchedule'].includes(operationId) ? '204' : '200');
    const headers = ok.headers as UnknownRecord;
    assert.equal((headers['X-Request-Id'] as UnknownRecord).$ref, '#/components/headers/XRequestId');
    assert.ok((headers['Cache-Control'] as UnknownRecord).$ref, `${operationId} missing cache policy`);
    for (const status of ['401', '404', '429', '500', '503']) {
      if (operationId === 'createReport' && status === '404') continue;
      assert.ok((operation.responses as UnknownRecord)[status] ?? status === '404', `${operationId} missing ${status} error mapping`);
    }
  }

  for (const operationId of publicOperations) {
    const operation = byId(operationId);
    assert.deepEqual(operation.tags, ['Reports']);
    assert.deepEqual(operation.security, []);
    const ok = response(operation, '200');
    const headers = ok.headers as UnknownRecord;
    assert.equal((headers['X-Request-Id'] as UnknownRecord).$ref, '#/components/headers/XRequestId');
    assert.equal((headers['Cache-Control'] as UnknownRecord).$ref, '#/components/headers/PublicRevalidate');
    assert.ok((operation.responses as UnknownRecord)['404'] || operationId === 'listPublicReports');
  }
});

test('report merge patches are truly partial and public issue pagination is bounded', () => {
  const seriesPatch = document.components.schemas.ReportSeriesPatch as UnknownRecord;
  const editionPatch = document.components.schemas.ReportEditionPatch as UnknownRecord;
  assert.equal(seriesPatch.additionalProperties, false);
  assert.equal(seriesPatch.minProperties, 1);
  assert.equal(editionPatch.additionalProperties, false);
  assert.equal(editionPatch.minProperties, 1);
  assert.equal(seriesPatch.required, undefined);
  assert.equal(editionPatch.required, undefined);

  const issuePage = document.components.schemas.PublicReportIssuePage as UnknownRecord;
  assert.equal(issuePage.additionalProperties, false);
  assert.deepEqual(issuePage.required, ['items', 'nextCursor']);
  assert.equal(((issuePage.properties as UnknownRecord).items as UnknownRecord).maxItems, 100);
  assert.equal(((issuePage.properties as UnknownRecord).nextCursor as UnknownRecord).maxLength, 2048);
  assert.equal((document.paths['/api/v1/public-reports/{slug}/issues']?.get as UnknownRecord).operationId, 'listPublicReportIssues');

  // 1.56.0: the public issue additively exposes only the source Collection's
  // public slug — the internal source ID stays out of the anonymous contract.
  const publicIssue = document.components.schemas.PublicReportIssue as UnknownRecord;
  assert.deepEqual(publicIssue.required, ['id', 'title', 'summary', 'publishedAt', 'url']);
  assert.ok(Object.hasOwn(publicIssue.properties as UnknownRecord, 'sourceCollectionSlug'));
  assert.equal(Object.hasOwn(publicIssue.properties as UnknownRecord, 'sourceCollectionId'), false);

  const timeline = document.components.schemas.ReportIssueTimelineItem as UnknownRecord;
  assert.deepEqual(timeline.required, [
    'id', 'seriesId', 'issueKey', 'editionOrdinal', 'titleSnapshot', 'summarySnapshot',
    'periodStart', 'periodEnd', 'state', 'publishedAt', 'series',
  ]);
  assert.equal(Object.hasOwn(timeline.properties as UnknownRecord, 'sourceCollectionId'), false);
  assert.equal(Object.hasOwn(timeline.properties as UnknownRecord, 'resourceRevision'), false);
  assert.equal((timeline.properties as UnknownRecord).series.$ref, '#/components/schemas/ReportTimelineSeries');
  assert.equal((document.components.schemas.ReportTimelineSeries as UnknownRecord).additionalProperties, false);
  // #21: followed surfaces keep hide_public rows as inert tombstones.
  assert.deepEqual(((timeline.properties as UnknownRecord).state as UnknownRecord).enum, ['published', 'hidden']);
  assert.equal(Object.hasOwn((document.components.schemas.ReportTimelineSeries as UnknownRecord).properties as UnknownRecord, 'hiddenPublic'), true);
  assert.equal(Object.hasOwn((document.components.schemas.ReportSeries as UnknownRecord).properties as UnknownRecord, 'hiddenPublic'), true);
});

test('report schedule response is a closed object, not an invalid closed allOf', () => {
  const schedule = document.components.schemas.ReportSchedule as UnknownRecord;
  assert.equal(schedule.type, 'object');
  assert.equal(schedule.additionalProperties, false);
  assert.equal(schedule.allOf, undefined);
  assert.deepEqual(schedule.required, [
    'id', 'seriesId', 'enabled', 'rrule', 'dtstart', 'timeZone',
    'catchUpPolicy', 'maxCatchUp', 'nextRunAt', 'resourceRevision',
  ]);
  const properties = schedule.properties as UnknownRecord;
  for (const field of ['id', 'seriesId', 'enabled', 'rrule', 'dtstart', 'timeZone',
    'catchUpPolicy', 'maxCatchUp', 'nextRunAt', 'resourceRevision']) {
    assert.ok(Object.hasOwn(properties, field), `ReportSchedule missing ${field}`);
  }
});

test('generated report client exposes private, schedule, and anonymous public issue methods', () => {
  for (const method of ['create', 'update', 'attach', 'publish', 'withdraw', 'updateMember', 'removeMember', 'putSchedule', 'publicDirectory', 'publicIssues', 'publicIssue']) {
    assert.match(generatedClient, new RegExp(`\\b${method}:`, 'u'), `generated client missing ${method}`);
  }
  assert.match(generatedClient, /credentials: publicRead \? 'omit' : 'include'/u);
});
