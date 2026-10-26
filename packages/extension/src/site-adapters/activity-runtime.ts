import type { ActivitySink } from './activity.js';
import type { SourceDatabase } from './source-db.js';
import { readSourceConnection } from './content-identity.js';

const sinks = new Map<string, ActivitySink>();
export function installSiteActivity(definition: { siteKey: string; identityVersion: number }, sink: ActivitySink) {
  sinks.set(JSON.stringify([definition.siteKey, definition.identityVersion]), sink);
}
export async function activityForSource(db: SourceDatabase, connectionId: string) {
  if (!sinks.size) return undefined;
  const connection = await readSourceConnection(db, connectionId);
  return sinks.get(JSON.stringify([connection.siteKey, connection.identityVersion]));
}
