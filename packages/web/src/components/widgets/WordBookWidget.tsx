import { useEffect, useId, useMemo, useState } from 'react'
import { Icon } from '../Icon'
import { useDeskStorage } from '../../lib/useDeskStorage'

type Mastery = 0 | 1 | 2
type WordItem = { id: string; term: string; meaning: string; mastery: Mastery }
type WordBookState = { words: WordItem[]; activeId: string | null }

const SEED_WORDS: WordItem[] = [
  { id: 'seed-affordance', term: 'affordance', meaning: 'A cue in an object that suggests how to use it', mastery: 1 },
  { id: 'seed-provenance', term: 'provenance', meaning: 'Origin, custody, and chain of record', mastery: 0 },
  { id: 'seed-synthesis', term: 'synthesis', meaning: 'Combining several ideas into one conclusion', mastery: 0 },
  { id: 'seed-serendipity', term: 'serendipity', meaning: 'Finding something valuable by accident', mastery: 2 },
]

function storageKey(id: string) { return `known.desk.wordbook.${id}.v1` }
function newId() { return `word-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` }
function initialState(): WordBookState { return { words: SEED_WORDS, activeId: SEED_WORDS[0]?.id ?? null } }

function normalizeState(stored: unknown): WordBookState {
  const parsed = stored as Partial<WordBookState>
  const words = Array.isArray(parsed.words)
    ? parsed.words.filter((word): word is WordItem => Boolean(word) && typeof word.id === 'string' && typeof word.term === 'string' && typeof word.meaning === 'string')
        .map((word) => ({ ...word, mastery: ([0, 1, 2].includes(Number(word.mastery)) ? Number(word.mastery) : 0) as Mastery }))
    : []
  const activeId = words.some((word) => word.id === parsed.activeId) ? (parsed.activeId as string) : words[0]?.id ?? null
  return { words, activeId }
}

export function WordBookWidget({ resourceId }: { resourceId: string }) {
  const formId = useId()
  const { value: state, update } = useDeskStorage<WordBookState>({
    storageKey: storageKey(resourceId),
    fallback: initialState,
    normalize: normalizeState,
  })
  const [mode, setMode] = useState<'review' | 'list'>('review')
  const [revealed, setRevealed] = useState(false)
  const [term, setTerm] = useState('')
  const [meaning, setMeaning] = useState('')

  useEffect(() => {
    setMode('review'); setRevealed(false); setTerm(''); setMeaning('')
  }, [resourceId])

  const active = state.words.find((word) => word.id === state.activeId) ?? state.words[0]
  const learningCount = state.words.filter((word) => word.mastery < 2).length
  const knownCount = state.words.filter((word) => word.mastery === 2).length
  const orderedWords = useMemo(() => [...state.words].sort((a, b) => a.mastery - b.mastery || a.term.localeCompare(b.term)), [state.words])

  const moveNext = (mastery: Mastery) => {
    if (!active) return
    update((prev) => {
      const words = prev.words.map((word) => word.id === active.id ? { ...word, mastery } : word)
      const currentIndex = words.findIndex((word) => word.id === active.id)
      const activeId = words.length > 1 ? words[(currentIndex + 1) % words.length]?.id ?? active.id : active.id
      return { words, activeId }
    })
    setRevealed(false)
  }

  const addWord = () => {
    const cleanTerm = term.trim(); const cleanMeaning = meaning.trim()
    if (!cleanTerm || !cleanMeaning) return
    const word: WordItem = { id: newId(), term: cleanTerm, meaning: cleanMeaning, mastery: 0 }
    update((prev) => ({ words: [word, ...prev.words], activeId: word.id }))
    setTerm(''); setMeaning(''); setMode('review'); setRevealed(false)
  }

  return (
    <div className="desk-widget desk-wordbook">
      <div className="desk-widget-head desk-wordbook-head">
        <div><strong>{learningCount} learning</strong><span>{knownCount} known · {state.words.length} total</span></div>
        <div className="desk-wordbook-tabs" role="group" aria-label="Word book view">
          <button type="button" aria-pressed={mode === 'review'} onClick={() => setMode('review')}>Review</button>
          <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>Words</button>
        </div>
      </div>

      {mode === 'review' ? (
        <div className="desk-word-review">
          {active ? <>
            <button type="button" className={`desk-word-card ${revealed ? 'is-revealed' : ''}`} onClick={() => setRevealed((value) => !value)} aria-label={revealed ? `${active.term}: ${active.meaning}` : `${active.term}. Reveal meaning`}>
              <span className="desk-word-kicker">{revealed ? 'Meaning' : 'Tap to reveal'}</span>
              <strong>{active.term}</strong>
              <p>{revealed ? active.meaning : '••••••••'}</p>
            </button>
            <div className="desk-word-ratings" aria-label="Rate this word">
              <button type="button" onClick={() => moveNext(0)}><i className="is-new" aria-hidden /> Again</button>
              <button type="button" onClick={() => moveNext(1)}><i className="is-learning" aria-hidden /> Learning</button>
              <button type="button" onClick={() => moveNext(2)}><i className="is-known" aria-hidden /> Known</button>
            </div>
          </> : (
            <div className="desk-word-empty"><strong>Your word book is empty</strong><p>Add a word and its meaning to start reviewing.</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('list')}>Add a word</button></div>
          )}
        </div>
      ) : (
        <div className="desk-word-list-view">
          <form className="desk-word-add" onSubmit={(event) => { event.preventDefault(); addWord() }}>
            <label htmlFor={`${formId}-term`}><span>Word</span><input id={`${formId}-term`} value={term} placeholder="e.g. deliberate" onChange={(event) => setTerm(event.target.value)} /></label>
            <label htmlFor={`${formId}-meaning`}><span>Meaning</span><input id={`${formId}-meaning`} value={meaning} placeholder="Definition or example" onChange={(event) => setMeaning(event.target.value)} /></label>
            <button type="submit" disabled={!term.trim() || !meaning.trim()} aria-label="Add word"><Icon name="plus" /></button>
          </form>
          <ul className="desk-word-list" aria-label="Saved words">
            {orderedWords.map((word) => (
              <li key={word.id}>
                <button type="button" className="desk-word-open" onClick={() => { update((prev) => ({ ...prev, activeId: word.id })); setMode('review'); setRevealed(false) }}>
                  <i className={`mastery-${word.mastery}`} aria-hidden /><span><strong>{word.term}</strong><small>{word.meaning}</small></span>
                </button>
                <button type="button" className="desk-word-remove" aria-label={`Remove ${word.term}`} onClick={() => update((prev) => { const words = prev.words.filter((item) => item.id !== word.id); return { words, activeId: prev.activeId === word.id ? words[0]?.id ?? null : prev.activeId } })}><Icon name="cross" /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
