import { useEffect, useId, useRef, useState } from 'react'
import { useDeskStorage } from '../../lib/useDeskStorage'
import { Icon } from '../Icon'

type ModelId = 'gpt-5-mini' | 'claude-sonnet' | 'gemini-flash'
type ScopeId = 'followed' | 'library' | 'interface'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources?: string[]
}

type ChatState = {
  model: ModelId
  scope: ScopeId
  messages: ChatMessage[]
}

const DEFAULT_MODEL: { id: ModelId; label: string; note: string } = { id: 'gpt-5-mini', label: 'GPT-5 mini', note: 'Fast' }
const MODELS: Array<{ id: ModelId; label: string; note: string }> = [
  { id: 'gpt-5-mini', label: 'GPT-5 mini', note: 'Fast' },
  { id: 'claude-sonnet', label: 'Claude Sonnet', note: 'Deep' },
  { id: 'gemini-flash', label: 'Gemini Flash', note: 'Wide context' },
]

const SCOPES: Array<{ id: ScopeId; label: string }> = [
  { id: 'followed', label: 'Followed' },
  { id: 'library', label: 'Library' },
  { id: 'interface', label: 'Interface Systems' },
]

/* Only the user bubble is styled differently; assistant is the default. */
const ROLE_CLASS = { user: 'desk-ai-message is-user', assistant: 'desk-ai-message' } as const

const STARTERS = [
  'What should I read next?',
  'Summarize this week',
  'Find related notes',
]

function storageKey(id: string) {
  return `known.desk.ai-chat.${id}.v1`
}

