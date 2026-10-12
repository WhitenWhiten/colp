import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { automationSchema } from './schema.generated.js';

export const AUTOMATION_CONTRACT_VERSION = '0.2.1-design' as const;
export const AUTOMATION_API_VERSION = 'colp.automation/v1' as const;
export const AUTOMATION_PROFILE = 'browser-bounded-v1' as const;
export const FACTS_VERSION = 1 as const;
export interface ContractIssue { path: string; code: string; message: string }
export type ContractValidation = { valid: true; issues: [] } | { valid: false; issues: ContractIssue[] };
export type AutomationSchemaName = keyof typeof automationSchema.$defs;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = addFormatsImport as unknown as FormatsPlugin;
addFormats(ajv);
const validators = new Map<AutomationSchemaName, ValidateFunction>();

/** Bound traversal before recursive schema evaluation, including adversarial non-JSON inputs. */
export function boundedJson(value: unknown): boolean {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++count > 100_000 || item.depth > 64) return false;
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (typeof item.value !== 'object' || seen.has(item.value)) return false;
    seen.add(item.value);
    for (const child of Object.values(item.value)) queue.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

export function validateAutomation(name: AutomationSchemaName, value: unknown): ContractValidation {
  if (!boundedJson(value)) return { valid: false, issues: [{ path: '', code: 'invalid_json', message: 'Expected bounded acyclic JSON.' }] };
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $schema: automationSchema.$schema, $ref: `#/$defs/${name}`, $defs: automationSchema.$defs });
    validators.set(name, validate);
  }
  if (validate(value)) return { valid: true, issues: [] };
  return { valid: false, issues: (validate.errors ?? []).slice(0, 100).map((error) => ({
    path: error.instancePath, code: error.keyword, message: error.message ?? 'Invalid value.',
  })) };
}
