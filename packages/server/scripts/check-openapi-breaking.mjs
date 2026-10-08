import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expandLocalRefs, readDocument, stableJson } from './openapi-utils.mjs';

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const ignoredKeys = new Set(['description', 'summary', 'title', 'examples', 'example', 'externalDocs']);

function semantic(document, value) {
  function removeDocumentation(item) {
    if (Array.isArray(item)) return item.map(removeDocumentation);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key, child]) => !ignoredKeys.has(key) && child !== undefined)
        .map(([key, child]) => [key, removeDocumentation(child)]),
    );
  }
  return stableJson(removeDocumentation(expandLocalRefs(document, value)));
}

function isParameterObject(item) {
  return item !== null && typeof item === 'object' && typeof item.in === 'string' && typeof item.name === 'string';
}

function isParameterArray(value) {
  return Array.isArray(value) && value.some(isParameterObject);
}

function isAdditiveOptionalQueryOrHeaderParameter(item) {
  if (!isParameterObject(item)) return false;
  if (item.required === true) return false;
  return item.in === 'query' || item.in === 'header';
}

export function stripAdditiveOptionalProperties(baselineValue, candidateValue) {
  if (Array.isArray(baselineValue) || Array.isArray(candidateValue)) {
    if (!Array.isArray(baselineValue) || !Array.isArray(candidateValue)) return candidateValue;
    const projected = candidateValue.map((item, index) => (
      index < baselineValue.length
        ? stripAdditiveOptionalProperties(baselineValue[index], item)
        : item
    ));
    if (isParameterArray(baselineValue) || isParameterArray(candidateValue)) {
      return projected.filter((item, index) => (
        index < baselineValue.length || !isAdditiveOptionalQueryOrHeaderParameter(item)
      ));
    }
    return projected;
  }
  if (baselineValue === null || candidateValue === null
    || typeof baselineValue !== 'object' || typeof candidateValue !== 'object') return candidateValue;

  const baseline = baselineValue;
  const candidate = candidateValue;
  const projected = { ...candidate };
  if (baseline.properties && candidate.properties
    && typeof baseline.properties === 'object' && typeof candidate.properties === 'object') {
    const required = new Set(Array.isArray(candidate.required) ? candidate.required : []);
    projected.properties = Object.fromEntries(Object.entries(candidate.properties)
      .filter(([name]) => Object.hasOwn(baseline.properties, name) || required.has(name))
      .map(([name, value]) => [name, Object.hasOwn(baseline.properties, name)
        ? stripAdditiveOptionalProperties(baseline.properties[name], value)
        : value]));
  }
  // Explicit media negotiation adds representations without changing existing ones.
  if (baseline.content && candidate.content && typeof baseline.content === 'object' && typeof candidate.content === 'object') {
    projected.content = Object.fromEntries(Object.entries(candidate.content).filter(([media]) => Object.hasOwn(baseline.content, media)));
  }
  for (const [key, value] of Object.entries(projected)) {
    if (key === 'properties') continue;
    if (Object.hasOwn(baseline, key)) projected[key] = stripAdditiveOptionalProperties(baseline[key], value);
  }
  return projected;
}

