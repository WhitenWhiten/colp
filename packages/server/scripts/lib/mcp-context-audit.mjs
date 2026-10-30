/** Offline measurements. Characters/bytes are never represented as model tokens. */
export const TRACE_FORMAT = 'colp.mcp-context-trace/v1';
const inputKeys = ['name', 'description', 'inputSchema'];
const wireKeys = [...inputKeys, 'outputSchema', 'annotations'];
const project = (tool, keys) => Object.fromEntries(keys.filter(key => tool[key] !== undefined).map(key => [key, tool[key]]));

export function measureJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Expected a JSON value.');
  return { characters: json.length, utf8Bytes: Buffer.byteLength(json, 'utf8'), tokens: null };
}

export function readGeneratedContracts(source) {
  const marker = 'export const AUTOMATION_TOOL_CONTRACTS = ';
  const start = source.indexOf(marker);
  const end = source.indexOf(' as const;', start + marker.length);
  if (start < 0 || end < 0) throw new TypeError('Generated Automation contracts were not found.');
  const tools = JSON.parse(source.slice(start + marker.length, end));
  if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.inputSchema)) {
    throw new TypeError('Invalid generated Automation contracts.');
  }
  return tools;
}

export function auditCatalog(tools) {
  const summary = entries => ({
    toolCount: entries.length,
    inputDefinitions: measureJson(entries.map(tool => project(tool, inputKeys))),
    wireDefinitions: measureJson(entries.map(tool => project(tool, wireKeys))),
  });
  return {
    measurement: 'static-catalog',
    modelContextObserved: false,
    all: summary(tools),
    profiles: Object.fromEntries([...new Set(tools.map(tool => tool.profile))].sort().map(profile => [profile, summary(tools.filter(tool => tool.profile === profile))])),
    largestInputs: tools.map(tool => ({ name: tool.name, ...measureJson(tool.inputSchema) }))
      .sort((left, right) => right.utf8Bytes - left.utf8Bytes || left.name.localeCompare(right.name)).slice(0, 10),
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function optionalCount(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}
function optionalMeasurement(value, label) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array when observed.`);
  return { count: value.length, ...measureJson(value) };
}

/**
 * Only explicit host observations count as loaded definitions. A deferred API
 * request may declare the full catalog without injecting it into the model.
 * Raw prompts, schemas, tool arguments and results never appear in this report.
 */
export function auditTrace(trace) {
  if (!object(trace) || trace.format !== TRACE_FORMAT || !Array.isArray(trace.turns) || trace.turns.length > 10_000) {
    throw new TypeError(`Expected ${TRACE_FORMAT} with at most 10000 turns.`);
  }
  const turns = trace.turns.map((turn, index) => {
    if (!object(turn)) throw new TypeError(`Invalid turn ${index + 1}.`);
    if (turn.usage !== undefined && !object(turn.usage)) throw new TypeError('usage must be an object.');
    if (turn.completed !== undefined && typeof turn.completed !== 'boolean') throw new TypeError('completed must be a boolean.');
    const inputTokens = optionalCount(turn.usage?.inputTokens, 'inputTokens');
    const cachedInputTokens = optionalCount(turn.usage?.cachedInputTokens, 'cachedInputTokens');
    if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) {
      throw new TypeError('cachedInputTokens cannot exceed inputTokens.');
    }
    return {
      turn: index + 1,
      declaredTools: optionalMeasurement(turn.declaredTools, 'declaredTools'),
      initialVisibleDefinitions: optionalMeasurement(turn.initialVisibleDefinitions, 'initialVisibleDefinitions'),
      newlyLoadedDefinitions: optionalMeasurement(turn.newlyLoadedDefinitions, 'newlyLoadedDefinitions'),
      // This is a complete snapshot, not a sum of every previously loaded tool.
      activeDefinitions: optionalMeasurement(turn.activeDefinitions, 'activeDefinitions'),
      searchResults: optionalMeasurement(turn.searchResults, 'searchResults'),
      toolResults: optionalMeasurement(turn.toolResults, 'toolResults'),
      usage: { inputTokens, cachedInputTokens, outputTokens: optionalCount(turn.usage?.outputTokens, 'outputTokens') },
      observedDefinitionTokens: optionalCount(turn.observedDefinitionTokens, 'observedDefinitionTokens'),
      durationMs: optionalCount(turn.durationMs, 'durationMs'),
      argumentErrors: optionalCount(turn.argumentErrors, 'argumentErrors'),
      completed: turn.completed ?? null,
    };
  });
  return {
    measurement: 'host-trace',
    modelContextObserved: turns.some(turn => turn.initialVisibleDefinitions !== null || turn.activeDefinitions !== null),
    modelDefinitionTokensObserved: turns.some(turn => turn.observedDefinitionTokens !== null),
    turnCount: turns.length,
    turns,
  };
}
