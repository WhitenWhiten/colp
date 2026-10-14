import { useEffect, useMemo, useRef, useState } from 'react'
import type { AutomationBindingSet, AutomationRule } from '../../api/automationTypes'
import { useAutomationDeps } from './shared'
import { destinationFolder } from './ruleDraft'
import type { CollectionFolders, FolderEntry } from './folders'

/* Current names for what rules point at. Bindings hold identities; the
   names come from the library as it is now, so a renamed folder shows its
   new name on the next load (AU-03). `undefined` means still loading;
   `null` means the folder or collection is not there any more. */

export type AutomationNames = {
  collectionTitle(id: string | undefined): string | null | undefined
  folder(collectionId: string, nodeId: string): FolderEntry | null | undefined
  ruleFolder(rule: AutomationRule): FolderEntry | null | undefined
  binding(id: string): AutomationBindingSet | undefined
  ruleName(id: string): string | undefined
}

const MAX_BINDING_PAGES = 10

export function useAutomationNames(rules: readonly AutomationRule[] | null): AutomationNames {
  const { api, folders } = useAutomationDeps()
  const [collections, setCollections] = useState<Map<string, string> | null>(null)
  const [bindings, setBindings] = useState<Map<string, AutomationBindingSet> | null>(null)
  const [trees, setTrees] = useState<Map<string, CollectionFolders | null>>(new Map())

  useEffect(() => {
    const controller = new AbortController()
    void folders.listCollections(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setCollections(new Map(items.map((item) => [item.id, item.title]))) })
      .catch(() => { if (!controller.signal.aborted) setCollections(new Map()) })
    return () => controller.abort()
  }, [folders])

  const bindingKey = rules ? [...new Set(rules.map((rule) => rule.bindingSetId))].sort().join(',') : null
  useEffect(() => {
    if (bindingKey === null) return
    const controller = new AbortController()
    void (async () => {
      const found = new Map<string, AutomationBindingSet>()
      let cursor: string | null = null
      for (let page = 0; page < MAX_BINDING_PAGES; page += 1) {
        const result = await api.listBindingSets(cursor, controller.signal)
        for (const item of result.items) found.set(item.id, item)
        cursor = result.nextCursor
        if (!cursor) break
      }
      if (!controller.signal.aborted) setBindings(found)
    })().catch(() => { if (!controller.signal.aborted) setBindings(new Map()) })
    return () => controller.abort()
  }, [api, bindingKey])

  const collectionIds = useMemo(() => {
    if (!rules || !bindings) return []
    const ids = new Set<string>()
    for (const rule of rules) {
      const folder = destinationFolder(rule.definition, bindings.get(rule.bindingSetId))
      if (folder) ids.add(folder.collectionId)
    }
    return [...ids].sort()
  }, [rules, bindings])

  // Each collection's tree is read once per page visit, however often the rule list changes.
  const requested = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    for (const id of collectionIds) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      void folders.loadFolders(id)
        .then((tree) => { if (mounted.current) setTrees((current) => new Map(current).set(id, tree)) })
        .catch(() => { if (mounted.current) setTrees((current) => new Map(current).set(id, null)) })
    }
  }, [collectionIds, folders])

  return useMemo<AutomationNames>(() => {
    const folder = (collectionId: string, nodeId: string) => {
      if (!trees.has(collectionId)) return undefined
      const tree = trees.get(collectionId)
      if (!tree) return null
      if (nodeId === tree.rootId) return { id: nodeId, title: 'Top level', path: 'Top level', depth: -1 }
      return tree.folders.find((entry) => entry.id === nodeId) ?? null
    }
    const names = new Map((rules ?? []).map((rule) => [rule.id, rule.definition.name]))
    return {
      collectionTitle: (id) => (id === undefined ? null : collections === null ? undefined : collections.get(id) ?? null),
      folder,
      ruleFolder: (rule) => {
        if (bindings === null) return undefined
        const ref = destinationFolder(rule.definition, bindings.get(rule.bindingSetId))
        return ref ? folder(ref.collectionId, ref.nodeId) : null
      },
      binding: (id) => bindings?.get(id),
      ruleName: (id) => names.get(id),
    }
  }, [bindings, collections, rules, trees])
}
