import { relationLabel } from './relations'
import { useState } from 'react'
import { FilterRail } from '../../components/FilterRail'
import { Icon } from '../../components/Icon'
import { SelectMenu } from '../../components/SelectMenu'
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
        <Icon name="search" />
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
      <SelectMenu
        className="graph-relation-field"
        label="Relation type filter"
        prefix="Relation:"
        value={state.relationType}
        options={[
          { value: 'all', label: 'All relations' },
          ...state.relationTypes.map((type) => ({ value: type, label: relationLabel(type) })),
        ]}
        onChange={state.setRelationType}
      />
      <button type="button" className="btn btn-secondary btn-sm" disabled={!state.selectedId && !state.neighborhoodId}
        aria-pressed={state.neighborhoodId !== null}
        onClick={() => state.setNeighborhoodId(state.neighborhoodId ? null : state.selectedId)}>
        {state.neighborhoodId ? 'Show all neighborhoods' : 'Focus neighborhood'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!state.hasActiveFilters} onClick={state.clearFilters}>Clear filters</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={state.retry}>Refresh graph</button>
    </div>
  )
}