export function findBreakingChanges(baseline, candidate) {
  const failures = [];

  function compare(label, baselineDocument, baselineValue, candidateDocument, candidateValue, optionalResponseHeaders = false) {
    const expandedBaseline = expandLocalRefs(baselineDocument, baselineValue);
    let expandedCandidate = expandLocalRefs(candidateDocument, candidateValue);
    // ADR-0015 permits additive optional response headers. Existing headers
    // and required additions still participate in the compatibility check.
    if (optionalResponseHeaders && expandedCandidate?.headers) {
      const headers = Object.fromEntries(Object.entries(expandedCandidate.headers).filter(([name, header]) =>
        Object.hasOwn(expandedBaseline.headers ?? {}, name) || header.required === true));
      expandedCandidate = { ...expandedCandidate, headers };
      if (!expandedBaseline.headers && Object.keys(headers).length === 0) delete expandedCandidate.headers;
    }
    const compatibleCandidate = stripAdditiveOptionalProperties(expandedBaseline, expandedCandidate);
    if (semantic(baselineDocument, expandedBaseline) !== semantic(candidateDocument, compatibleCandidate)) {
      failures.push(`${label} changed`);
    }
  }

  for (const [route, baselinePath] of Object.entries(baseline.paths ?? {})) {
    const candidatePath = candidate.paths?.[route];
    if (!candidatePath) {
      failures.push(`Path removed: ${route}`);
      continue;
    }
    for (const [method, baselineOperation] of Object.entries(baselinePath)) {
      if (!methods.has(method)) continue;
      const label = `${method.toUpperCase()} ${route}`;
      const candidateOperation = candidatePath[method];
      if (!candidateOperation) {
        failures.push(`Method removed: ${label}`);
        continue;
      }
      if (baselineOperation.operationId !== candidateOperation.operationId) {
        failures.push(`${label} operationId changed`);
      }
      // Security is additive-compatible: every baseline requirement alternative
      // must still be satisfiable in the candidate. Adding another OR
      // alternative (e.g. productBearer alongside cookieAuth) never breaks an
      // old client; removing or rewriting one does.
      const baselineSecurity = baselineOperation.security ?? baseline.security ?? [];
      const candidateSecurity = candidateOperation.security ?? candidate.security ?? [];
      const allowsAnonymous = (security) => security.length === 0
        || security.some((alternative) => alternative !== null && typeof alternative === 'object' && Object.keys(alternative).length === 0);
      const securityCompatible = baselineSecurity.every((alternative) =>
        candidateSecurity.some((candidateAlternative) =>
          semantic(baseline, expandLocalRefs(baseline, alternative))
            === semantic(candidate, expandLocalRefs(candidate, candidateAlternative))))
        && (!allowsAnonymous(baselineSecurity) || allowsAnonymous(candidateSecurity));
      if (!securityCompatible) failures.push(`${label} security changed`);
      compare(`${label} parameters`, baseline, [...(baselinePath.parameters ?? []), ...(baselineOperation.parameters ?? [])], candidate, [...(candidatePath.parameters ?? []), ...(candidateOperation.parameters ?? [])]);
      compare(`${label} request body`, baseline, baselineOperation.requestBody ?? null, candidate, candidateOperation.requestBody ?? null);

      const baselineStatuses = Object.keys(baselineOperation.responses ?? {}).sort();
      const candidateStatuses = new Set(Object.keys(candidateOperation.responses ?? {}));
      if (baselineStatuses.some((status) => !candidateStatuses.has(status))) {
        failures.push(`${label} response status removed`);
      }
      for (const status of baselineStatuses) {
        if (candidateOperation.responses?.[status] === undefined) continue;
        compare(`${label} response ${status}`, baseline, baselineOperation.responses[status], candidate, candidateOperation.responses[status], true);
      }
    }
  }

  for (const [name, baselineSchema] of Object.entries(baseline.components?.schemas ?? {})) {
    const candidateSchema = candidate.components?.schemas?.[name];
    if (!candidateSchema) {
      failures.push(`Component schema removed: ${name}`);
    } else {
      compare(`Component schema ${name}`, baseline, baselineSchema, candidate, candidateSchema);
    }
  }

  for (const [name, baselineScheme] of Object.entries(baseline.components?.securitySchemes ?? {})) {
    const candidateScheme = candidate.components?.securitySchemes?.[name];
    if (!candidateScheme) {
      failures.push(`Security scheme removed: ${name}`);
    } else {
      compare(`Security scheme ${name}`, baseline, baselineScheme, candidate, candidateScheme);
    }
  }

  return failures;
}

function option(name, fallback, args) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function runCli(args = process.argv.slice(2)) {
  const candidateFile = option('--candidate', 'generated/openapi/product-v1.bundle.yaml', args);
  const candidate = await readDocument(candidateFile);
  const defaultBaseline = `openapi/baselines/product-v1.${candidate.info.version}.yaml`;
  const baselineFile = option('--baseline', defaultBaseline, args);
  const baseline = await readDocument(baselineFile);
  const failures = findBreakingChanges(baseline, candidate);
  if (failures.length > 0) {
    console.error(`Breaking Product OpenAPI changes detected:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`No breaking changes relative to ${baselineFile}.`);
  }
}

if (isMainModule()) {
  await runCli();
}
