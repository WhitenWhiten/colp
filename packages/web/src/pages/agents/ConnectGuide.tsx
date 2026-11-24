import type { ReactNode } from 'react'
import type { AgentConnectCopy } from '../../api/agentsClient'
import { CommandBlock } from '../../components/CommandBlock'
import { CopyField } from '../../components/CopyField'
import { Icon } from '../../components/Icon'
import { TabList } from '../../components/TabList'

export type ConnectClient = 'claude' | 'codex' | 'other' | 'key' | 'worker'

const CLIENTS: ReadonlyArray<{ id: ConnectClient; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other clients' },
  { id: 'key', label: 'API key' },
]

const WORKER_CLIENT = { id: 'worker' as const, label: 'Developer setup' }

/** The reference polling worker (docs/automation/agents.md), pointed at this server. */
function workerCommand(origin: string): string {
  return [
    `export COLP_ORIGIN=${origin}`,
    'export COLP_TARGET_ID=your_target_id',
    'export COLP_ADAPTER=examples/worker-script/deterministic-summary.mjs',
    'export COLP_JOURNAL=/private/worker-state/summary.json',
    '# Also set COLP_ACCESS_TOKEN from your secret manager and, for the',
    '# first run only, the pairing settings shown by Add and pair.',
    'node examples/worker-script/claim-and-summarize.mjs',
  ].join('\n')
}

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
  client: chosen,
  onClientChange,
  automationOrigin,
}: {
  connect: AgentConnectCopy
  keyPanel: ReactNode
  /** The open tab. The page owns it, so the worker section can open the worker steps. */
  client: ConnectClient
  onClientChange: (client: ConnectClient) => void
  /** This server's address, where it has automations; adds the worker tab. */
  automationOrigin?: string
}) {
  const clients = automationOrigin ? [...CLIENTS, WORKER_CLIENT] : CLIENTS
  const client = chosen === 'worker' && !automationOrigin ? 'claude' : chosen
  return (
    <div className="agents-connect">
      <TabList
        label="Client"
        className="view-switch agents-tabs"
        value={client}
        options={clients}
        tabIdFor={(id) => `agents-tab-${id}`}
        panelIdFor={(id) => `agents-panel-${id}`}
        onChange={(id) => onClientChange(id)}
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
              <p className="agents-note">Add as a remote MCP server (streamable HTTP):</p>
              <CopyField label="Compatibility endpoint" value={connect.compatUrl} />
              <details className="agents-example">
                <summary><Icon name="chevron-right" className="agents-example-chevron" />Using MCP 2026-07-28?</summary>
                <CopyField label="Strict endpoint" value={connect.strictUrl} />
              </details>
            </Step>
            <Step title="Sign in">
              <p className="agents-note">
                Start the client’s OAuth sign-in for this server (Connect, Sign in, or <code>/mcp auth</code>), then allow access in your browser.
              </p>
              <details className="agents-example">
                <summary><Icon name="chevron-right" className="agents-example-chevron" />Cloud clients, client IDs, or rule work</summary>
                <p className="agents-note">
                  Most clients register themselves. Cloud clients (claude.ai, ChatGPT) need this server at a public HTTPS address.
                  {automationOrigin ? <> Allow <strong>Do rule work</strong> on consent to pair automatically for automation rules.</> : null}
                </p>
                <p className="agents-note">
                  If a client asks for a <code>client_id</code>, register it with your callback as <code>REDIRECT_URI</code> and leave the secret blank:
                </p>
                <CommandBlock label="client registration command" command={connect.register} />
              </details>
            </Step>
            <Step title="Ask for a change">
              <p className="agents-note">
                Try “Move my design links into a Design folder.” The plan appears on Approvals for review.
              </p>
            </Step>
          </ol>
        )}
        {client === 'worker' && automationOrigin && (
          <div className="agents-worker-guide">
            <ol className="agents-steps">
              <Step title="Give it its own key">
                <p className="agents-note">
                  For scripts only — OAuth agents with “Do rule work” pair automatically. Create an API key on the <strong>API key</strong> tab (dedicated keys are required for restricted rules).
                </p>
              </Step>
              <Step title="Add and pair it">
                <p className="agents-note">
                  Open <strong>Developer automation connections</strong> above, click <strong>Add worker</strong>, pick the key under <strong>Runs as</strong>, and click <strong>Add and pair</strong>. Copy the one-time settings within 5 minutes.
                </p>
              </Step>
              <Step title="Run the worker">
                <CommandBlock label="reference worker command" command={workerCommand(automationOrigin)} />
                <p className="agents-note">
                  Checks every minute by default; add <code>--once</code> for a single pass.
                </p>
              </Step>
            </ol>
            <details className="agents-example">
              <summary><Icon name="chevron-right" className="agents-example-chevron" />Polling vs. hosted events</summary>
              <p className="agents-note">
                Polling workers run anywhere that can reach this server, including a home network; the worker’s first pairing confirms its credential. Event wake-ups need a public HTTPS address and a verified subscription — choosing events doesn’t make it active.
              </p>
            </details>
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
              <summary><Icon name="chevron-right" className="agents-example-chevron" />Show a curl example</summary>
              <CommandBlock label="curl example" command={connect.curl} />
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
