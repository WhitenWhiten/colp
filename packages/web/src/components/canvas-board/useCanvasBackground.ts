import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react'
import { useExitAnimation } from '../../lib/useExitAnimation'
import {
  CANVAS_COLORS,
  CANVAS_FINISHES,
  CANVAS_FITS,
  DEFAULT_CANVAS_COLOR,
  DEFAULT_CANVAS_FINISH,
  DEFAULT_CANVAS_FIT,
  type CanvasBackgroundSettings,
} from '../../lib/canvasBackground'
import {
  deleteBoardBackgroundImage,
  loadBoardBackground,
  persistBoardBackground,
  readBoardBackgroundImage,
  writeBoardBackgroundImage,
} from './persistence'

export function useCanvasBackground(opts: {
  enabled: boolean
  storageKey: string
  markEditing: () => void
  markSaved: () => void
  showToast: (msg: string) => void
}) {
  const { enabled, storageKey, markEditing, markSaved, showToast } = opts
  const backgroundInputId = useId()
  const [background, setBackground] = useState<CanvasBackgroundSettings>(() =>
    loadBoardBackground(storageKey),
  )
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false)
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | null>(null)
  const [backgroundBusy, setBackgroundBusy] = useState(false)

  const { mounted: backgroundPanelMounted, closing: backgroundPanelClosing } =
    useExitAnimation(backgroundPanelOpen)

  useEffect(() => {
    if (!enabled) return
    persistBoardBackground(storageKey, background)
  }, [background, enabled, storageKey])

  useEffect(() => {
    if (!enabled || !background.imageVersion) {
      setBackgroundImageUrl(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    readBoardBackgroundImage(storageKey)
      .then((image) => {
        if (cancelled || !image) return
        objectUrl = URL.createObjectURL(image)
        setBackgroundImageUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setBackgroundImageUrl(null)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [background.imageVersion, enabled, storageKey])

  const updateCanvasBackground = (patch: Partial<CanvasBackgroundSettings>) => {
    markEditing()
    setBackground((prev) => ({ ...prev, ...patch }))
    markSaved()
  }

  const uploadCanvasBackground = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      showToast('Choose an image file')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast('Image must be smaller than 20 MB')
      return
    }
    setBackgroundBusy(true)
    try {
      await writeBoardBackgroundImage(storageKey, file)
      updateCanvasBackground({
        kind: 'image',
        imageName: file.name,
        imageVersion: Date.now(),
      })
      showToast('Canvas background saved locally')
    } catch {
      showToast('Could not save this image')
    } finally {
      setBackgroundBusy(false)
    }
  }

  const removeCanvasBackgroundImage = async () => {
    setBackgroundBusy(true)
    try {
      await deleteBoardBackgroundImage(storageKey)
      updateCanvasBackground({
        kind: 'color',
        imageName: '',
        imageVersion: 0,
      })
      showToast('Background image removed')
    } catch {
      showToast('Could not remove the image')
    } finally {
      setBackgroundBusy(false)
    }
  }

  const selectedBackgroundColor =
    CANVAS_COLORS.find((item) => item.id === background.colorId) ?? DEFAULT_CANVAS_COLOR
  const selectedBackgroundFit =
    CANVAS_FITS.find((item) => item.id === background.fit) ?? DEFAULT_CANVAS_FIT
  const selectedBackgroundFinish =
    CANVAS_FINISHES.find((item) => item.id === background.finish) ?? DEFAULT_CANVAS_FINISH
  const canvasBackgroundStyle = enabled
    ? ({
        '--canvas-bg-color': selectedBackgroundColor.value,
        '--canvas-bg-image':
          background.kind === 'image' && backgroundImageUrl
            ? `url(${backgroundImageUrl})`
            : 'none',
        '--canvas-bg-size': selectedBackgroundFit.size,
        '--canvas-bg-repeat': selectedBackgroundFit.repeat,
        '--canvas-bg-blur': selectedBackgroundFinish.blur,
        '--canvas-bg-veil': selectedBackgroundFinish.veil,
        '--canvas-bg-saturation': selectedBackgroundFinish.saturation,
      } as CSSProperties)
    : undefined

  return {
    background,
    backgroundPanelOpen,
    setBackgroundPanelOpen,
    backgroundImageUrl,
    backgroundBusy,
    backgroundInputId,
    backgroundPanelMounted,
    backgroundPanelClosing,
    canvasBackgroundStyle,
    updateCanvasBackground,
    uploadCanvasBackground,
    removeCanvasBackgroundImage,
  }
}
