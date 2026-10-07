/**
 * True when the node payload's `namespace` extension holds `{ "<field>": true }`.
 * `alias` is a trusted table alias; namespace and field are code constants.
 */
export function nodeExtensionFlagSql(alias: string, namespace: string, field: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error('nodeExtensionFlagSql alias must be a plain identifier');
  if (!/^[A-Za-z0-9:/._-]+$/u.test(namespace) || !/^[A-Za-z0-9_]+$/u.test(field)) {
    throw new Error('nodeExtensionFlagSql namespace and field must be plain constants');
  }
  return `coalesce((${alias}.payload_json->'extensions'->'${namespace}'->>'${field}') = 'true', false)`;
}
