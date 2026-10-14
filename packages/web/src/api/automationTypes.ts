/**
 * Automation Product DTOs for the web.
 *
 * Aliases over src/generated/automations-v1.ts, which is generated from the
 * server's producer mirror (openapi/fragments/automations.yaml). The backend
 * owns every shape and state here; pages render them and never derive
 * permission, retry safety or effective state on their own.
 */
import type { components } from '../generated/automations-v1'

type Schemas = components['schemas']

export type AutomationCapabilities = Schemas['AutomationCapabilities']
export type AutomationDiagnostic = Schemas['AutomationDiagnostic']

export type AutomationRule = Schemas['AutomationRule']
export type AutomationRuleDefinition = Schemas['AutomationRuleDefinition']
export type AutomationRuleInput = Schemas['AutomationRuleInput']
export type AutomationChangeInput = Schemas['AutomationChangeInput']
export type AutomationLifecycleInput = Schemas['AutomationLifecycleInput']
export type AutomationPredicate = Schemas['AutomationPredicate']
export type AutomationFieldPredicate = Schemas['AutomationFieldPredicate']
export type AutomationRuleUsage = Schemas['AutomationRuleUsageView']

export type AutomationPreviewInput = Schemas['AutomationPreviewInput']
export type AutomationPreviewResult = Schemas['AutomationPreviewResult']
export type AutomationPreviewDecision = Schemas['AutomationPreviewDecision']

export type AutomationFolderRef = Schemas['AutomationFolderRef']
export type AutomationFolderBinding = Schemas['AutomationFolderBinding']
export type AutomationBindingSet = Schemas['AutomationBindingSet']
export type AutomationBindingSetInput = Schemas['AutomationBindingSetInput']

export type AutomationHealthReport = Schemas['AutomationHealthReport']
export type AutomationDependencyReport = Schemas['AutomationDependencyReport']
export type AutomationDependency = Schemas['AutomationDependency']
export type AutomationHealthIncident = Schemas['AutomationHealthIncident']
export type AutomationPauseState = Schemas['AutomationPauseState']

export type AutomationRun = Schemas['AutomationRun']
export type AutomationEffectReceipt = Schemas['AutomationEffectReceiptView']
export type AutomationOperationReceipt = Schemas['AutomationOperationReceipt']
export type AutomationUndoInput = Schemas['AutomationUndoInput']
export type AutomationJob = Schemas['AutomationJob']
export type AutomationDecisionInput = Schemas['AutomationDecisionInput']
export type AutomationSubmissionResult = Schemas['AutomationSubmissionResult']
export type AutomationTaskType = Schemas['AutomationTaskSpec']['type']

export type AutomationExport = Schemas['AutomationAutomationExport']

export type AutomationConnectionProfile = Schemas['AutomationConnectionProfile']
export type AutomationConnectionProfileInput = Schemas['AutomationConnectionProfileInput']
export type AutomationTarget = Schemas['AutomationTarget']
export type AutomationTargetInput = Schemas['AutomationTargetInput']
/** The one-use code is in this response only; a replayed command returns `code: null`. */
export type AutomationPairingGrant = Schemas['AutomationPairingGrant']

/** Every automation list: opaque cursor, newest first unless the resource says otherwise. */
export type AutomationPage<T> = { items: T[]; nextCursor: string | null }
