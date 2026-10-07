import mcpMarkdown from '../../content/agent-public/mcp.md?raw'
import { TrustDocument } from './TrustDocument'

export function Mcp() {
  return (
    <TrustDocument
      markdown={mcpMarkdown}
      eyebrow="Agents"
      documentTitle="MCP"
    />
  )
}
