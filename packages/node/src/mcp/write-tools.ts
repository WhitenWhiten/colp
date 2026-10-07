/**
 * MCP write Tool gateway: changes.plan / changes.commit / changes.cancel,
 * high-risk one-shot rejection, and API key secret redaction on key tools.
 */

import {
  createChangePlanService,
  MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH,
  type McpChangePlanService,
  type McpChangePlanServiceOptions,
  type McpChangePlanCommitTransaction,
} from './change-plan.js';
import {
  assertOneShotCanonicalOperationsAllowed,
  assessToolCallRisk,
  McpHighRiskRequiresPlanError,
  type ToolRiskAssessment,
  type CanonicalRiskOperation,
} from './risk-aggregation.js';
import {
  redactApiKeyToolResult,
  redactCommitStructuredContent,
  McpSecretRedactionError,
  readApiKeyApplicationResultKeyId,
  structuredContentContainsSecret,
  type ApiKeyToolResultMetadata,
  type McpApiKeyApplicationResult,
} from './secret-redaction.js';
import {
  DEFAULT_MCP_WRITE_INPUT_BUDGET,
  resolveMcpWriteInputBudget,
  snapshotMcpData,
  type McpWriteInputBudget,
} from './safe-data.js';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from './shared/authorization.js';
import {
  createMcpToolInputValidator,
  createMcpToolOutputValidator,
  McpToolOutputError,
  type McpToolInputSchema,
  type McpToolOutputSchema,
} from './tool-input.js';
import {
  readHostPlanner,
  resolveChangePlanOptions,
  type McpChangePlanHostPlannerOption,
} from './write-tool-options.js';
import { createCanonicalMcpSchemaReference } from './schema-ref.js';
import type { McpHttpUriPolicyPort } from './http-uri-policy.js';
import type { McpToolDefinition } from './collections-get.js';
import { types as nodeTypes } from 'node:util';

export interface McpWriteToolResult {
  readonly structuredContent?: unknown;
  readonly content?: unknown;
  readonly isError?: boolean;
  readonly [field: string]: unknown;
}

export interface McpWriteToolGateway {
  readonly listTools: (context?: McpTrustedWriteRequestContext) => readonly McpToolDefinition[];
  readonly callTool: (
    name: string,
    input: unknown,
    context: McpTrustedWriteRequestContext,
  ) => Promise<McpWriteToolResult>;
  /** Host-only: record out-of-band approval (never a model Tool). */
  readonly recordOutOfBandApproval: (
    planId: string,
    context: McpTrustedWriteRequestContext,
  ) => Promise<void>;
  /** Legacy heuristic diagnostics only; callTool authorization never consumes this result. */
  readonly assessRisk: (toolName: string, input?: unknown) => ToolRiskAssessment;
  /** Limit the host transport MUST enforce on raw bytes before JSON parsing. */
  readonly transportRequirements: McpWriteTransportRequirements;
}

export interface McpWriteTransportRequirements {
  readonly maxRequestBodyBytes: number;
  readonly enforceBeforeJsonParsing: true;
}

/**
 * Per-request trusted context asserted by the trusted host boundary. This is an
 * application contract, not a TypeScript claim that in-process callers cannot
 * forge values; transport adapters must construct it only after authentication
 * and authorization. Every gateway call re-accepts the current binding, scope,
 * budget and abort signal; no context captured from an earlier request is
 * reused. Raw tokens, client secrets and reversible credential material never
 * enter this context.
 */
export interface McpTrustedWriteRequestContext {
  /** Current authenticated authorization binding for this request. */
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** Authorization scopes granted by the trusted host for this request. */
  readonly scope: readonly string[];
  /** Current per-request resource budget; validated on every call. */
  readonly budget: McpWriteInputBudget;
  /** Host-owned abort signal for this request; checked at call boundaries. */
  readonly abortSignal: AbortSignal;
  /** Opaque host residual authorization/decision metadata carried to application ports. */
  readonly authorization: Readonly<Record<string, unknown>>;
}

export interface McpApiKeyApplicationPort {
  readonly createKey: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedWriteRequestContext,
  ) => McpApiKeyApplicationResult | PromiseLike<McpApiKeyApplicationResult>;
  readonly rotateKey: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedWriteRequestContext,
  ) => McpApiKeyApplicationResult | PromiseLike<McpApiKeyApplicationResult>;
}

