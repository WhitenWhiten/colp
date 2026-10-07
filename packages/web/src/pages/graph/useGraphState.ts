import { useSearchParams } from 'react-router-dom'
import { useGraphEditAccess } from './useGraphEditAccess'
import { useMemo, useState } from 'react'
import { graphEdges, neighborsOf } from './relations'
import { flattenPublicCollection } from '../../lib/publicCollectionTree'
import { graphResourceKind, graphResources } from './resources'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { usePageMeta } from '../../lib/usePageMeta'
import { useGraphViewport } from './useGraphViewport'
import { useGraphSnapshot } from './useGraphSnapshot'
import {
  GRAPH_DENSE_COUNT,
  graphTooltipOffset,
  HEIGHT,
  layoutConnectedNodes,
  WIDTH,
} from './layout'

export function useGraphState(slug: string) {
  const { load, retry } = useGraphSnapshot(slug)
  const snapshot = load.status === 'ready' ? load.snapshot : null
  const collection = snapshot?.collection ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get('node') ?? ''
  const setActiveId = (id: string) => {
    setSearchParams((params) => { params.set('node', id); return params }, { replace: true })
    /* ≤639px the detail panel rides above the canvas (graph.css gives
       .graph-side order:-1), so a canvas tap updated it out of view. */
    if (window.matchMedia?.('(max-width: 639px)').matches) {
      document.querySelector('.graph-side')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
  }
  const includeRoot = activeId === collection?.rootNodeId
  // Flattening in the render body gave `resources` a fresh identity every
  // frame, so every effect and layout memo keyed on it re-ran on each hover,
  // pan and zoom — the whole radial layout was rebuilt on mouse move.
  const published = useMemo(() => (snapshot ? flattenPublicCollection(snapshot) : null), [snapshot])
  const resources = useMemo(() => graphResources(snapshot, includeRoot), [snapshot, includeRoot])

  const canEdit = useGraphEditAccess(snapshot)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | 'all'>('all')
  const [query, setQuery] = useState('')
  const [relationType, setRelationType] = useState('all')
  const [neighborhoodId, setNeighborhoodId] = useState<string | null>(null)
  const { zoom, setZoom, pan, resetView, canvasRef } = useGraphViewport(load.status === 'ready')

  const documentTitle =
    load.status === 'ready' && collection
      ? `${collection.title} connections`
      : load.status === 'unavailable'
        ? 'Collection unavailable'
        : load.status === 'error'
          ? 'Collection error'
          : 'Knowledge graph'
  useDocumentTitle(documentTitle)
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : load.status === 'ready' && collection && published
        ? { canonicalPath: `/c/${encodeURIComponent(collection.slug)}` }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  const types = useMemo(
    () => Array.from(new Set(resources.map((resource) => graphResourceKind(resource)))),
    [resources],
  )
  const primaryTypes = types.slice(0, 6)
  const extraTypes = types.slice(6)

  const resourceMap = useMemo(() => new Map(resources.map((resource) => [resource.node.id, resource])), [resources])
  const nodeIds = useMemo(() => new Set(resourceMap.keys()), [resourceMap])
  const allEdges = useMemo(() => graphEdges(snapshot?.relations ?? [], nodeIds), [snapshot, nodeIds])
  const relationTypes = useMemo(() => [...new Set(allEdges.map((edge) => edge.type))].sort(), [allEdges])
  const matchingEdges = useMemo(() => allEdges.filter((edge) => relationType === 'all' || edge.type === relationType), [allEdges, relationType])
  const relationNodeIds = useMemo(() => new Set(matchingEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId])), [matchingEdges])
  const neighborhood = useMemo(() => neighborsOf(neighborhoodId, matchingEdges), [neighborhoodId, matchingEdges])
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    return resources.filter((resource) => {
      if (neighborhoodId && !neighborhood.has(resource.node.id)) return false
      if (relationType !== 'all' && !relationNodeIds.has(resource.node.id)) return false
      if (typeFilter !== 'all' && graphResourceKind(resource) !== typeFilter) return false
      if (!q) return true
      return (
        resource.node.title.toLowerCase().includes(q) ||
        (resource.node.description ?? '').toLowerCase().includes(q) ||
        resource.host.toLowerCase().includes(q)
      )
    })
  }, [resources, typeFilter, query, neighborhoodId, neighborhood, relationType, relationNodeIds])

  const active = matching.find((resource) => resource.node.id === activeId) ?? matching[0]
  const selectedId = active?.node.id ?? ''
  // Bound SVG work, keeping every resource available through search and the paged list.
  const visible = useMemo(() => {
    const page = matching.slice(0, 200)
    if (active && !page.some((resource) => resource.node.id === active.node.id)) page[page.length - 1] = active
    return page
  }, [matching, active])
  const visibleIds = useMemo(() => new Set(visible.map((resource) => resource.node.id)), [visible])
  const matchingIds = useMemo(() => new Set(matching.map((resource) => resource.node.id)), [matching])
  const filteredEdges = useMemo(() => matchingEdges.filter((edge) => matchingIds.has(edge.fromNodeId) && matchingIds.has(edge.toNodeId)), [matchingEdges, matchingIds])
  const canvasEdges = useMemo(() => filteredEdges.filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId)), [filteredEdges, visibleIds])
  const edges = useMemo(() => canvasEdges.slice(0, 1000), [canvasEdges])
  const positions = useMemo(() => layoutConnectedNodes(visible, edges, WIDTH, HEIGHT), [visible, edges])
  const posMap = useMemo(() => Object.fromEntries(positions.map((point) => [point.id, point])), [positions])
  const dense = visible.length >= GRAPH_DENSE_COUNT
  const focusId = hoverId && visibleIds.has(hoverId) ? hoverId : selectedId
  const neighborIds = useMemo(() => neighborsOf(focusId, edges), [focusId, edges])
  const selectedEdges = useMemo(() => filteredEdges.filter((edge) => edge.fromNodeId === selectedId || edge.toNodeId === selectedId), [filteredEdges, selectedId])
  const connectedEdge = (from: string, to: string) => from === focusId || to === focusId

  const hoverResource = hoverId
    ? resourceMap.get(hoverId) ?? null
    : null
  const hoverPos = hoverId ? posMap[hoverId] : null

  const tooltipStyle = useMemo(() => {
    if (!hoverPos || !canvasRef.current) return null
    const rect = canvasRef.current.getBoundingClientRect()
    return graphTooltipOffset(hoverPos, pan, zoom, { width: rect.width, height: rect.height })
  }, [hoverPos, pan, zoom, canvasRef])

  const activeKind = active ? graphResourceKind(active) : ''

  return {
    load,
    canEdit,
    retry,
    collection,
    published,
    resources,
    visible,
    matching,
    resourceMap,
    relationType,
    setRelationType,
    relationTypes,
    neighborhoodId,
    setNeighborhoodId,
    filteredEdges,
    clearFilters: () => { setQuery(''); setTypeFilter('all'); setRelationType('all'); setNeighborhoodId(null) },
    positions,
    posMap,
    edges,
    active,
    activeKind,
    selectedId,
    setActiveId,
    hoverId,
    setHoverId,
    hoverResource,
    tooltipStyle,
    typeFilter,
    setTypeFilter,
    primaryTypes,
    extraTypes,
    query,
    setQuery,
    zoom,
    setZoom,
    pan,
    resetView,
    canvasRef,
    dense,
    focusId,
    neighborIds,
    selectedEdges,
    allEdges,
    connectedEdge,
  }
}

export type GraphState = ReturnType<typeof useGraphState>
