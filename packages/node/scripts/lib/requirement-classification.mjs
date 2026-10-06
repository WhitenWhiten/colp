function sectionIs(section, prefix) {
  return section === prefix || section?.startsWith(`${prefix}.`) === true;
}

export function classifyRequirementOccurrence(occurrence) {
  const { source, section, quote } = occurrence;
  if (source === 'SPECIFICATION.md') {
    if (sectionIs(section, '3.2')) return ['sync', 'SYNC'];
    if (sectionIs(section, '3.3')) return ['feed', 'FEED'];
    if (sectionIs(section, '7') || sectionIs(section, '8') || sectionIs(section, '10')) {
      return ['publication', 'PUB'];
    }
    if (sectionIs(section, '9')) {
      return /修改已有资源|If-Match|Precondition|重试型 POST|Idempotency Key/u.test(quote)
        ? ['publisher', 'PUBLISH']
        : ['publication', 'PUB'];
    }
    if (sectionIs(section, '12')) return ['publication', 'PUB'];
    return ['core', 'CORE'];
  }
  if (source.endsWith('/00-practical-profile.md')) return ['core', 'CORE'];
  if (source.endsWith('/01-core-data-model.md')) return ['core', 'CORE'];
  if (source.endsWith('/02-http-publication-feed.md')) {
    return ['6', '7', '8', '9', '10', '11'].some((candidate) => sectionIs(section, candidate))
      ? ['feed', 'FEED']
      : ['publication', 'PUB'];
  }
  if (source.endsWith('/03-sync.md') || source.endsWith('/06-browser-mapping.md')) {
    return ['sync', 'SYNC'];
  }
  if (source.endsWith('/04-auth-security-rate-limit.md')) return ['publisher', 'SEC'];
  if (source.endsWith('/05-mcp-profile.md')) {
    return ['11', '12', '13', '14', '15'].some((candidate) => sectionIs(section, candidate))
      ? ['mcp-write', 'MCP']
      : ['mcp-read', 'MCP'];
  }
  if (source.endsWith('/07-nestjs-integration.md') || source.endsWith('/08-write-api.md')) {
    return ['publisher', 'PUBLISH'];
  }
  if (source.endsWith('/09-problem-registry.md')) return ['publication', 'PUB'];
  if (source.endsWith('/10-implementation-contract.md') && sectionIs(section, '5')) {
    return ['mcp-read', 'MCP'];
  }
  if (source.endsWith('/10-implementation-contract.md')) return ['core', 'CORE'];
  throw new Error(`No profile rule for ${source} section ${section ?? 'unknown'}`);
}
