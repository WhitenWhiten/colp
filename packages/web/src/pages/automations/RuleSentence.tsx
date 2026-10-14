import type { AutomationRule } from '../../api/automationTypes'
import { ruleSentence, type SentencePart } from './copy'

/* The plain-language rule line (AU-01): the owner's own values carry the
   emphasis, the connecting words stay quiet. */

export function Sentence({ parts, className }: { parts: readonly SentencePart[]; className?: string }) {
  return (
    <p className={className ? `automation-sentence ${className}` : 'automation-sentence'} data-testid="automation-sentence">
      {parts.map((part, index) => part.term
        ? <span key={index} className="automation-term">{part.text}</span>
        : <span key={index}>{part.text}</span>)}
    </p>
  )
}

/** `folder`: the destination as the library has it now; `null` when it is gone, `undefined` while loading. */
export function RuleSentence({
  rule,
  collectionTitle,
  folder,
  className,
}: {
  rule: AutomationRule
  collectionTitle: string | null
  folder: { title: string } | null | undefined
  className?: string
}) {
  const names = { collection: collectionTitle, folder: folder?.title ?? null, folderGone: folder === null }
  return <Sentence className={className} parts={ruleSentence(rule.definition, names)} />
}
