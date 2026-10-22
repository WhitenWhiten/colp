import type { AutomationRuleDefinition, AutomationTaskType } from '../../api/automationTypes'

export const SIMPLE_TASKS = [
  { type: 'summary.generate', label: 'Generate a summary', contract: 'summary.sourced.v1', instruction: 'Summarize this bookmark using the allowed inputs. Cite sources and explain when the available text is insufficient.' },
  { type: 'tags.generate', label: 'Suggest tags', contract: 'tags.sourced.v1', instruction: 'Suggest a few useful tags supported by the allowed inputs. Preserve existing tags and cite your sources.' },
] as const

/** Preserve existing instructions and task metadata for every task the owner keeps. */
export function withAgentTasks(definition: AutomationRuleDefinition, selected: readonly AutomationTaskType[]): AutomationRuleDefinition {
  const executorRole = definition.tasks[0]?.executorRole ?? 'agent'
  const tasks = SIMPLE_TASKS.filter(option => selected.includes(option.type)).map<AutomationRuleDefinition['tasks'][number]>(option =>
    definition.tasks.find(task => task.type === option.type) ?? { id: option.type === 'summary.generate' ? 'summary' : 'tags',
      type: option.type, after: [], executorRole, required: true, outputContract: option.contract,
      inputFields: ['url', 'title', 'description', 'tags'], instruction: option.instruction })
  const summary = tasks.find(task => task.type === 'summary.generate')
  const tags = tasks.find(task => task.type === 'tags.generate')
  // Finish the summary before a tag write can invalidate its pinned source revision.
  const ordered = tasks.map(task => ({ ...task, after: task.after.filter(id => tasks.some(other => other.id === id)) }))
  if (summary && tags && !summary.after.includes(tags.id) && !tags.after.includes(summary.id)) {
    ordered.find(task => task.id === tags.id)!.after.push(summary.id)
  }
  const roles = definition.roles.filter(role => role.kind !== 'executor' || tasks.some(task => task.executorRole === role.key))
  if (tasks.length && !roles.some(role => role.key === executorRole)) roles.push({ key: executorRole, kind: 'executor', required: true, description: 'AI connected to this rule' })
  return { ...definition, tasks: ordered, roles, route: tasks.length ? definition.route : { mode: 'targets', execution: 'single', targetIds: [] } }
}
