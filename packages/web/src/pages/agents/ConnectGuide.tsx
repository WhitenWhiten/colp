import { useState, type ReactNode } from 'react'
import type { AgentConnectCopy } from '../../api/agentsClient'
import { CommandBlock } from '../../components/CommandBlock'
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
          <ol className="agents-steps">
            <Step title="Add this server">
              <p className="agents-note">
                Add it as a remote MCP server (streamable HTTP). Most clients today want the compatibility endpoint:
              </p>
              <CommandBlock label="compatibility endpoint" command={connect.compatUrl} />
              <p className="agents-note">Clients on MCP 2026-07-28 can use the strict endpoint instead:</p>
              <CommandBlock label="strict endpoint" command={connect.strictUrl} />
            </Step>
            <Step title="Sign in">
              <p className="agents-note">
                Start the client’s OAuth sign-in for this server: an Authenticate, Connect or Sign in button, or a
                command such as <code>/mcp auth</code> in Gemini CLI. It opens this server in your browser. Sign in,
                then allow access on the consent page.
              </p>
              <p className="agents-note">
                Most clients register themselves, so there is no client ID or secret to paste. Clients that run in
                the cloud, such as claude.ai or ChatGPT connectors, reach this server over the internet and need its
                public HTTPS address.
              </p>
              <details className="agents-example">
                <summary>Client asks for a client ID?</summary>
                <p className="agents-note">
                  Register one. Put the callback address the client shows in place of <code>REDIRECT_URI</code>,
                  then paste the <code>client_id</code> it returns and leave the secret empty.
                </p>
                <CommandBlock label="client registration command" command={connect.register} />
              </details>
            </Step>
            <Step title="Ask for a change">
              <p className="agents-note">
                Try “Move my design links into a Design folder.” The plan shows up on Approvals for you to review.
              </p>
            </Step>
          </ol>
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
