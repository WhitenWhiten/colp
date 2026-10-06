/**
 * Closed vocabularies read from the canonical schema, so a protocol revision
 * that adds a Scope or Principal type cannot drift from hand-copied lists.
 */

import schema from '../schema/generated/v0.1/generated.js';
import type { PrincipalRef, ScopeName } from '../types/index.js';

export const scopeNames: ReadonlySet<ScopeName> = new Set(schema.$defs.scopeName.enum as readonly ScopeName[]);

export const principalTypes: ReadonlySet<PrincipalRef['type']> = new Set(
  schema.$defs.principalRef.properties.type.enum as readonly PrincipalRef['type'][],
);

export function samePrincipal(
  left: Pick<PrincipalRef, 'type' | 'id'>,
  right: Pick<PrincipalRef, 'type' | 'id'>,
): boolean {
  return left.type === right.type && left.id === right.id;
}
