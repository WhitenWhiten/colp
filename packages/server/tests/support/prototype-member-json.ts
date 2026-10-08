/** Preserve wire spellings that object literals or JSON.stringify could erase. */
export function prototypeMemberJsonBodies(validBody: string): readonly string[] {
  return [
    '"__proto__":null',
    '"__proto__":123',
    '"\\u005f_proto__":null',
    '"\\u005f_proto__":123',
    '"nested":{"__proto__":null}',
  ].map((member) => '{' + member + ',' + validBody.slice(1));
}
