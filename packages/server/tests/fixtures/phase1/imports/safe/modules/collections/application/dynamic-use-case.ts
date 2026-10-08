export async function loadSafeCommand(): Promise<typeof import('@/modules/commands/index.js')> {
  return import('@/modules/commands/index.js');
}
