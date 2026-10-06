import type {
  ErrorObject,
  ValidateFunction,
} from 'ajv/dist/2020.js';
import { types as nodeTypes } from 'node:util';
import { collectionProtocolSchema, createAjv } from '../schema/index.js';
import {
  resolveMcpWriteInputBudget,
  snapshotMcpData,
  type McpWriteInputBudget,
} from './safe-data.js';

export interface McpToolSchema {
  readonly [keyword: string]: unknown;
}

export interface McpToolInputSchema extends McpToolSchema {
  readonly type?: 'object';
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type McpToolOutputSchema = McpToolSchema;

export interface McpToolInputIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export class McpToolInputError extends TypeError {
  readonly code = 'invalid_tool_input' as const;
  readonly issues: readonly McpToolInputIssue[];

  constructor(issues: readonly McpToolInputIssue[]) {
    super('MCP Tool input does not match its inputSchema.');
    this.name = 'McpToolInputError';
    this.issues = Object.freeze([...issues]);
  }
}

export type McpToolInputValidator = (
  input: unknown,
  budget?: McpWriteInputBudget,
) => Readonly<Record<string, unknown>>;

export type McpToolOutputValidator = (output: unknown) => void;

const ajv = createAjv({
  allErrors: true,
  ownProperties: true,
});
ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);

/** Compiles the common validation boundary used before any Tool reaches an application service. */
export function createMcpToolInputValidator(
  inputSchema: McpToolInputSchema,
  snapshotBudget?: McpWriteInputBudget,
): McpToolInputValidator {
  const validate = ajv.compile(inputSchema);

  return (input: unknown, requestBudget?: McpWriteInputBudget): Readonly<Record<string, unknown>> => {
    const snapshot = snapshotOwnDataProperties(input, requestBudget ?? snapshotBudget);
    if (!validate(snapshot)) {
      throw new McpToolInputError(toIssues(validate));
    }
    return snapshot as Readonly<Record<string, unknown>>;
  };
}

/**
 * Projects top-level enumerable own data properties for compatibility with JSON
 * parsing, then deep-snapshots once so the request shares one resource budget.
 */
function snapshotOwnDataProperties(input: unknown, snapshotBudget?: McpWriteInputBudget): unknown {
  let candidate = input;
  try {
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      if (nodeTypes.isProxy(input)) throw new TypeError('Proxy input is not JSON data.');
      const limits = resolveMcpWriteInputBudget(snapshotBudget);
      const projected: Record<string, unknown> = {};
      let projectedNodes = 1;
      let projectedBytes = 1;
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string') continue;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || descriptor.enumerable !== true) continue;
        if (!('value' in descriptor)) throw new TypeError('Accessor input is not JSON data.');
        projectedNodes += 1;
        projectedBytes += key.length * 4;
        if (projectedNodes > limits.maxNodes || projectedBytes > limits.maxBytes) {
          throw new TypeError('MCP Tool input exceeded its resource budget.');
        }
        Object.defineProperty(projected, key, {
          enumerable: true,
          value: descriptor.value,
        });
      }
      candidate = projected;
    }
    return snapshotMcpData(candidate, snapshotBudget);
  } catch {
    throw new McpToolInputError([Object.freeze({
      instancePath: '',
      keyword: 'dataProperty',
      message: 'must fit the configured JSON own-data resource budget',
    })]);
  }
}

/** Eagerly compiles a Tool output contract and validates model-visible JSON data. */
export function createMcpToolOutputValidator(
  outputSchema: McpToolOutputSchema,
): McpToolOutputValidator {
  const validate = ajv.compile(outputSchema);

  return (output: unknown): void => {
    if (!validate(output)) {
      throw new McpToolOutputError(toIssues(validate));
    }
  };
}

export class McpToolOutputError extends TypeError {
  readonly code = 'invalid_tool_output' as const;
  readonly issues: readonly McpToolInputIssue[];

  constructor(issues: readonly McpToolInputIssue[]) {
    super('MCP Tool structured content does not match its outputSchema.');
    this.name = 'McpToolOutputError';
    this.issues = Object.freeze([...issues]);
  }
}

function toIssues(validate: ValidateFunction): readonly McpToolInputIssue[] {
  const errors = validate.errors ?? [];
  return Object.freeze(errors.map(toIssue));
}

function toIssue(error: ErrorObject): McpToolInputIssue {
  return Object.freeze({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'is invalid',
  });
}
