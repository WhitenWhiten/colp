/** Only transient dependencies retry automatically; consent, challenges and ownership stay fenced. */
export const retryableSourceDependency = (reason: string) => [
  'sourceAutomationPaused', 'sourcePolicyChanged', 'sourceDependencyPending', 'sourceSyncPending',
  'sourceSyncRecovering', 'network', 'timeout', 'semanticOffline',
].includes(reason);
