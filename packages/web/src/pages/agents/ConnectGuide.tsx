import { useState, type ReactNode } from 'react'
import type { AgentConnectCopy } from '../../api/agentsClient'
import { CommandBlock } from '../../components/CommandBlock'
import { CopyField } from '../../components/CopyField'
import { TabList } from '../../components/TabList'

export type ConnectClient = 'claude' | 'codex' | 'other' | 'key'

const CLIENTS: ReadonlyArray<{ id: ConnectClient; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other clients' },
  { id: 'key', label: 'API key' },
]

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="agents-step">
      <h3>{title}</h3>
      {children}
    </li>
  )
}

/**
 * How to connect each kind of client, one tab per client. Every step is a
 * heading plus the one command it needs, so the page reads as a sequence
 * instead of a wall of prose. The API key tab hosts the issue form, which
 * the page owns because issuing reloads the agent list.
 */
export function ConnectGuide({
  connect,
  keyPanel,
  initialClient = 'claude',
}: {
  connect: AgentConnectCopy
  keyPanel: ReactNode
  initialClient?: ConnectClient
}) {
  const [client, setClient] = useState<ConnectClient>(initialClient)
  return (
    <div className="agents-connect">
      <TabList
        label="Client"
        className="view-switch agents-tabs"
        value={client}
        options={CLIENTS}
        tabIdFor={(id) => `agents-tab-${id}`}
        panelIdFor={(id) => `agents-panel-${id}`}
        onChange={(id) => setClient(id)}
        testId="agents-tabs"
      />
      <div
        className="agents-panel"
        role="tabpanel"
        id={`agents-panel-${client}`}
        aria-labelledby={`agents-tab-${client}`}
      >
        {client === 'claude' && (
          <ol className="agents-steps">
            <Step title="Add this server">
              <CommandBlock label="Claude Code add command" command={connect.claudeAdd} />
            </Step>
            <Step title="Sign in">
              <CommandBlock label="Claude Code login command" command={connect.claudeLogin} />
              <p className="agents-note">It opens this server in your browser. Sign in, then allow access on the consent page.</p>
            </Step>
            <Step title="Ask for a change">
              <p className="agents-note">
                Try “Move my design links into a Design folder.” The plan shows up on Approvals for you to review.
              </p>
            </Step>
          </ol>
        )}
        {client === 'codex' && (
          <ol className="agents-steps">
            <Step title="Add this server">
              <CommandBlock label="Codex add command" command={connect.codexAdd} />
            </Step>
            <Step title="Sign in">
              <CommandBlock label="Codex login command" command={connect.codexLogin} />
              <p className="agents-note">It opens this server in your browser. Sign in, then allow access on the consent page.</p>
            </Step>
            <Step title="Let it call tools">
              <p className="agents-note">
                For <code>codex exec</code>, also set <code>default_tools_approval_mode = &quot;approve&quot;</code> for
                this server in <code>~/.codex/config.toml</code>. Changes still wait on Approvals.
              </p>
            </Step>
          </ol>
        )}
        {client === 'other' && (
          <div className="agents-endpoints">
            <p className="agents-note">
              Any MCP client that speaks streamable HTTP and OAuth can connect. Most clients today want the
              compatibility endpoint; clients on MCP 2026-07-28 can use the strict one.
            </p>
            <CopyField label="Compatibility endpoint" value={connect.compatUrl} />
            <CopyField label="Strict endpoint (MCP 2026-07-28)" value={connect.strictUrl} />
          </div>
        )}
        {client === 'key' && (
          <div className="agents-key">
            <p className="agents-note">
              For a script that cannot sign in with OAuth. Name a key, copy it once, and trade it for an access
              token. Revoking the key stops the next call.
            </p>
            {keyPanel}
            <details className="agents-example">
              <summary>Show a curl example</summary>
              <CommandBlock label="curl example" command={connect.curl} />
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
