import { boundedString } from './codec.js';
import { requestValue } from './idb.js';
import { STORES } from './schema.js';

/** Count one bootstrap item once even if its run resumes or is re-matched. */
export async function claimIngressDiagnosticSource(tx: IDBTransaction, key: string, code: string,
  sourceId: string | undefined): Promise<boolean> {
  if (sourceId === undefined) return true;
  const id = `ingress-source:${key}:${boundedString(sourceId, 'sourceId')}:${code}`;
  const store = tx.objectStore(STORES.diagnostics);
  if (await requestValue(store.get(id))) return false;
  store.put({ id, scopeKey: key, kind: 'ingress_source', code });
  return true;
}
