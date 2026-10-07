import { relationLabel } from './relations'
import { useState } from 'react'
import { FilterRail } from '../../components/FilterRail'
import type { GraphState } from './useGraphState'

export function GraphToolbar({ state }: { state: GraphState }) {
  const {
    query,
    setQuery,
    typeFilter,
    setTypeFilter,
    primaryTypes,
    extraTypes,
  } = state
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div className="graph-toolbar">
      <label className="search-field graph-search">
        <span className="visually-hidden">Search nodes</span>
        <input
          type="search"
          placeholder="Search nodes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <FilterRail
        className="graph-type-filters"
        optionsClassName="graph-type-chip-row"
        optionsTestId="graph-type-chip-row"
        label="Type filter"
        value={typeFilter}
        options={[
          { value: 'all' as const, label: 'All' },
          ...primaryTypes.map((kind) => ({ value: kind, label: kind })),
        ]}
        onChange={setTypeFilter}
      >
        {extraTypes.length > 0 && (
          /* Deliberate native <details>: this overflow trades the full
             anchored-menu contract for zero JS — an acceptable tradeoff for a
             secondary chip overflow. */
          <details
            className="graph-more-types"
            data-testid="graph-more-types"
            onToggle={(event) => setMoreOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="filter-btn" aria-expanded={moreOpen}>More types</summary>
            <div className="graph-more-panel">
              {extraTypes.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="filter-btn"
                  role="radio"
                  aria-checked={typeFilter === kind}
                  onClick={() => setTypeFilter(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
          </details>
        )}
      </FilterRail>
      <div className="field"><label htmlFor="graph-relation-type">Relation type</label>
        <select id="graph-relation-type" aria-label="Relation type filter" value={state.relationType} onChange={(event) => state.setRelationType(event.target.value)}>
          <option value="all">All relations</option>
          {state.relationTypes.map((type) => <option key={type} value={type}>{relationLabel(type)}</option>)}
        </select>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!state.selectedId && !state.neighborhoodId}
        aria-pressed={state.neighborhoodId !== null}
        onClick={() => state.setNeighborhoodId(state.neighborhoodId ? null : state.selectedId)}>
        {state.neighborhoodId ? 'Show all neighborhoods' : 'Focus neighborhood'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={state.clearFilters}>Clear filters</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={state.retry}>Refresh graph</button>
    </div>
  )
}
