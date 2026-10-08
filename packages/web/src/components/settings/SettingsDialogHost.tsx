import { Suspense } from 'react'
import { lazyWithRetry } from '../../lib/lazyWithRetry'
import { useExitAnimation } from '../../lib/useExitAnimation'
import { useSettingsDialog } from '../../lib/useSettingsDialog'

const SettingsDialog = lazyWithRetry('settings/SettingsDialog', async () => (await import('./SettingsDialog')).SettingsDialog)

/** Eager chrome: loads the dialog chunk only while `?settings=` is present
    (plus the exit-animation tail so the close can play out). */
export function SettingsDialogHost() {
  const { isOpen } = useSettingsDialog()
  const { mounted } = useExitAnimation(isOpen)
  if (!mounted) return null
  return (
    // The veil paints immediately while the dialog chunk streams in, so
    // opening settings never flashes a bare page.
    <Suspense fallback={<div className="modal-overlay" aria-hidden="true" />}>
      <SettingsDialog />
    </Suspense>
  )
}
