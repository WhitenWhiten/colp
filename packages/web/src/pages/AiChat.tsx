import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { FilterRail } from '../components/FilterRail'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { aiChatSeed } from '../api/mock-data'

type Cite = { label: string; to: string }
type Msg = { role: 'user' | 'assistant'; text: string; cites?: Cite[] }

const starters = [
  'What should I read first in Interface Systems?',
  'Summarize my followed collections this week',
  'Which unfiled links look like a new folder?',
]

const contexts = [
  { id: 'all', label: 'All followed' },
  { id: 'interface', label: 'Interface Systems' },
  { id: 'ml', label: 'ML Ops Field Notes' },
  { id: 'library', label: 'My library' },
]

function replyFor(text: string, ctx: string): Msg {
  const t = text.toLowerCase()
  if (t.includes('first')) {
    return {
      role: 'assistant',
      text:
        'Start with the Suggested reading path card, then radix primitives, then the Bret Victor talk. That order builds vocabulary before case studies.',
      cites: [
        { label: 'Reading path', to: '/path/interface-systems' },
        { label: 'primitives', to: '/r/github' },
        { label: 'Inventing on Principle', to: '/r/youtube' },
      ],
    }
  }
  if (t.includes('folder') || t.includes('unfiled') || t.includes('unsorted')) {
    return {
      role: 'assistant',
      text: 'Three Unsorted links cluster around “editorial layout” — create that folder and leave low-confidence items private.',
      cites: [
        { label: 'Classify inbox', to: '/classify' },
        { label: 'AI organize', to: '/ai/organize' },
      ],
    }
  }
  if (t.includes('summar') || t.includes('week')) {
    return {
      role: 'assistant',
      text: 'This week: Interface Systems updated stage 2; Kai pinned an observability checklist; Lin opened member notes on Chinese Web History.',
      cites: [
        { label: 'Interface Systems', to: '/c/interface-systems' },
        { label: 'ML Ops Field Notes', to: '/c/ml-ops-field-notes' },
        { label: 'Feed', to: '/feed' },
      ],
    }
  }
  const scope =
    ctx === 'library'
      ? 'your private library notes'
      : ctx === 'ml'
        ? 'ML Ops Field Notes'
        : ctx === 'interface'
          ? 'Interface Systems'
          : 'collections you follow'
  return {
    role: 'assistant',
    text: `Based on ${scope}: treat “${text.trim()}” as a path question. Pin two sources to your dashboard and continue the guided path when you want sequence.`,
    cites: [
      { label: 'Path reader', to: '/path/interface-systems' },
      { label: 'Dashboard', to: '/demo/dashboard' },
      { label: 'Graph', to: '/graph/interface-systems' },
    ],
  }
}

export function AiChat() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      text: aiChatSeed[0]?.text ?? 'Ask about collections you follow.',
      cites: [
        { label: 'Interface Systems', to: '/c/interface-systems' },
        { label: 'Library', to: '/library' },
      ],
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [ctx, setCtx] = useState('all')
  const endRef = useRef<HTMLDivElement>(null)

  const send = (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    setMessages((m) => [...m, { role: 'user', text: t }])
    setInput('')
    setBusy(true)
    window.setTimeout(() => {
      setMessages((m) => [...m, replyFor(t, ctx)])
      setBusy(false)
      endRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }, 650)
  }

  return (
    <PageShell sections>
      <PageSection>
        <PageHead
          breadcrumb={
            <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'AI chat' }]} />
          }
          eyebrow="AI chat"
          title="Ask your collections"
          documentTitle="AI chat"
          lede="Answers include source chips you can open — grounded in followed paths and your library (static demo)."
        />
      </PageSection>

      <PageSection className="chat-layout">
        <FilterRail
          className="chat-ctx"
          variant="segments"
          label="Context scope"
          value={ctx}
          options={contexts.map((c) => ({ value: c.id, label: c.label, className: 'chip' }))}
          onChange={setCtx}
        />

        <div className="chat-starters">
          {starters.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>

        <div className="chat-log panel">
          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble chat-bubble--${m.role}`}>
              <span className="meta">{m.role === 'user' ? 'You' : 'Know-N AI'}</span>
              <p>{m.text}</p>
              {m.cites && m.cites.length > 0 && (
                <div className="chat-cites">
                  {m.cites.map((c) => (
                    <Link key={c.to + c.label} to={c.to} className="chip">
                      {c.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="chat-bubble chat-bubble--assistant">
              <span className="meta">Know-N AI</span>
              <p className="meta">Thinking…</p>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="chat-compose"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <div className="field">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about a collection or path…"
              aria-label="Message"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
        <p className="meta">
          Also try <Link to="/ai/organize">AI organize</Link> or the{' '}
          <Link to="/path/interface-systems">guided path</Link>.
        </p>
      </PageSection>
    </PageShell>
  )
}
