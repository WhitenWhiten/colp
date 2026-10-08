/**
 * Frozen copy of Known-Backend `MCP_COMPAT_INITIALIZE_INSTRUCTIONS`.
 * T-10 public workflow copy must include this exact string so docs cannot drift.
 */
export const MCP_COMPAT_INITIALIZE_INSTRUCTIONS = [
  'Create a library: collections.create (title).',
  'Save folders/bookmarks with nodes.create (collectionId, node.kind/title; bookmarks need node.url).',
  'Do not call changes.plan to save links.',
  'Parent defaults to root. dryRun:true or confirmApply:false previews without writing; omit both to apply.',
  'changes.plan dryRun:true stores a pending plan; open approvalUri then changes.commit.',
  'Collection public uses collections.get revision, not a node fence.',
  'Do not send elicitation, sampling, requestState, or inputResponses.',
].join(' ')
