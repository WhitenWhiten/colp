import { useEffect, useRef } from 'react'
import { readTokenRgb, subscribeTokenChange, type Rgb } from '../lib/dither'

/*
 * DitherField — the landing hero's ambient background: a Bayer-dithered
 * flow field on canvas. Colors are read from the design tokens
 * (--accent-soft / --accent / --accent-ink / --surface) so the field always
 * matches the active theme. Motion honors prefers-reduced-motion (one static
 * frame); phones animate too — the hero's svh sizing plus the no-op resize
 * guard keep the URL bar from clearing the bitmap. The loop pauses offscreen.
 * When canvas 2D is unavailable (tests, very old browsers) the hero keeps
 * its paper background.
 */

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64)

const CELL = 4
/* R15-30: past 1440 CSS px the cells grow instead of the column count, so
   a 1920 px hero costs what a 1440 px one does. */
const MAX_COLS = 360

export function DitherField({ paused = false }: {
  /** Stop drawing (the last frame stays), e.g. while content covers the hero. */
  paused?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let BG = readTokenRgb('--accent-soft', [236, 243, 250])
    let ACCENT = readTokenRgb('--accent', [56, 102, 149])
    let DEEP = readTokenRgb('--accent-ink', [17, 58, 95])
    let SHEEN = readTokenRgb('--surface', [253, 254, 254])
    const refreshColors = () => {
      BG = readTokenRgb('--accent-soft', [236, 243, 250])
      ACCENT = readTokenRgb('--accent', [56, 102, 149])
      DEEP = readTokenRgb('--accent-ink', [17, 58, 95])
      SHEEN = readTokenRgb('--surface', [253, 254, 254])
    }

    const off = document.createElement('canvas')
    const octx = off.getContext('2d')
    if (!octx) return

    let W = 0
    let H = 0
    let COLS = 0
    let ROWS = 0
    let img: ImageData | null = null
    let lastT = 2.5
    const staticField = reduce

    const resize = () => {
      /* Assigning canvas.width clears the bitmap. Skip no-op resizes so
         mobile URL-bar / visualViewport noise cannot flash a blank frame. */
      const nextW = Math.max(1, Math.round(canvas.clientWidth))
      const nextH = Math.max(1, Math.round(canvas.clientHeight))
      if (nextW === W && nextH === H && img) return false
      W = canvas.width = nextW
      H = canvas.height = nextH
      const cell = Math.max(CELL, W / MAX_COLS)
      COLS = Math.ceil(W / cell)
      ROWS = Math.ceil(H / cell)
      off.width = COLS
      off.height = ROWS
      img = octx.createImageData(COLS, ROWS)
      return true
    }

    /* Domain-warped ridged flow: the warp bends the sine layers so the
       pattern advects like liquid; a slow diagonal drift keeps direction. */
    let mx = -1
    let my = -1
    let tx = -1
    let ty = -1

    /* R10-15: the title pocket has to stay quieter than the rest of the
       field — the lead line is now --ink, so a dense dither would grey it
       out. Reduced-motion still gets the wider/deeper pocket (R7-20). */
    const calmRadius = staticField ? 0.78 : 0.62
    const calmFloor = staticField ? 0.06 : 0.07

    const flowV = (nx: number, ny: number, ar: number, t: number) => {
      const fx = nx + t * 0.016
      const fy = ny - t * 0.011
      const qx = Math.sin(fx * 3.1 + t * 0.3) + 0.5 * Math.sin(fx * 6.7 - t * 0.23)
      const qy = Math.cos(fy * 2.6 - t * 0.24) + 0.5 * Math.sin(fy * 5.9 + t * 0.19)
      let v = 0.5 + 0.5 * Math.sin(fx * 4.4 + qx * 1.9 + fy * 3.2 + qy * 1.7 + t * 0.34)
      v = 1 - Math.abs(2 * v - 1)
      v = v * v * 0.92 + 0.05
      v += 0.1 * Math.sin(fx * 9.0 - fy * 7.0 + t * 0.5)
      if (mx >= 0) {
        const dx = nx - mx
        const dy = (ny - my) * ar
        const dm = Math.sqrt(dx * dx + dy * dy)
        v += 0.14 * Math.max(0, 1 - dm / 0.32)
      }
      return v
    }

    const shade = (v: number): Rgb => (v > 0.88 ? SHEEN : v > 0.68 ? DEEP : ACCENT)

    const render = (t: number) => {
      if (!img) return
      if (tx >= 0 && mx < 0) {
        mx = tx
        my = ty
      }
      if (tx >= 0) {
        mx += (tx - mx) * 0.06
        my += (ty - my) * 0.06
      }
      const d = img.data
      const ar = H / W
      let i = 0
      for (let y = 0; y < ROWS; y++) {
        const ny = y / ROWS
        const rowB = (y & 7) << 3
        for (let x = 0; x < COLS; x++) {
          const nx = x / COLS
          let v = flowV(nx, ny, ar, t)
          /* Calm zone behind the centered headline so the field recedes
             under text instead of competing with it */
          const cx = nx - 0.5
          const cy = (ny - 0.5) * ar * 1.45
          const cd = Math.sqrt(cx * cx + cy * cy)
          v *= calmFloor + (1 - calmFloor) * Math.min(1, cd / calmRadius)
          let c = BG
          if (v > (BAYER[rowB | (x & 7)] ?? 0) - 0.02) c = shade(v)
          d[i++] = c[0]
          d[i++] = c[1]
          d[i++] = c[2]
          d[i++] = 255
        }
      }
      octx.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(off, 0, 0, W, H)
    }

    const onPointer = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      if (e.clientY < r.top || e.clientY > r.bottom) {
        tx = -1
        return
      }
      tx = (e.clientX - r.left) / r.width
      ty = (e.clientY - r.top) / r.height
    }

    const onResize = () => {
      if (resize()) render(lastT)
    }

    let raf = 0
    let last = 0
    let onScreen = true

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!onScreen || document.hidden || pausedRef.current) return
      /* Pause when the hero leaves the viewport. Sticky/in-flow heroes
         intersect normally; checkVisibility covers CSS visibility too. */
      if (canvas.checkVisibility && !canvas.checkVisibility({ checkVisibilityCSS: true })) return
      if (now - last < 33) return // ~30fps is plenty for an ambient field
      last = now
      lastT = now / 1000
      render(lastT)
    }

    resize()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)

    let io: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        onScreen = entries[0]?.isIntersecting ?? true
      })
      io.observe(canvas)
    }

    const onTokens = () => {
      refreshColors()
      render(lastT)
    }
    const stopTokens = subscribeTokenChange(onTokens)

    if (staticField) {
      render(2.5) // one static frame for reduced-motion
    } else {
      window.addEventListener('pointermove', onPointer, { passive: true })
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointer)
      io?.disconnect()
      stopTokens()
    }
  }, [])

  return <canvas ref={canvasRef} className="dither-field" aria-hidden="true" tabIndex={-1} />
}
