import { useMemo, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { tagKey, type TagCount } from '../lib/libraryTags'

/** Node tag limits the API enforces (64 tags, 64 characters each). */
export const TAG_LIMITS = { count: 64, length: 64 } as const
const MAX_SUGGESTIONS = 5

/** Trim, drop a leading '#', and cap the length; empty input is no tag. */
export function cleanTag(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim().replace(/^#+\s*/u, '').slice(0, TAG_LIMITS.length).trim()
}

/**
 * Adds typed or picked tags to `tags`. A tag that matches an existing one
 * case-insensitively is skipped, and a match in the vocabulary takes the
 * vocabulary's spelling, so one tag never splits into "Rust" and "rust".
 */
export function addTags(tags: readonly string[], raws: readonly string[], vocabulary: readonly TagCount[] = []): string[] {
  const next = [...tags]
  for (const raw of raws) {
    const clean = cleanTag(raw)
    if (!clean || next.length >= TAG_LIMITS.count || next.some((tag) => tagKey(tag) === tagKey(clean))) continue
    next.push(vocabulary.find(({ tag }) => tagKey(tag) === tagKey(clean))?.tag ?? clean)
  }
  return next
}

type Props = {
  id: string
  tags: readonly string[]
  onTagsChange: (tags: string[]) => void
  /** Text typed but not yet a chip; the owner commits it on save. */
  draft: string
  onDraftChange: (draft: string) => void
  /** Tags used elsewhere, offered while typing. */
  vocabulary?: readonly TagCount[]
  disabled?: boolean
  placeholder?: string
}

/**
 * Chips inline with a text input, like the extension's tag field. Enter,
 * comma or Tab commits the typed tag; Backspace on an empty input removes the
 * last chip; pasting "a, b" adds both. While typing, up to five matching tags
 * from the vocabulary are offered under the field.
 */
export function TagInput({ id, tags, onTagsChange, draft, onDraftChange, vocabulary = [], disabled = false, placeholder = 'Add tags…' }: Props) {
  const typed = cleanTag(draft)
  const suggestions = useMemo(() => {
    const needle = tagKey(typed)
    if (!needle) return []
    const chosen = new Set(tags.map(tagKey))
    return vocabulary
      .filter(({ tag }) => !chosen.has(tagKey(tag)) && tagKey(tag).includes(needle) && tagKey(tag) !== needle)
      .sort((a, b) => Number(tagKey(b.tag).startsWith(needle)) - Number(tagKey(a.tag).startsWith(needle)))
      .slice(0, MAX_SUGGESTIONS)
  }, [tags, typed, vocabulary])

  const commit = (raws: readonly string[], rest = '') => {
    const next = addTags(tags, raws, vocabulary)
    if (next.length !== tags.length) onTagsChange(next)
    onDraftChange(rest)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' || event.key === ',' || (event.key === 'Tab' && !event.shiftKey && typed)) {
      if (!typed && event.key !== ',') return
      event.preventDefault()
      commit([draft])
    } else if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
      event.preventDefault()
      onTagsChange(tags.slice(0, -1))
    }
  }

  const onChange = (value: string) => {
    // A comma from an input method or autofill splits like a typed one.
    if (!value.includes(',')) { onDraftChange(value); return }
    const parts = value.split(',')
    commit(parts.slice(0, -1), parts.at(-1) ?? '')
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!/[,\n\r]/u.test(text)) return
    event.preventDefault()
    const parts = `${draft}${text}`.split(/[,\n\r]+/u)
    commit(parts.slice(0, -1), parts.at(-1) ?? '')
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer convenience only: the input inside is the keyboard target */}
      <div
        className="tag-input"
        data-disabled={disabled || undefined}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.querySelector('input')?.focus()
        }}
      >
        {tags.map((tag) => (
          <span className="tag-input-chip" key={tag} data-testid="tag-chip">
            <span className="tag-input-chip-label">{tag}</span>
            {!disabled && (
              <button
                type="button"
                className="tag-input-chip-remove"
                aria-label={`Remove tag ${tag}`}
                onClick={() => onTagsChange(tags.filter((value) => value !== tag))}
              >
                <Icon name="cross" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled}
          maxLength={TAG_LIMITS.length + 1}
          placeholder={tags.length ? '' : placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (typed) commit([draft]) }}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="tag-input-suggest" role="group" aria-label="Suggested tags">
          {suggestions.map(({ tag, count }) => (
            <button
              type="button"
              key={tag}
              className="tag-input-suggestion"
              aria-label={`Add tag ${tag}`}
              title={`${tag} · ${count}`}
              // Keep focus in the field: a mousedown here must not blur the input first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit([tag])}
            >
              <Icon name="plus" />
              {tag}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
