export type CanvasBackgroundKind = 'color' | 'image'
export type CanvasBackgroundFit = 'cover' | 'contain' | 'tile' | 'original' | 'stretch'
export type CanvasBackgroundFinish = 'clear' | 'soft' | 'frosted' | 'deep'

export type CanvasBackgroundSettings = {
  kind: CanvasBackgroundKind
  colorId: string
  fit: CanvasBackgroundFit
  finish: CanvasBackgroundFinish
  imageName: string
  imageVersion: number
}

export const CANVAS_COLORS = [
  { id: 'paper', label: 'Paper', value: 'color-mix(in oklch, var(--paper) 70%, var(--surface))' },
  { id: 'snow', label: 'Snow', value: 'oklch(98% 0.004 260)' },
  { id: 'stone', label: 'Stone', value: 'oklch(91% 0.008 260)' },
  { id: 'graphite', label: 'Graphite', value: 'oklch(27% 0.01 260)' },
  { id: 'ink', label: 'Ink', value: 'oklch(18% 0.012 260)' },
  { id: 'sand', label: 'Sand', value: 'oklch(93% 0.025 82)' },
  { id: 'clay', label: 'Clay', value: 'oklch(82% 0.045 48)' },
  { id: 'blush', label: 'Blush', value: 'oklch(92% 0.028 18)' },
  { id: 'sage', label: 'Sage', value: 'oklch(89% 0.035 145)' },
  { id: 'moss', label: 'Moss', value: 'oklch(42% 0.055 145)' },
  { id: 'sky', label: 'Sky', value: 'oklch(90% 0.035 235)' },
  { id: 'dusk', label: 'Dusk', value: 'oklch(43% 0.045 275)' },
] as const

export const CANVAS_FITS: Array<{
  id: CanvasBackgroundFit
  label: string
  note: string
  size: string
  repeat: string
}> = [
  { id: 'cover', label: 'Crop', note: 'Fill the canvas', size: 'cover', repeat: 'no-repeat' },
  { id: 'contain', label: 'Fit', note: 'Show the whole image', size: 'contain', repeat: 'no-repeat' },
  { id: 'tile', label: 'Tile', note: 'Repeat at original size', size: 'auto', repeat: 'repeat' },
  { id: 'original', label: 'Original', note: 'Center without scaling', size: 'auto', repeat: 'no-repeat' },
  { id: 'stretch', label: 'Stretch', note: 'Match canvas edges', size: '100% 100%', repeat: 'no-repeat' },
]

export const CANVAS_FINISHES: Array<{
  id: CanvasBackgroundFinish
  label: string
  note: string
  blur: string
  veil: string
  saturation: string
  iconClass: string
}> = [
  {
    id: 'clear',
    label: 'Clear',
    note: 'Transparent veil',
    blur: '0px',
    veil: 'transparent',
    saturation: '1',
    iconClass: 'is-clear',
  },
  {
    id: 'soft',
    label: 'Soft',
    note: 'Light diffusion',
    blur: '3px',
    veil: 'color-mix(in oklch, var(--paper) 8%, transparent)',
    saturation: '0.96',
    iconClass: 'is-soft',
  },
  {
    id: 'frosted',
    label: 'Frosted',
    note: 'Glass-like calm',
    blur: '11px',
    veil: 'color-mix(in oklch, var(--paper) 22%, transparent)',
    saturation: '0.88',
    iconClass: 'is-frosted',
  },
  {
    id: 'deep',
    label: 'Deep frost',
    note: 'Quiet and diffuse',
    blur: '22px',
    veil: 'color-mix(in oklch, var(--paper) 38%, transparent)',
    saturation: '0.76',
    iconClass: 'is-deep',
  },
]

/** Fallbacks when a stored id is unknown; the arrays are non-empty literals. */
export const DEFAULT_CANVAS_COLOR = CANVAS_COLORS[0]
export const DEFAULT_CANVAS_FIT = CANVAS_FITS[0]!
export const DEFAULT_CANVAS_FINISH = CANVAS_FINISHES[0]!

const DEFAULT_SETTINGS: CanvasBackgroundSettings = {
  kind: 'color',
  colorId: 'paper',
  fit: 'cover',
  finish: 'clear',
  imageName: '',
  imageVersion: 0,
}

function isFit(value: unknown): value is CanvasBackgroundFit {
  return CANVAS_FITS.some((item) => item.id === value)
}

function isFinish(value: unknown): value is CanvasBackgroundFinish {
  return CANVAS_FINISHES.some((item) => item.id === value)
}

export function loadCanvasBackground(key: string): CanvasBackgroundSettings {
  try {
    const raw = localStorage.getItem(`${key}:settings`)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<CanvasBackgroundSettings>
    return {
      kind: parsed.kind === 'image' ? 'image' : 'color',
      colorId: CANVAS_COLORS.some((item) => item.id === parsed.colorId)
        ? String(parsed.colorId)
        : DEFAULT_SETTINGS.colorId,
      fit: isFit(parsed.fit) ? parsed.fit : DEFAULT_SETTINGS.fit,
      finish: isFinish(parsed.finish) ? parsed.finish : DEFAULT_SETTINGS.finish,
      imageName: typeof parsed.imageName === 'string' ? parsed.imageName : '',
      imageVersion:
        typeof parsed.imageVersion === 'number' && Number.isFinite(parsed.imageVersion)
          ? parsed.imageVersion
          : 0,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function persistCanvasBackground(key: string, settings: CanvasBackgroundSettings) {
  try {
    localStorage.setItem(`${key}:settings`, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
}

const DB_NAME = 'known-canvas-assets'
const STORE_NAME = 'backgrounds'

function openAssetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open image storage'))
  })
}

export async function readCanvasBackgroundImage(key: string): Promise<Blob | null> {
  const db = await openAssetDb()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null)
      request.onerror = () => reject(request.error ?? new Error('Could not read background image'))
    })
  } finally {
    db.close()
  }
}

export async function writeCanvasBackgroundImage(key: string, image: Blob): Promise<void> {
  const db = await openAssetDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(image, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save background image'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Background image save aborted'))
    })
  } finally {
    db.close()
  }
}

export async function deleteCanvasBackgroundImage(key: string): Promise<void> {
  const db = await openAssetDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove background image'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Background image removal aborted'))
    })
  } finally {
    db.close()
  }
}
