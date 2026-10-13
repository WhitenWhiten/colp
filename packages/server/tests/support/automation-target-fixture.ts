import type { AutomationUnitOfWork,AutomationActor } from '../../src/modules/automation/index.js';
/** Storage fixture for pre-pair lease/proposal tests. Real worker authorization is tested separately. */
export async function seedAutomationTarget(uow: AutomationUnitOfWork,actor: AutomationActor) {
  await uow.execute(actor,async p => {
    const profile = await p.targets.profiles.save({ name: 'Service fixture',automationEnabled: true,catalogs: ['automationWorker'],authorizedClientId: 'client',credentialBindingId: 'credential' });
    await p.targets.targets.save({ name: 'Service fixture',providerLabel: 'Injected output',broadcastOptIn: false,privacy: 'standard',connectionProfileId: profile.id,wakeMode: 'poll',pollIntervalMinutes: 1 },'target');
  });
}
