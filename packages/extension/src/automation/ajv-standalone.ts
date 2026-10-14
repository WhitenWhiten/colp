import * as validators from '../generated/automation-validators.js';

/**
 * Stands in for `ajv/dist/2020.js` inside the bundled @know-n/colp automation
 * core (scripts/automation-ajv-plugin.mjs). The core compiles
 * `{ $ref: '#/$defs/<Name>' }`; this returns the validator generated ahead of
 * time from that same schema, so nothing is evaluated at runtime (MV3 CSP).
 * An unknown schema fails closed instead of skipping validation.
 */
export class Ajv2020 {
  compile(schema: { readonly $ref?: unknown }): validators.StandaloneValidator {
    const name = typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/') ? schema.$ref.slice(8) : '';
    const validator = Object.hasOwn(validators, name) ? (validators as Record<string, unknown>)[name] : undefined;
    if (typeof validator !== 'function') throw new Error('automation_validator_unavailable');
    return validator as validators.StandaloneValidator;
  }
}