export interface McpLowRiskToolDefinition {
  readonly inputSchema: McpToolInputSchema;
  /** Closed schema for the successful model-visible structured result. */
  readonly outputSchema: McpToolOutputSchema;
  /** Scopes required before this Tool is advertised or invoked. */
  readonly requiredScopes?: readonly string[];
  readonly toCanonicalOperations: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedWriteRequestContext,
  ) => readonly CanonicalRiskOperation[];
  readonly invoke: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedWriteRequestContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface McpWriteToolGatewayOptions<
  Transaction extends McpChangePlanCommitTransaction = McpChangePlanCommitTransaction,
> {
  readonly changePlan: McpChangePlanServiceOptions<Transaction> & McpChangePlanHostPlannerOption;
  /**
   * Builds a host-owned reveal URI for a key id. Required when key tools are
   * enabled or a Change Plan contains create_key / rotate_key.
   */
  readonly revealUriForKey?: (keyId: string) => string;
  /** Optional key application port; when present, keys.create / keys.rotate are published. */
  readonly apiKeys?: McpApiKeyApplicationPort;
  /**
   * Optional low-risk write application tools. Every registration supplies a
   * closed input schema and a trusted canonical-operation adapter; high-risk
   * content cannot complete as a one-shot call.
   */
  readonly lowRiskTools?: Readonly<Record<string, McpLowRiskToolDefinition>>;
  /**
   * Gateway default write-input budget, also the host transport byte cap
   * (transportRequirements.maxRequestBodyBytes). The host transport MUST enforce
   * maxBytes on the raw request body before JSON parsing; each call may carry a
   * tighter per-request budget in its trusted request context.
   */
  readonly inputBudget?: McpWriteInputBudget;
}

const opaqueIdRef = createCanonicalMcpSchemaReference('opaqueId');
const changePlanOperationRef = createCanonicalMcpSchemaReference('changePlanOperation');
const apiKeyCreateRequestRef = createCanonicalMcpSchemaReference('apiKeyCreateRequest');
const apiKeyRotateRequestRef = createCanonicalMcpSchemaReference('apiKeyRotateRequest');
const changePlanResultRef = createCanonicalMcpSchemaReference('changePlan');
const changeCommitResultRef = createCanonicalMcpSchemaReference('changeCommitResult');
const scopeNameRef = createCanonicalMcpSchemaReference('scopeName');
const dateTimeRef = createCanonicalMcpSchemaReference('dateTime');
const httpUrlRef = createCanonicalMcpSchemaReference('httpUrl');

function createPlanInputSchema(maxOperations: number): McpToolInputSchema {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({
      operations: Object.freeze({
        type: 'array',
        minItems: 1,
        maxItems: maxOperations,
        items: changePlanOperationRef,
      }),
      reason: Object.freeze({
        type: 'string',
        minLength: 1,
        maxLength: MCP_CHANGE_PLAN_UNTRUSTED_NOTE_MAX_LENGTH,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$',
      }),
      dryRun: Object.freeze({ const: true }),
    }),
    required: Object.freeze(['operations', 'reason', 'dryRun']),
  } as const satisfies McpToolInputSchema);
}

const planInputSchema = createPlanInputSchema(
  DEFAULT_MCP_WRITE_INPUT_BUDGET.maxOperations,
);

const commitInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: opaqueIdRef,
    idempotencyKey: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['planId', 'idempotencyKey']),
} as const satisfies McpToolInputSchema);

const cancelInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: opaqueIdRef,
  }),
  required: Object.freeze(['planId']),
} as const satisfies McpToolInputSchema);

const cancelOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: opaqueIdRef,
    status: Object.freeze({ const: 'cancelled' }),
  }),
  required: Object.freeze(['planId', 'status']),
} as const satisfies McpToolOutputSchema);

const requiresPlanOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    error: Object.freeze({ const: 'high_risk_requires_plan' }),
    message: Object.freeze({ type: 'string', minLength: 1 }),
    assessment: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        level: Object.freeze({ const: 'high' }),
        affectedObjects: Object.freeze({ type: 'integer', minimum: 1 }),
        requiresPlan: Object.freeze({ const: true }),
        expanded: Object.freeze({
          type: 'array',
          items: Object.freeze({
            type: 'object',
            additionalProperties: false,
            properties: Object.freeze({
              type: Object.freeze({ type: 'string', minLength: 1 }),
              risk: Object.freeze({ type: 'string', enum: Object.freeze(['low', 'medium', 'high']) }),
              path: Object.freeze({ type: 'string', minLength: 1 }),
            }),
            required: Object.freeze(['type', 'risk', 'path']),
          }),
        }),
      }),
      required: Object.freeze(['level', 'affectedObjects', 'requiresPlan', 'expanded']),
    }),
  }),
  required: Object.freeze(['error', 'message', 'assessment']),
} as const satisfies McpToolOutputSchema);

const redactedApiKeyOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    keyId: opaqueIdRef,
    name: Object.freeze({ type: 'string', minLength: 1 }),
    type: Object.freeze({
      type: 'string',
      enum: Object.freeze(['read_key', 'sync_key', 'publisher_key', 'admin_key', 'one_time_key']),
    }),
    scopes: Object.freeze({
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: scopeNameRef,
    }),
    collections: Object.freeze({
      type: 'array',
      uniqueItems: true,
      items: opaqueIdRef,
    }),
    createdAt: dateTimeRef,
    expiresAt: Object.freeze({ oneOf: Object.freeze([
      Object.freeze({ type: 'null' }),
      dateTimeRef,
    ]) }),
    lastUsedAt: Object.freeze({ oneOf: Object.freeze([
      Object.freeze({ type: 'null' }),
      dateTimeRef,
    ]) }),
    lastUsedIp: Object.freeze({ type: Object.freeze(['string', 'null']) }),
    status: Object.freeze({
      type: 'string',
      enum: Object.freeze(['active', 'rotating', 'revoked', 'expired']),
    }),
    secretAvailable: Object.freeze({ const: true }),
    revealUri: httpUrlRef,
  }),
  required: Object.freeze(['keyId', 'secretAvailable', 'revealUri']),
} as const satisfies McpToolOutputSchema);

function withRequiresPlanOutput(
  successSchema: McpToolOutputSchema,
): McpToolOutputSchema {
  return Object.freeze({
    type: 'object',
    oneOf: Object.freeze([successSchema, requiresPlanOutputSchema]),
    unevaluatedProperties: false,
  });
}

const keyOutputSchema = withRequiresPlanOutput(redactedApiKeyOutputSchema);

const toolNamePattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u;
const MAX_TOOL_NAME_LENGTH = 128;
const RESERVED_WRITE_TOOL_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  'changes.plan',
  'changes.commit',
  'changes.cancel',
  'keys.create',
  'keys.rotate',
]));

export const changesPlanToolDefinition = Object.freeze({
  name: 'changes.plan',
  description: 'Create a typed Change Plan for high-risk operations. Requires out-of-band approval before commit.',
  inputSchema: planInputSchema,
  outputSchema: changePlanResultRef,
  requiredScopes: Object.freeze(['access:write']),
} as const satisfies McpToolDefinition);

export const changesCommitToolDefinition = Object.freeze({
  name: 'changes.commit',
  description: 'Commit an approved Change Plan. Revalidates binding, digest, revisions, scope, and impact.',
  inputSchema: commitInputSchema,
  outputSchema: changeCommitResultRef,
  requiredScopes: Object.freeze(['access:write']),
} as const satisfies McpToolDefinition);

export const changesCancelToolDefinition = Object.freeze({
  name: 'changes.cancel',
  description: 'Cancel a pending Change Plan bound to the current Subject / Client / Session.',
  inputSchema: cancelInputSchema,
  outputSchema: cancelOutputSchema,
  requiredScopes: Object.freeze(['access:write']),
} as const satisfies McpToolDefinition);

export const keysCreateToolDefinition = Object.freeze({
  name: 'keys.create',
  description: 'Create an API key via Plan/Commit-safe path. Structured results never include plaintext secrets.',
  inputSchema: apiKeyCreateRequestRef,
  outputSchema: keyOutputSchema,
  requiredScopes: Object.freeze(['keys:write']),
} as const satisfies McpToolDefinition);

export const keysRotateToolDefinition = Object.freeze({
  name: 'keys.rotate',
  description: 'Rotate an API key via Plan/Commit-safe path. Structured results never include plaintext secrets.',
  inputSchema: apiKeyRotateRequestRef,
  outputSchema: keyOutputSchema,
  requiredScopes: Object.freeze(['keys:write']),
} as const satisfies McpToolDefinition);