function messageId() {
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function initialState(): ChatState {
  return {
    model: 'gpt-5-mini',
    scope: 'followed',
    messages: [
      {
        id: messageId(),
        role: 'assistant',
        text: 'Ask me to connect ideas, summarize updates, or plan what to read next.',
        sources: ['Interface Systems', 'ML Ops Field Notes'],
      },
    ],
  }
}

function normalizeState(stored: unknown): ChatState {
  const parsed = stored as Partial<ChatState>
  const model = MODELS.some((item) => item.id === parsed.model)
    ? (parsed.model as ModelId)
    : 'gpt-5-mini'
  const scope = SCOPES.some((item) => item.id === parsed.scope)
    ? (parsed.scope as ScopeId)
    : 'followed'
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages
        .filter(
          (item): item is ChatMessage =>
            Boolean(item) &&
            typeof item.id === 'string' &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.text === 'string',
        )
        .slice(-24)
    : []
  return { model, scope, messages: messages.length ? messages : initialState().messages }
}

function makeReply(text: string, scope: ScopeId, model: ModelId): ChatMessage {
  const lower = text.toLowerCase()
  const modelName = MODELS.find((item) => item.id === model)?.label ?? 'Know-N AI'
  const scopeName = SCOPES.find((item) => item.id === scope)?.label ?? 'your library'

  if (lower.includes('next') || lower.includes('read')) {
    return {
      id: messageId(),
      role: 'assistant',
      text: `Start with “Suggested reading path”, then open the Radix primitives notes. ${modelName} ranked them by dependency and your recent activity in ${scopeName}.`,
      sources: ['Reading path', 'Radix primitives', 'Bret Victor'],
    }
  }
  if (lower.includes('summar') || lower.includes('week')) {
    return {
      id: messageId(),
      role: 'assistant',
      text: `Three useful changes in ${scopeName}: Interface Systems moved to stage 2, an observability checklist was pinned, and two notes now share an editorial-layout theme.`,
      sources: ['Interface Systems', 'ML Ops Field Notes', 'Feed'],
    }
  }
  if (lower.includes('related') || lower.includes('connect') || lower.includes('note')) {
    return {
      id: messageId(),
      role: 'assistant',
      text: 'I found a strong bridge between component primitives, progressive disclosure, and research-path sequencing. Group those notes under “Interfaces that reveal state”.',
      sources: ['Primitives', 'Inventing on Principle', 'Editorial layout'],
    }
  }
  return {
    id: messageId(),
    role: 'assistant',
    text: `Using ${modelName} across ${scopeName}, I would treat “${text.trim()}” as a research-path question. Pick one anchor source, then compare two opposing notes before saving a conclusion.`,
    sources: ['Library', 'Graph', 'Reading path'],
  }
}

export function AiChatWidget({ resourceId }: { resourceId: string }) {
  const inputId = useId()
  const { value: state, update } = useDeskStorage<ChatState>({
    storageKey: storageKey(resourceId),
    fallback: initialState,
    normalize: normalizeState,
  })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    setDraft('')
    setBusy(false)
  }, [resourceId])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const scrollToEnd = () => {
    window.requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
  }

  const send = (value: string) => {
    const text = value.trim()
    if (!text || busy) return
    const snapshot = state
    update((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        { id: messageId(), role: 'user' as const, text },
      ].slice(-24),
    }))
    setDraft('')
    setBusy(true)
    scrollToEnd()
    timerRef.current = window.setTimeout(() => {
      update((prev) => ({
        ...prev,
        messages: [...prev.messages, makeReply(text, snapshot.scope, snapshot.model)].slice(-24),
      }))
      setBusy(false)
      scrollToEnd()
    }, 620)
  }

  const selectedModel = MODELS.find((item) => item.id === state.model) ?? DEFAULT_MODEL

  return (
    <div className="desk-widget desk-ai-chat">
      <div className="desk-ai-toolbar">
        <label className="desk-ai-model" htmlFor={`${inputId}-model`}>
          <span>Model</span>
          <select
            id={`${inputId}-model`}
            value={state.model}
            onChange={(event) => update((prev) => ({ ...prev, model: event.target.value as ModelId }))}
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.note}
              </option>
            ))}
          </select>
        </label>
        <span className="desk-ai-status" aria-label={`${selectedModel.label} ready`}>
          <i aria-hidden /> Ready
        </span>
      </div>

      <div className="desk-ai-scopes" role="group" aria-label="Knowledge scope">
        {SCOPES.map((scope) => (
          <button
            key={scope.id}
            type="button"
            aria-pressed={state.scope === scope.id}
            onClick={() => update((prev) => ({ ...prev, scope: scope.id }))}
          >
            {scope.label}
          </button>
        ))}
      </div>

      <div ref={logRef} className="desk-ai-log" aria-live="polite">
        {state.messages.map((message) => (
          <div key={message.id} className={ROLE_CLASS[message.role]}>
            <span className="desk-ai-role">{message.role === 'user' ? 'You' : selectedModel.label}</span>
            <p>{message.text}</p>
            {message.sources && message.sources.length > 0 && (
              <div className="desk-ai-sources" aria-label="Sources">
                {message.sources.map((source) => <span key={source}>{source}</span>)}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="desk-ai-message">
            <span className="desk-ai-role">{selectedModel.label}</span>
            <span className="desk-ai-dots" aria-label="Thinking"><i /><i /><i /></span>
          </div>
        )}
      </div>

      {state.messages.length <= 1 && (
        <div className="desk-ai-starters" aria-label="Suggested questions">
          {STARTERS.map((starter) => (
            <button key={starter} type="button" onClick={() => send(starter)}>{starter}</button>
          ))}
        </div>
      )}

      <form className="desk-ai-compose" onSubmit={(event) => { event.preventDefault(); send(draft) }}>
        <label className="visually-hidden" htmlFor={`${inputId}-message`}>Message Know-N AI</label>
        <textarea
          id={`${inputId}-message`}
          rows={1}
          value={draft}
          placeholder="Ask your knowledge base…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send(draft)
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="Send message">
          <Icon name="send" />
        </button>
      </form>
    </div>
  )
}
