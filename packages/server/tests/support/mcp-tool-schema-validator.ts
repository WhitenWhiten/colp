import { collectionProtocolSchema, createAjv } from '@know-n/colp/schema';

const ajv = createAjv({ allErrors: true, ownProperties: true });
ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);

export class McpToolInputError extends TypeError {}

export function createMcpToolInputValidator(schema: Readonly<Record<string, unknown>>) {
  const validate = ajv.compile(schema);
  return (input: unknown): Readonly<Record<string, unknown>> => {
    if (!validate(input)) throw new McpToolInputError('Input does not match the listed tool schema');
    return input as Readonly<Record<string, unknown>>;
  };
}
