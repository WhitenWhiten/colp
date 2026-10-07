/* Community write fields cap their text in Unicode code points (comment
   bodies at 4000, curation/lock reasons at 1000). Each caller counts with the
   spread iterator so astral characters count once; this renders the shared
   live `count/max` badge, danger-tinted once over. */
export function CommunityCharCounter({ count, max, testId }: {
  readonly count: number
  readonly max: number
  readonly testId: string
}) {
  const over = count > max
  return (
    <span
      className={`community-comments-counter${over ? ' community-comments-counter--over' : ''}`}
      data-testid={testId}
    >
      {count}/{max}
    </span>
  )
}
