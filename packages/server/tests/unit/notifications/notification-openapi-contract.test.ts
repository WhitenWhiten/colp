import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import YAML from 'yaml';

interface Parameter { readonly name?: string; readonly $ref?: string }
interface Operation { readonly parameters: readonly Parameter[]; readonly responses: Record<string, unknown> }
interface Contract {
  readonly info: { readonly version: string };
  readonly paths: Record<string, Record<string, Operation>>;
  readonly components: { readonly parameters: Record<string, { readonly name: string }>;
    readonly schemas: Record<string, { readonly additionalProperties?: boolean;
      readonly required?: readonly string[];
      readonly properties?: Record<string, { readonly enum?: readonly string[]; readonly $ref?: string;
        readonly properties?: Record<string, { readonly $ref?: string }>;
        readonly oneOf?: ReadonlyArray<{ readonly $ref?: string; readonly type?: string }> }> }> };
}
const source = YAML.parse(readFileSync('openapi/product-v1.yaml', 'utf8')) as Contract;
const parameterNames = (operation: Operation) => operation.parameters.map((parameter) => {
  if (parameter.name !== undefined) return parameter.name;
  const name = parameter.$ref?.split('/').at(-1);
  return name === undefined ? undefined : source.components.parameters[name]?.name;
});

test('Notification Product contract exposes list, mark-read, and preference operations', () => {
  assert.ok(source.paths['/api/v1/notifications']?.get);
  assert.ok(source.paths['/api/v1/notifications/{notificationId}/read']?.put);
  assert.ok(source.paths['/api/v1/notifications/read']?.post);
  assert.ok(source.paths['/api/v1/notification-preferences']?.get);
  assert.ok(source.paths['/api/v1/notification-preferences/{channel}']?.put);
  // FIX-H-004: the frozen Phase 5 compatibility paths are documented additively
  // with explicit route-manifest inclusion markers.
  assert.ok(source.paths['/api/v1/me/notifications']?.get);
  assert.ok(source.paths['/api/v1/me/notifications/read']?.post);
  assert.ok(source.paths['/api/v1/me/notification-preferences']?.get);
  assert.ok(source.paths['/api/v1/me/notification-preferences']?.put);
  for (const operation of [source.paths['/api/v1/me/notifications'].get,
    source.paths['/api/v1/me/notifications/read'].post,
    source.paths['/api/v1/me/notification-preferences'].get,
    source.paths['/api/v1/me/notification-preferences'].put]) {
    assert.equal((operation as Operation & { 'x-known-route-manifest'?: boolean })['x-known-route-manifest'], true);
  }
  assert.deepEqual(source.components.schemas.NotificationPreference?.properties?.channel?.enum,
    ['in_app', 'email']);
  assert.ok(source.components.schemas.NotificationPreference?.properties?.email);
  const emailStatus = source.components.schemas.NotificationPreferenceEmailStatus?.properties ?? {};
  for (const name of ['enabled', 'revision', 'updatedAt', 'verifiedSender', 'emailSuppressed',
    'emailAvailable']) {
    assert.ok(emailStatus[name], `NotificationPreferenceEmailStatus.${name}`);
  }
  assert.equal(source.components.schemas.NotificationInboxPage.additionalProperties, false);
  assert.equal(source.components.schemas.NotificationItem.additionalProperties, false);
  const notificationItem = source.components.schemas.NotificationItem;
  const required = notificationItem.required ?? [];
  for (const name of ['actorHandle', 'actorDisplayName', 'collectionTitle', 'publicationSlug', 'summary']) {
    assert.ok(notificationItem.properties?.[name], `NotificationItem.${name}`);
    assert.equal(required.includes(name), false, `${name} must stay off required[]`);
  }
  assert.equal(notificationItem.properties?.subject?.properties?.id?.$ref,
    '#/components/schemas/OpaqueId');
  const frozen = source.components.schemas.NotificationDto;
  assert.equal(frozen.properties?.kind?.enum?.slice().sort().join('|'),
    'followed_collection_changed|new_follower');
  for (const name of ['actorHandle', 'actorDisplayName', 'collectionTitle', 'publicationSlug', 'summary']) {
    assert.equal(Object.hasOwn(frozen.properties ?? {}, name), false, `frozen NotificationDto.${name}`);
  }
  for (const operation of [source.paths['/api/v1/notifications'].get,
    source.paths['/api/v1/notifications/{notificationId}/read'].put,
    source.paths['/api/v1/notifications/read'].post,
    source.paths['/api/v1/notification-preferences'].get,
    source.paths['/api/v1/notification-preferences/{channel}'].put]) {
    assert.ok(operation.responses['500']);
    assert.ok(operation.responses['503']);
  }
});

test('Notification mutations declare command, CSRF, Origin, and strong preconditions', () => {
  const one = source.paths['/api/v1/notifications/{notificationId}/read'].put;
  const bulk = source.paths['/api/v1/notifications/read'].post;
  const preference = source.paths['/api/v1/notification-preferences/{channel}'].put;
  for (const operation of [one, bulk, preference]) {
    const names = parameterNames(operation);
    assert.ok(names.includes('Known-Command-Id'));
    assert.ok(names.includes('Origin'));
    assert.ok(names.includes('X-CSRF-Token'));
    assert.ok(operation.responses['429']);
    assert.ok(operation.responses['503']);
  }
  assert.ok(parameterNames(one).includes('If-Match'));
  assert.ok(parameterNames(preference).includes('If-Match'));
  assert.ok(preference.responses['428']);
  assert.ok(preference.responses['412']);
});

test('generated Notification client and route manifest are source-derived', () => {
  const client = readFileSync('generated/openapi/product-v1.client.ts', 'utf8');
  const routes = JSON.parse(readFileSync('generated/openapi/product-v1.routes.json', 'utf8')) as
    Array<{ readonly operationId: string }>;
  assert.match(client, /createProductNotificationClient/u);
  assert.match(client, /NotificationInboxPage/u);
  assert.match(client, /channel: 'in_app'\|'email'/u);
  for (const operationId of ['listNotifications', 'markNotificationRead', 'markNotificationsRead',
    'getNotificationPreferences', 'updateNotificationPreference', 'listMyNotifications',
    'markMyNotificationsRead', 'getMyNotificationPreferences', 'updateMyNotificationPreferences']) {
    assert.ok(routes.some((route) => route.operationId === operationId), operationId);
  }
});
