import { useEffect, useState, type MutableRefObject } from 'react'
import { isLive, isProductApiError, productClient } from '../../api'
import { useToast } from '../../components/AppToast'
import { addTags, TagInput } from '../../components/TagInput'
import { catalogLanguageOptions } from '../../lib/languages'

/** Commits pending tag/language edits; resolves false when the save failed. */
export type CatalogCommit = () => Promise<boolean>

export function CatalogFields({
  kind,
  resourceId,
  disabled,
  commitRef,
  onDirtyChange,
}: {
  kind: 'collection' | 'report'
  resourceId: string
  disabled?: boolean
  /** Folds the fields into the host form's own submit: no separate save
      button; the host calls the registered commit after its own save. */
  commitRef?: MutableRefObject<CatalogCommit | null>
  /** Host forms enable their own save while tags or language are edited. */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { success, error } = useToast()
  const enabled = isLive('contentGovernance')
  const [etag, setEtag] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [language, setLanguage] = useState('')
  const [saved, setSaved] = useState<{ tags: string[]; language: string }>({ tags: [], language: '' })
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(enabled)

  function applyCatalog(catalog: { tags: string[]; language?: string | null; revision: string }) {
    const next = { tags: [...catalog.tags], language: catalog.language ?? '' }
    setTags(next.tags)
    setDraft('')
    setLanguage(next.language)
    setSaved(next)
    setEtag(`"${catalog.revision}"`)
  }

  // Chips plus any typed-but-uncommitted tag: what a save would send.
  const pendingTags = draft.trim() ? addTags(tags, [draft]) : tags
  const dirty = pendingTags.join('\u0000') !== saved.tags.join('\u0000') || language !== saved.language

  useEffect(() => { onDirtyChange?.(available && dirty) }, [available, dirty, onDirtyChange])

  useEffect(() => {
    if (!commitRef) return
    commitRef.current = available ? saveCatalog : null
    return () => { commitRef.current = null }
  })

  useEffect(() => {
    if (!enabled || !resourceId) return
    const controller = new AbortController()
    const load = kind === 'collection'
      ? productClient.getCollectionCatalog(resourceId, { signal: controller.signal, maxRetries: 0 })
      : productClient.getReportCatalog(resourceId, { signal: controller.signal, maxRetries: 0 })
    void load.then((catalog) => {
      if (controller.signal.aborted) return
      applyCatalog(catalog)
      setAvailable(true)
    }).catch((err) => {
      if (!controller.signal.aborted && isProductApiError(err) && err.status === 404) setAvailable(false)
    })
    return () => controller.abort()
  }, [enabled, kind, resourceId])

  const saveCatalog = async (): Promise<boolean> => {
    // A host form disables the fields while its own save runs and then
    // commits; that busy flag is its own, not a reason to skip the catalog.
    if (!etag || busy || (disabled && !commitRef)) return false
    // In a host form an untouched catalog has nothing to commit.
    if (commitRef && !dirty) return true
    setBusy(true)
    try {
      const body = {
        tags: pendingTags,
        language: language.trim() === '' ? null : language.trim(),
      }
      const options = {
        intentId: productClient.mutationIntentKey(`${kind}-catalog`, productClient.newCommandId()),
        maxRetries: 0,
      }
      const catalog = kind === 'collection'
        ? await productClient.updateCollectionCatalog(resourceId, body, etag, options)
        : await productClient.updateReportCatalog(resourceId, body, etag, options)
      applyCatalog(catalog)
      // The host form already confirms its own save; one toast per commit.
      if (!commitRef) success('Catalog saved')
      return true
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'Catalog metadata could not be saved')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!available) return null

  const fields = (
    <>
      <div className="field">
        <label htmlFor={`${kind}-catalog-tags`}>Tags</label>
        <TagInput
          id={`${kind}-catalog-tags`}
          tags={tags}
          onTagsChange={setTags}
          draft={draft}
          onDraftChange={setDraft}
          disabled={disabled || busy}
          placeholder="Add tags…"
        />
      </div>
      <div className="field">
        <label htmlFor={`${kind}-catalog-language`}>Language</label>
        <select
          id={`${kind}-catalog-language`}
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          disabled={disabled || busy}
        >
          {catalogLanguageOptions(language).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    </>
  )
  const saveButton = (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={disabled || busy || !etag || !dirty}
      onClick={() => void saveCatalog()}
    >
      Save tags and language
    </button>
  )

  if (commitRef) return <>{fields}</>
  return (
    <div className="edit-form" data-testid={`${kind}-catalog-fields`}>
      {fields}
      {saveButton}
    </div>
  )
}
