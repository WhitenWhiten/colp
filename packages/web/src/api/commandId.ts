/**
 * Command-id helpers for the app facade.
 * Storage and allocation live in command-intent.ts (test surface: allocateCommandId).
 */
export {
  allocateCommandId,
  allocateCommandId as getOrCreateCommandId,
  clearCommandId,
  isCommandIdCleared,
  rotateCommandId,
  newCommandId,
  mutationIntentKey,
  isAllocatedCommandId as isCommandId,
} from './command-intent'
