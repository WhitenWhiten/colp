/**
 * Builds minimal legal `nodes.create` arguments from a published tools/list schema.
 */
export type Phase4bMcpNodeCreateKind = 'folder' | 'bookmark';
export type Phase4bMcpNodeCreateMode = 'preview' | 'apply';

export interface Phase4bMcpNodeCreateListedSchema {
  readonly required?: readonly string[];
  readonly oneOf?: readonly Readonly<Record<string, unknown>>[];
  readonly properties?: {
    readonly node?: {
      readonly oneOf?: readonly Phase4bMcpNodeCreateListedBranch[];
    };
  };
}

export interface Phase4bMcpNodeCreateListedBranch {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export function listedNodesCreateInputSchema(
  tools: readonly Readonly<Record<string, unknown>>[],
): Phase4bMcpNodeCreateListedSchema {
  const tool = tools.find((entry) => entry.name === 'nodes.create');
  if (tool === undefined) {
    throw new TypeError('tools/list did not publish nodes.create.');
  }
  const schema = tool.inputSchema;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new TypeError('nodes.create inputSchema must be an object.');
  }
  return schema as Phase4bMcpNodeCreateListedSchema;
}

export function listedNodeCreateBranch(
  schema: Phase4bMcpNodeCreateListedSchema,
  kind: Phase4bMcpNodeCreateKind,
): Phase4bMcpNodeCreateListedBranch {
  const branch = schema.properties?.node?.oneOf?.find((entry) => listedBranchKind(entry) === kind);
  if (branch === undefined) {
    throw new TypeError(`nodes.create schema is missing the ${kind} branch.`);
  }
  return branch;
}

function listedBranchKind(branch: Phase4bMcpNodeCreateListedBranch): string | undefined {
  const kind = branch.properties?.kind;
  if (kind === undefined) return undefined;
  if (Object.hasOwn(kind, 'const')) return String(kind.const);
  const enumerated = kind.enum;
  if (Array.isArray(enumerated) && enumerated.length === 1) return String(enumerated[0]);
  return undefined;
}

export function minimalNodeFromListedSchema(
  schema: Phase4bMcpNodeCreateListedSchema,
  kind: Phase4bMcpNodeCreateKind,
): Readonly<Record<string, unknown>> {
  const branch = listedNodeCreateBranch(schema, kind);
  const node: Record<string, unknown> = {};
  for (const key of branch.required ?? []) {
    node[key] = minimalNodeProperty(key, branch.properties?.[key] ?? {});
  }
  return Object.freeze(node);
}

export function minimalNodesCreateArgumentsFromListedSchema(
  schema: Phase4bMcpNodeCreateListedSchema,
  kind: Phase4bMcpNodeCreateKind,
  mode: Phase4bMcpNodeCreateMode,
): Readonly<Record<string, unknown>> {
  const args: Record<string, unknown> = {
    collectionId: 'collection-1',
    parentId: 'root-1',
    afterId: null,
    beforeId: null,
    node: minimalNodeFromListedSchema(schema, kind),
    reason: 'create',
  };
  if (mode === 'preview') {
    args.dryRun = true;
    args.confirmApply = false;
  } else {
    args.confirmApply = true;
  }
  return Object.freeze(args);
}

/** Replace placeholder collection/parent ids from the listed-schema builder. */
export function bindListedNodesCreateArguments(
  args: Readonly<Record<string, unknown>>,
  collectionId: string,
  parentId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...args, collectionId, parentId });
}

function minimalNodeProperty(
  key: string,
  schema: Readonly<Record<string, unknown>>,
): unknown {
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'array') return Object.freeze([]);
  if (Array.isArray(schema.oneOf)) {
    const allowsNull = schema.oneOf.some(
      (entry) => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === 'null',
    );
    if (allowsNull) return null;
  }
  if (key === 'url') return 'https://example.test/n';
  if (key === 'title') return 'n';
  if (schema.type === 'string') {
    const minLength = typeof schema.minLength === 'number' ? schema.minLength : 1;
    return 'n'.repeat(Math.max(1, minLength));
  }
  throw new TypeError(`Cannot construct a minimal nodes.create node.${key} value.`);
}