/**
 * Creates the MCP write Tool gateway.
 * High-risk one-shot tools fail closed and must use changes.plan / changes.commit.
 * keys.create / keys.rotate results are always redacted before returning to the model.
 */
export function createMcpWriteToolGateway<
  Transaction extends McpChangePlanCommitTransaction,
>(
  options: McpWriteToolGatewayOptions<Transaction>,
): McpWriteToolGateway {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('createMcpWriteToolGateway requires an options object.');
  }

  const changePlanOptions = readOwnValue(options, 'changePlan');
  if (
    typeof changePlanOptions !== 'object'
    || changePlanOptions === null
    || nodeTypes.isProxy(changePlanOptions)
  ) {
    throw new TypeError('createMcpWriteToolGateway requires a changePlan options object.');
  }

  const apiKeys = readOptionalOwnValue(options, 'apiKeys') as McpApiKeyApplicationPort | undefined;
  const revealUriForKey = readOptionalOwnValue(options, 'revealUriForKey') as
    | ((keyId: string) => string)
    | undefined;
  const changePlanRevealUriForKey = readOptionalOwnValue(changePlanOptions, 'revealUriForKey') as
    | ((keyId: string) => string)
    | undefined;
  const activeRevealUriForKey = changePlanRevealUriForKey ?? revealUriForKey;
  const uriPolicy = readOwnValue(changePlanOptions, 'uriPolicy') as McpHttpUriPolicyPort;
  const lowRiskTools = readOptionalOwnValue(options, 'lowRiskTools') as
    | Readonly<Record<string, McpLowRiskToolDefinition>>
    | undefined;
  const configuredInputBudget = readOptionalOwnValue(options, 'inputBudget') as McpWriteInputBudget | undefined;
  const snapshotBudget = resolveMcpWriteInputBudget(configuredInputBudget);
  const activePlanInputSchema = createPlanInputSchema(snapshotBudget.maxOperations);
  const activePlanToolDefinition = Object.freeze({
    ...changesPlanToolDefinition,
    inputSchema: activePlanInputSchema,
  } as const satisfies McpToolDefinition);
  const validatePlanInput = createMcpToolInputValidator(activePlanInputSchema, snapshotBudget);
  const validateCommitInput = createMcpToolInputValidator(commitInputSchema, snapshotBudget);
  const validateCancelInput = createMcpToolInputValidator(cancelInputSchema, snapshotBudget);
  const validatePlanOutput = createMcpToolOutputValidator(changePlanResultRef);
  const validateCommitOutput = createMcpToolOutputValidator(changeCommitResultRef);
  const validateCancelOutput = createMcpToolOutputValidator(cancelOutputSchema);
  const validateKeyOutput = createMcpToolOutputValidator(keyOutputSchema);

  // Ensure rate-limit revalidation and commit secret redaction are always wired.
  const resolvedChangePlan = resolveChangePlanOptions(
    changePlanOptions as McpChangePlanServiceOptions<Transaction>,
    revealUriForKey,
    snapshotBudget,
  );
  const planService: McpChangePlanService = createChangePlanService(resolvedChangePlan);
  const hostPlan = readHostPlanner(changePlanOptions);

  const tools: McpToolDefinition[] = [
    activePlanToolDefinition,
    changesCommitToolDefinition,
    changesCancelToolDefinition,
  ];
  const registeredLowRiskTools = new Map<string, Readonly<{
    definition: McpLowRiskToolDefinition;
    validate: ReturnType<typeof createMcpToolInputValidator>;
    validateOutput: ReturnType<typeof createMcpToolOutputValidator>;
  }>>();

  if (apiKeys !== undefined) {
    if (nodeTypes.isProxy(apiKeys)) {
      throw new TypeError('apiKeys must not be a Proxy.');
    }
    if (typeof activeRevealUriForKey !== 'function' || nodeTypes.isProxy(activeRevealUriForKey)) {
      throw new TypeError('apiKeys require revealUriForKey to build host-owned reveal URIs.');
    }
    assertOwnFunction(apiKeys, 'createKey');
    assertOwnFunction(apiKeys, 'rotateKey');
    tools.push(keysCreateToolDefinition, keysRotateToolDefinition);
  }

  if (lowRiskTools !== undefined) {
    if (typeof lowRiskTools !== 'object' || lowRiskTools === null || nodeTypes.isProxy(lowRiskTools)) {
      throw new TypeError('lowRiskTools must be an own-data object map.');
    }
    for (const name of Reflect.ownKeys(lowRiskTools)) {
      if (typeof name !== 'string' || name.length > MAX_TOOL_NAME_LENGTH || !toolNamePattern.test(name)) {
        throw new TypeError(`Invalid low-risk tool name: ${String(name)}`);
      }
      if (RESERVED_WRITE_TOOL_NAMES.has(name)) {
        throw new TypeError(`Reserved MCP write tool name cannot be registered as low risk: ${name}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(lowRiskTools, name);
      if (descriptor === undefined || !('value' in descriptor)
        || typeof descriptor.value !== 'object' || descriptor.value === null) {
        throw new TypeError(`lowRiskTools.${name} must be an own-data definition.`);
      }
      const definition = descriptor.value as McpLowRiskToolDefinition;
      if (nodeTypes.isProxy(definition)) {
        throw new TypeError(`lowRiskTools.${name} must not be a Proxy.`);
      }
      const requiredScopesCandidate = readOwnValue(definition, 'requiredScopes');
      const requiredScopes = readWriteToolScopes(requiredScopesCandidate);
      const inputSchemaCandidate = readOwnValue(definition, 'inputSchema');
      if (typeof inputSchemaCandidate !== 'object' || inputSchemaCandidate === null
        || nodeTypes.isProxy(inputSchemaCandidate)) {
        throw new TypeError(`lowRiskTools.${name}.inputSchema must be a closed object schema.`);
      }
      let inputSchema: McpToolInputSchema;
      try {
        inputSchema = snapshotMcpData(inputSchemaCandidate) as McpToolInputSchema;
      } catch {
        throw new TypeError(`lowRiskTools.${name}.inputSchema must be JSON data.`);
      }
      if (inputSchema.type !== 'object' || inputSchema.additionalProperties !== false) {
        throw new TypeError(`lowRiskTools.${name}.inputSchema must be a closed object schema.`);
      }
      const outputSchemaCandidate = readOwnValue(definition, 'outputSchema');
      if (typeof outputSchemaCandidate !== 'object' || outputSchemaCandidate === null
        || nodeTypes.isProxy(outputSchemaCandidate)) {
        throw new TypeError(`lowRiskTools.${name}.outputSchema must be a closed object schema.`);
      }
      let outputSchema: McpToolOutputSchema;
      try {
        outputSchema = snapshotMcpData(
          outputSchemaCandidate,
        ) as McpToolOutputSchema;
      } catch {
        throw new TypeError(`lowRiskTools.${name}.outputSchema must be JSON data.`);
      }
      if (outputSchema.type !== 'object' || outputSchema.additionalProperties !== false) {
        throw new TypeError(`lowRiskTools.${name}.outputSchema must be a closed object schema.`);
      }
      assertOwnFunction(definition, 'toCanonicalOperations', `lowRiskTools.${name}`);
      assertOwnFunction(definition, 'invoke', `lowRiskTools.${name}`);
      const publishedOutputSchema = withRequiresPlanOutput(outputSchema);
      registeredLowRiskTools.set(name, Object.freeze({
        definition,
        validate: createMcpToolInputValidator(inputSchema, snapshotBudget),
        validateOutput: createMcpToolOutputValidator(publishedOutputSchema),
      }));
      tools.push(Object.freeze({
        name,
        description: `Write tool ${name}`,
        inputSchema,
        outputSchema: publishedOutputSchema,
        ...(requiredScopes.length > 0 ? { requiredScopes } : {}),
      }));
    }
  }

  const published = Object.freeze(tools.slice());

  const listTools = (context?: McpTrustedWriteRequestContext): readonly McpToolDefinition[] => {
    if (context === undefined) return published;
    const trustedContext = requireTrustedWriteRequestContext(context);
    const effectiveScope = new Set(trustedContext.scope);
    return Object.freeze(published.filter((definition) =>
      hasWriteToolScopes(readWriteToolScopes(readOwnValue(definition, 'requiredScopes')), effectiveScope),
    ));
  };

  const callTool = async (
    name: string,
    input: unknown,
    context: McpTrustedWriteRequestContext,
  ): Promise<McpWriteToolResult> => {
    const activeContext = requireTrustedWriteRequestContext(context);
    assertNotAborted(activeContext.abortSignal);
    const requestBudget = activeContext.budget;
    const activeBinding = activeContext.binding;
    if (typeof name !== 'string' || name.length > MAX_TOOL_NAME_LENGTH || !toolNamePattern.test(name)) {
      throw new McpWriteUnknownToolError();
    }

    if (name === 'changes.plan') {
      const validated = validatePlanInput(input, requestBudget);
      const plan = await (hostPlan ?? planService.plan)(validated, activeBinding);
      assertNotAborted(activeContext.abortSignal);
      return validatedStructuredResult(plan, validatePlanOutput);
    }

    if (name === 'changes.commit') {
      const validated = validateCommitInput(input, requestBudget);
      const result = await planService.commit(
        validated.planId as string,
        activeBinding,
        validated.idempotencyKey as string,
      );
      assertNotAborted(activeContext.abortSignal);
      // The Plan service already applied the host reveal boundary before
      // committing. Re-project its receipt without consulting mutable reveal
      // configuration so exact idempotent replays retain the first result.
      const structuredContent = redactCommitStructuredContent(result);
      if (structuredContentContainsSecret(structuredContent)) {
        throw new Error('Commit structured content still contains secrets after redaction.');
      }
      return validatedStructuredResult(structuredContent, validateCommitOutput);
    }

    if (name === 'changes.cancel') {
      const validated = validateCancelInput(input, requestBudget);
      const result = await planService.cancel(validated.planId as string, activeBinding);
      assertNotAborted(activeContext.abortSignal);
      return validatedStructuredResult(result, validateCancelOutput);
    }

    if (name === 'keys.create' || name === 'keys.rotate') {
      const validated = createMcpToolInputValidator(
        name === 'keys.create' ? keysCreateToolDefinition.inputSchema : keysRotateToolDefinition.inputSchema,
        snapshotBudget,
      )(input, requestBudget);
      // High-risk: one-shot path is rejected; callers must use Plan/Commit.
      // When invoked through this gateway as a direct tool, fail closed with requiresPlan.
      try {
        assertOneShotCanonicalOperationsAllowed(Object.freeze([Object.freeze({
          type: name,
          risk: 'high' as const,
        })]), requestBudget);
      } catch (error) {
        if (error instanceof McpHighRiskRequiresPlanError) {
          return requiresPlanResult(error, validateKeyOutput);
        }
        throw error;
      }
      // Unreachable for keys.* because they are always high risk; defensive redaction path:
      return await invokeKeyTool(
        name,
        validated,
        activeContext,
        apiKeys,
        activeRevealUriForKey,
        uriPolicy,
        validateKeyOutput,
      );
    }

    const registration = registeredLowRiskTools.get(name);
    if (registration !== undefined) {
      const requiredScopes = readWriteToolScopes(readOwnValue(registration.definition, 'requiredScopes'));
      if (!hasWriteToolScopes(requiredScopes, activeContext.scope)) throw new McpWriteToolScopeDeniedError();
      const inputSnapshot = registration.validate(input, requestBudget);
      const extractor = readOwnValue(registration.definition, 'toCanonicalOperations') as
        McpLowRiskToolDefinition['toCanonicalOperations'];
      const canonical = Reflect.apply(extractor, registration.definition, [inputSnapshot, activeContext]);
      try {
        assertOneShotCanonicalOperationsAllowed(canonical, requestBudget);
      } catch (error) {
        if (error instanceof McpHighRiskRequiresPlanError) {
          return requiresPlanResult(error, registration.validateOutput);
        }
        throw error;
      }
      const invoker = readOwnValue(registration.definition, 'invoke') as McpLowRiskToolDefinition['invoke'];
      const projected = await Reflect.apply(invoker, registration.definition, [inputSnapshot, activeContext]);
      assertNotAborted(activeContext.abortSignal);
      let structuredContent: unknown;
      try {
        structuredContent = snapshotMcpData(projected, requestBudget);
      } catch {
        throw new McpToolOutputError([Object.freeze({
          instancePath: '',
          keyword: 'dataProperty',
          message: 'must fit the configured JSON own-data resource budget',
        })]);
      }
      return validatedStructuredResult(structuredContent, registration.validateOutput);
    }

    // Unregistered write tools have no trusted canonical-operation adapter.
    throw new McpWriteUnknownToolError();
  };

  const recordOutOfBandApproval = async (
    planId: string,
    context: McpTrustedWriteRequestContext,
  ): Promise<void> => {
    const activeContext = requireTrustedWriteRequestContext(context);
    assertNotAborted(activeContext.abortSignal);
    await planService.recordOutOfBandApproval(planId, activeContext.binding);
    assertNotAborted(activeContext.abortSignal);
  };

  // Diagnostic compatibility API only; callTool never uses heuristic expansion.
  const assessRisk = (toolName: string, input?: unknown): ToolRiskAssessment =>
    assessToolCallRisk(toolName, input, snapshotBudget);

  const transportRequirements: McpWriteTransportRequirements = Object.freeze({
    maxRequestBodyBytes: snapshotBudget.maxBytes,
    enforceBeforeJsonParsing: true,
  });

  return Object.freeze({
    listTools,
    callTool,
    recordOutOfBandApproval,
    assessRisk,
    transportRequirements,
  });
}

/**
 * Builds a redacted key tool result for hosts that execute keys.create / keys.rotate
 * inside a committed plan (post-approval). Never returns plaintext secrets.
 */
export function toRedactedKeyToolResult(
  raw: McpApiKeyApplicationResult,
  revealUri: string,
  uriPolicy: McpHttpUriPolicyPort,
): ApiKeyToolResultMetadata {
  const redacted = redactApiKeyToolResult(raw, { revealUri, uriPolicy });
  if (structuredContentContainsSecret(redacted)) {
    throw new Error('Redacted key tool result still contains secrets.');
  }
  return redacted;
}

export class McpWriteToolScopeDeniedError extends TypeError {
  readonly code = 'tool_scope_denied' as const;

  constructor() {
    super('MCP write Tool is not available for the current authorization scopes.');
    this.name = 'McpWriteToolScopeDeniedError';
  }
}

export class McpWriteUnknownToolError extends TypeError {
  readonly code = 'unknown_tool' as const;

  constructor() {
    super('Unknown MCP write Tool.');
    this.name = 'McpWriteUnknownToolError';
  }
}

export class McpWriteBindingRequiredError extends TypeError {
  readonly code = 'binding_required' as const;

  constructor() {
    super('MCP write Tools require a trusted per-request binding/scope/budget/abort context.');
    this.name = 'McpWriteBindingRequiredError';
  }
}

export class McpWriteRequestAbortedError extends Error {
  readonly code = 'request_aborted' as const;

  constructor() {
    super('MCP write request aborted before a model-visible result was produced.');
    this.name = 'McpWriteRequestAbortedError';
  }
}

function readWriteToolScopes(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('Tool requiredScopes must be an array of non-empty strings.');
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > 128) {
      throw new TypeError('Tool requiredScopes must be an array of non-empty strings.');
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) throw new TypeError('Tool requiredScopes must be unique.');
  return Object.freeze(scopes);
}

function hasWriteToolScopes(required: readonly string[], effective: ReadonlySet<string> | readonly string[]): boolean {
  const set = effective instanceof Set ? effective : new Set(effective);
  return required.every((scope) => set.has(scope));
}

async function invokeKeyTool(
  name: 'keys.create' | 'keys.rotate',
  input: Readonly<Record<string, unknown>>,
  context: McpTrustedWriteRequestContext,
  apiKeys: McpApiKeyApplicationPort | undefined,
  revealUriForKey: ((keyId: string) => string) | undefined,
  uriPolicy: McpHttpUriPolicyPort,
  validateOutput: ReturnType<typeof createMcpToolOutputValidator>,
): Promise<McpWriteToolResult> {
  if (apiKeys === undefined || revealUriForKey === undefined) {
    throw new McpWriteUnknownToolError();
  }
  const method = name === 'keys.create' ? 'createKey' : 'rotateKey';
  const descriptor = Object.getOwnPropertyDescriptor(apiKeys, method);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new McpWriteUnknownToolError();
  }
  const invoke = descriptor.value as McpApiKeyApplicationPort[typeof method];
  const raw = await Reflect.apply(invoke, apiKeys, [input, context]) as McpApiKeyApplicationResult;
  assertNotAborted(context.abortSignal);
  const keyId = readApiKeyApplicationResultKeyId(raw);
  let revealUri: unknown;
  try {
    revealUri = Reflect.apply(revealUriForKey, undefined, [keyId]);
  } catch {
    throw new McpSecretRedactionError('revealUriForKey failed to produce a safe URI.');
  }
  const structuredContent = snapshotMcpData(
    toRedactedKeyToolResult(raw, revealUri as string, uriPolicy),
    context.budget,
  );
  return validatedStructuredResult(structuredContent, validateOutput);
}

function requiresPlanResult(
  error: McpHighRiskRequiresPlanError,
  validateOutput: ReturnType<typeof createMcpToolOutputValidator>,
): McpWriteToolResult {
  const structuredContent = Object.freeze({
    error: 'high_risk_requires_plan' as const,
    message: error.message,
    assessment: error.assessment,
  });
  validateOutput(structuredContent);
  return Object.freeze({ isError: true, structuredContent });
}

function validatedStructuredResult(
  structuredContent: unknown,
  validateOutput: ReturnType<typeof createMcpToolOutputValidator>,
): McpWriteToolResult {
  validateOutput(structuredContent);
  return Object.freeze({ structuredContent });
}

function requireTrustedWriteRequestContext(
  context: McpTrustedWriteRequestContext | undefined,
): McpTrustedWriteRequestContext {
  if (typeof context !== 'object' || context === null || nodeTypes.isProxy(context)) {
    throw new McpWriteBindingRequiredError();
  }
  const binding = readOwnValue(context, 'binding');
  const scope = readOwnValue(context, 'scope');
  const budget = readOwnValue(context, 'budget');
  const abortSignal = readOwnValue(context, 'abortSignal');
  const authorization = readOwnValue(context, 'authorization');
  if (typeof authorization !== 'object' || authorization === null || Array.isArray(authorization)
    || nodeTypes.isProxy(authorization)) {
    throw new McpWriteBindingRequiredError();
  }
  let ownedBinding: McpAuthenticatedAuthorizationBinding;
  try {
    ownedBinding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(binding));
  } catch {
    throw new McpWriteBindingRequiredError();
  }
  const ownedBudget = resolveRequestBudget(budget);
  const ownedScope = snapshotRequestScope(scope, ownedBudget);
  const ownedAbortSignal = requireAbortSignal(abortSignal);
  let ownedAuthorization: Readonly<Record<string, unknown>>;
  try {
    ownedAuthorization = snapshotMcpData(authorization, ownedBudget) as Readonly<Record<string, unknown>>;
  } catch {
    throw new McpWriteBindingRequiredError();
  }
  return Object.freeze({
    binding: ownedBinding,
    scope: ownedScope,
    budget: ownedBudget,
    abortSignal: ownedAbortSignal,
    authorization: ownedAuthorization,
  });
}

function resolveRequestBudget(budget: unknown): Required<McpWriteInputBudget> {
  if (budget === undefined) {
    throw new McpWriteBindingRequiredError();
  }
  try {
    return resolveMcpWriteInputBudget(budget as McpWriteInputBudget);
  } catch {
    throw new McpWriteBindingRequiredError();
  }
}

function snapshotRequestScope(
  scope: unknown,
  budget: Required<McpWriteInputBudget>,
): readonly string[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotMcpData(scope, budget);
  } catch {
    throw new McpWriteBindingRequiredError();
  }
  if (!Array.isArray(snapshot) || snapshot.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new McpWriteBindingRequiredError();
  }
  return snapshot;
}

function requireAbortSignal(signal: unknown): AbortSignal {
  if (typeof signal !== 'object' || signal === null || Array.isArray(signal) || nodeTypes.isProxy(signal)) {
    throw new McpWriteBindingRequiredError();
  }
  let aborted: unknown;
  let addEventListener: unknown;
  try {
    aborted = (signal as { readonly aborted: unknown }).aborted;
    addEventListener = (signal as { readonly addEventListener?: unknown }).addEventListener;
  } catch {
    throw new McpWriteBindingRequiredError();
  }
  if (typeof aborted !== 'boolean' || typeof addEventListener !== 'function') {
    throw new McpWriteBindingRequiredError();
  }
  return signal as AbortSignal;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new McpWriteRequestAbortedError();
  }
}

function readOwnValue(object: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function readOptionalOwnValue(object: object, name: string): unknown {
  return readOwnValue(object, name);
}

function assertOwnFunction(object: object, name: string, label = 'API key port'): void {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError(
      `${label} must own ${name} as a data function `
        + '(class prototype methods are rejected; bind or wrap as an own property).',
    );
  }
}
