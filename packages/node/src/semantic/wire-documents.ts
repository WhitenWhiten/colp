import { isProxy } from 'node:util/types';

import {
  createValidatorRegistry,
  validateWireDocument,
  validateWireJsonDocument,
  type DefinitionName,
  type IJsonParseLimits,
  type ValidatorRegistry,
  type WireDocumentValidationResult,
  type WireJsonDocumentValidationResult,
} from '../schema/index.js';
import type {
  ColpContract,
  ColpContractName,
  CreateNodeOperationPayload,
  Manifest,
  Node,
  NodeCreate,
  NodeDetail,
  Problem,
  Snapshot,
} from '../types/index.js';
import {
  validateNodeCreateRequestUrlHashSemantics,
  validateNodeCreateUrlHashSemantics,
  validateNodeUrlHashSemantics,
} from './bookmark-url-hash.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';
import { validateManifestSemantics } from './manifest.js';
import {
  validatePublicationProblemSemantics,
  type PublicationProblemSemanticContext,
} from './publication-problems.js';
import { validateSnapshotSemantics, type SnapshotSemanticContext } from './snapshot.js';

/** The value of a valid document: its generated contract type, or `unknown` when none exists. */
export type ColpDocument<Definition extends DefinitionName> =
  Definition extends ColpContractName ? ColpContract<Definition> : unknown;

export interface ColpDocumentValidationOptions<Definition extends DefinitionName = DefinitionName> {
  /** Defaults to a registry of the package's own schemas, created once and shared. */
  readonly validators?: ValidatorRegistry;
  /**
   * Merged over the Snapshot defaults: consumer extension mode, plus deferred
   * reference resolution when the Snapshot is not complete (a cropped Snapshot
   * or one page of several), because its references may point at Nodes that
   * are not in this document.
   */
  readonly snapshot?: SnapshotSemanticContext;
  /**
   * Merged over the Problem defaults, which take `httpStatus` from the Problem
   * itself and assume `application/problem+json`. Pass the real response
   * status and Content-Type to check those too.
   */
  readonly problem?: Partial<PublicationProblemSemanticContext>;
  /**
   * Replaces the built-in semantic checks for this definition. Use it for
   * documents whose checks need state this function cannot see, such as a
   * merge patch together with the current Node.
   */
  readonly validateSemantics?: (value: ColpDocument<Definition>) => SemanticValidationResult;
}

export interface ColpJsonDocumentValidationOptions<Definition extends DefinitionName = DefinitionName>
  extends ColpDocumentValidationOptions<Definition> {
  /** I-JSON depth, member, and byte limits for parsing the source text. */
  readonly limits?: IJsonParseLimits;
}

type BuiltInSemanticCheck = (value: never, options: ColpDocumentValidationOptions) => SemanticValidationResult;

const accepted: SemanticValidationResult = Object.freeze({ valid: true, issues: [] as const });

const builtInSemanticChecks: Readonly<Partial<Record<DefinitionName, BuiltInSemanticCheck>>> = Object.freeze({
  manifest: (manifest: Manifest) => validateManifestSemantics(manifest),
  snapshot: (snapshot: Snapshot, options) =>
    validateSnapshotSemantics(snapshot, { ...defaultSnapshotContext(snapshot), ...options.snapshot }),
  problem: (problem: Problem, options) => validatePublicationProblemSemantics(problem, {
    httpStatus: problem.status,
    contentType: 'application/problem+json',
    ...options.problem,
  }),
  node: (node: Node) => validateNodeUrlHashSemantics(node),
  nodeDetail: (detail: NodeDetail) => validateNodeUrlHashSemantics(detail.node, '/node/urlHash'),
  nodeCreate: (create: NodeCreate) => validateNodeCreateUrlHashSemantics(create),
  nodeCreateRequest: (request: CreateNodeOperationPayload) => validateNodeCreateRequestUrlHashSemantics(request),
  createNodeOperationPayload: (payload: CreateNodeOperationPayload) =>
    validateNodeCreateRequestUrlHashSemantics(payload),
});

let sharedValidators: ValidatorRegistry | undefined;

const documentOptionKeys: ReadonlySet<string> = new Set(['validators', 'snapshot', 'problem', 'validateSemantics']);
const jsonDocumentOptionKeys: ReadonlySet<string> = new Set([...documentOptionKeys, 'limits']);

/**
 * Validates one parsed wire document in a single call: first against its JSON
 * Schema definition, then against the protocol rules a schema cannot express.
 *
 * The rules applied depend on `definition`: Manifest profiles and endpoints,
 * the Snapshot graph, Problem registry entries, and Bookmark URL hashes on
 * Nodes and Node creates. Other definitions get the schema check only, unless
 * `options.validateSemantics` supplies the checks that need outside state.
 */
export function validateColpDocument<Definition extends DefinitionName>(
  definition: Definition,
  value: unknown,
  options: ColpDocumentValidationOptions<Definition> = {},
): WireDocumentValidationResult<ColpDocument<Definition>, SemanticIssue> {
  assertOptions(options, documentOptionKeys);
  return validateWireDocument(
    options.validators ?? defaultValidators(),
    definition,
    value,
    semanticCheckFor(definition, options),
  );
}

/**
 * Parses I-JSON source text, then validates it like `validateColpDocument`.
 * A failure reports the stage that rejected it: `parse`, `structural`, or `semantic`.
 */
export function validateColpJsonDocument<Definition extends DefinitionName>(
  definition: Definition,
  source: string,
  options: ColpJsonDocumentValidationOptions<Definition> = {},
): WireJsonDocumentValidationResult<ColpDocument<Definition>, SemanticIssue> {
  assertOptions(options, jsonDocumentOptionKeys);
  return validateWireJsonDocument(
    options.validators ?? defaultValidators(),
    definition,
    source,
    semanticCheckFor(definition, options),
    options.limits,
  );
}

function semanticCheckFor<Definition extends DefinitionName>(
  definition: Definition,
  options: ColpDocumentValidationOptions<Definition>,
): (value: ColpDocument<Definition>) => SemanticValidationResult {
  if (options.validateSemantics !== undefined) return options.validateSemantics;
  const check = Object.hasOwn(builtInSemanticChecks, definition) ? builtInSemanticChecks[definition] : undefined;
  if (check === undefined) return () => accepted;
  return (value) => check(value as never, options as ColpDocumentValidationOptions);
}

/** Rejects option objects a typo could silently weaken: Proxies, accessors, and unknown fields. */
function assertOptions(options: object, allowed: ReadonlySet<string>): void {
  if (typeof options !== 'object' || options === null || Array.isArray(options) || isProxy(options)) {
    throw new TypeError('COLP document validation options must be a plain object.');
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`Unknown COLP document validation option: ${String(key)}.`);
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`COLP document validation option ${key} must be a data property.`);
    }
  }
}

function defaultSnapshotContext(snapshot: Snapshot): SnapshotSemanticContext {
  const complete = snapshot.complete && snapshot.page.sequence === 1 && !snapshot.page.hasMore;
  return complete
    ? { publicationExtensionMode: 'consumer' }
    : { publicationExtensionMode: 'consumer', referenceResolution: { mode: 'deferred' } };
}

function defaultValidators(): ValidatorRegistry {
  sharedValidators ??= createValidatorRegistry();
  return sharedValidators;
}
