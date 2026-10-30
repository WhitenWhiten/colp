/** Reviewed discovery vocabulary. This is metadata, never an authorization grant. */
export const AUTOMATION_TASK_TOOLSETS = Object.freeze([
  'recovery', 'rule-authoring', 'run-operations', 'sync-diagnostics',
  'browser-rules', 'adapter-setup', 'connection-admin', 'worker',
]);
export const AUTOMATION_DISCOVERY_EFFECTS = Object.freeze([
  'read', 'state-write', 'preview-write', 'device-request', 'external-read', 'provider-call', 'worker-state',
]);
// These helpers remain subject to their own catalog, current scopes and endpoint policy.
// A workflow reference never makes a helper available to an Automation-only credential.
export const AUTOMATION_DISCOVERY_EXTERNAL_HELPERS = Object.freeze(['collections.list']);

const discoveryKeys = ['taskToolsets', 'keywords', 'prerequisites', 'nextSteps', 'effects', 'dispatchClass'];
const genericDescription = /authorized Automation operation|owner-scoped management|^automation\.[\w.]+[.:]?$/i;
const fail = (name, message) => { throw new TypeError(`Automation discovery ${name}: ${message}`); };

function strings(value, name, field, min, max, maxLength) {
  if (!Array.isArray(value) || value.length < min || value.length > max
    || value.some(item => typeof item !== 'string' || item.trim() !== item || item.length === 0 || item.length > maxLength)
    || new Set(value).size !== value.length) fail(name, `invalid ${field}`);
  return value;
}

/**
 * Fail generation when a new capability lacks reviewed search and dispatch metadata.
 * prerequisites/nextSteps are bounded workflow hints, not mandatory call order,
 * automatic dependency loading, scope implications, or permission to call a tool.
 */
export function validateAutomationToolDiscovery(tools) {
  if (!Array.isArray(tools) || tools.length === 0) throw new TypeError('Automation catalog has no tools');
  const names = new Set();
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || !/^automation\.[a-z_]+(?:\.[a-z_]+)+$/.test(tool.name)
      || names.has(tool.name)) fail(String(tool.name), 'invalid or duplicate capability name');
    names.add(tool.name);
  }
  const references = new Set([...names, ...AUTOMATION_DISCOVERY_EXTERNAL_HELPERS]);
  const workerNames = new Set(tools.filter(tool => tool.profile === 'automationWorker').map(tool => tool.name));
  for (const tool of tools) {
    const { name, discovery } = tool;
    if (typeof tool.description !== 'string' || tool.description.trim() !== tool.description
      || tool.description.length < 32 || tool.description.length > 640 || genericDescription.test(tool.description)) {
      fail(name, 'provide a specific task description (32–640 characters)');
    }
    if (discovery === null || typeof discovery !== 'object' || Array.isArray(discovery)
      || Object.keys(discovery).length !== discoveryKeys.length
      || discoveryKeys.some(key => !Object.hasOwn(discovery, key))) fail(name, 'missing or unknown discovery fields');
    const tasksets = strings(discovery.taskToolsets, name, 'taskToolsets', 1, 8, 64);
    if (tasksets.some(set => !AUTOMATION_TASK_TOOLSETS.includes(set))) fail(name, 'unknown task toolset');
    if (tool.profile === 'automationWorker') {
      if (tasksets.length !== 1 || tasksets[0] !== 'worker') fail(name, 'Worker tools require the dedicated worker toolset');
    } else if (tool.profile !== 'automationManager' || tasksets.includes('worker')) {
      fail(name, 'Manager tools must not join the worker toolset');
    }
    strings(discovery.keywords, name, 'keywords', 2, 12, 64);
    for (const field of ['prerequisites', 'nextSteps']) {
      const related = strings(discovery[field], name, field, 0, 6, 128);
      if (related.some(reference => reference === name || !references.has(reference))) fail(name, `unknown or self ${field} reference`);
      if (tool.profile === 'automationWorker' && related.some(reference => !workerNames.has(reference))) {
        fail(name, 'Worker workflow references must stay within the Worker catalog');
      }
    }
    const effects = strings(discovery.effects, name, 'effects', 1, 7, 32);
    if (effects.some(effect => !AUTOMATION_DISCOVERY_EFFECTS.includes(effect))) fail(name, 'unknown effect');
    if (discovery.dispatchClass !== 'read' && discovery.dispatchClass !== 'write') fail(name, 'invalid dispatchClass');
    if (discovery.dispatchClass === 'read' && (effects.length !== 1 || effects[0] !== 'read' || tool.annotations?.readOnlyHint === false)) {
      fail(name, 'read dispatch cannot hide effects or a non-read annotation');
    }
    if (discovery.dispatchClass === 'write' && effects.every(effect => effect === 'read')) fail(name, 'write dispatch requires an explicit effect');
  }
}
