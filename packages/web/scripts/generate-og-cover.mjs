import { chromium } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

/* Renders public/og-cover.png (1200×630) as a still of the landing page:
   the hero's Bayer-dithered flow field (same 8×8 matrix, ridge function and
   accent ramp as DitherField.tsx), the hero headline with its serif-italic
   word and caret, the "How it works" moves, and the mini collection card.
   The wordmark is inlined from public/brand-wordmark.svg so the card can
   never drift from the site logo. Fonts load from local @fontsource-variable
   files — no network needed — and the render fails if either face is
   missing rather than shipping a fallback. Colors mirror src/styles/tokens.css. */
const wordmark = readFileSync(path.resolve('public/brand-wordmark.svg'), 'utf8')
/* Inlined as data URLs: a setContent page is about:blank, which may not
   load file:// fonts, and a silent fallback would ship the wrong type. */
const font = (family, file) => {
  const data = readFileSync(path.resolve(`node_modules/@fontsource-variable/${family}/files/${file}`))
  return `url('data:font/woff2;base64,${data.toString('base64')}')`
}

const modes = ['Capture', 'Classify', 'Connect', 'Publish']
const rows = [
  ['github', 'Radix Primitives', 'radix-ui.com'],
  ['medium', 'Container Queries', 'developer.mozilla.org'],
  ['figma', 'Spring Physics in UI', 'framer.com'],
  ['arxiv', 'Interface Systems vol. 3', 'arxiv.org'],
]

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face {
      font-family: 'Instrument Sans';
      src: ${font('instrument-sans', 'instrument-sans-latin-wght-normal.woff2')} format('woff2-variations');
      font-weight: 100 1000;
    }
    @font-face {
      font-family: 'Newsreader';
      src: ${font('newsreader', 'newsreader-latin-opsz-italic.woff2')} format('woff2-variations');
      font-weight: 100 1000;
      font-style: italic;
    }
    :root {
      --ink: rgb(6 7 10);
      --ink-2: rgb(51 53 58);
      --muted: rgb(97 99 103);
      --faint: rgb(104 106 110);
      --surface: rgb(253 254 254);
      --line: rgb(6 7 10 / 0.06);
      --line-strong: rgb(6 7 10 / 0.12);
      --accent-ink: rgb(17 58 95);
      --source-github: rgb(109 157 206);
      --source-medium: rgb(76 71 60);
      --source-figma: rgb(0 124 238);
      --source-arxiv: rgb(157 53 51);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1200px; height: 630px; overflow: hidden; }
    body {
      position: relative;
      background: rgb(236 243 250);
      font-family: 'Instrument Sans', system-ui, sans-serif;
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }
    canvas { position: absolute; inset: 0; width: 1200px; height: 630px; image-rendering: pixelated; }

    .copy {
      position: absolute;
      left: 76px;
      top: 64px;
      bottom: 60px;
      width: 610px;
      display: flex;
      flex-direction: column;
    }
    .wordmark { width: 151px; height: 44px; margin-left: -4px; }
    .wordmark svg { width: 100%; height: 100%; display: block; }

    h1 {
      margin-top: auto;
      font-size: 66px;
      font-weight: 700;
      line-height: 1.02;
      letter-spacing: -0.045em;
    }
    h1 em {
      display: inline-block;
      margin-top: 4px;
      font-family: 'Newsreader', Georgia, serif;
      font-style: italic;
      font-weight: 500;
      font-size: 80px;
      font-variation-settings: 'opsz' 72;
      letter-spacing: -0.025em;
    }
    .caret {
      display: inline-block;
      width: 0.32em;
      height: 0.74em;
      margin-left: 0.08em;
      vertical-align: -0.04em;
      background: var(--accent-ink);
      opacity: 0.82;
    }
    .lede {
      margin-top: 22px;
      max-width: 30ch;
      font-size: 25px;
      line-height: 1.38;
      letter-spacing: -0.01em;
      color: var(--ink-2);
    }
    .modes {
      display: flex;
      gap: 30px;
      margin-top: auto;
      padding-top: 18px;
      border-top: 1px solid rgb(6 7 10 / 0.14);
      list-style: none;
    }
    .modes li { display: flex; align-items: baseline; gap: 9px; font-size: 21px; font-weight: 600; letter-spacing: -0.015em; }
    .modes i {
      font-family: 'Newsreader', Georgia, serif;
      font-weight: 400;
      font-size: 22px;
      color: var(--faint);
    }

    .card {
      position: absolute;
      right: 64px;
      top: 50%;
      width: 404px;
      transform: translateY(-50%);
      padding: 26px 28px 18px;
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 18px;
      box-shadow:
        0 1px 2px rgb(6 7 10 / 0.05),
        0 24px 48px -16px rgb(17 58 95 / 0.32);
    }
    .head {
      display: grid;
      gap: 6px;
      padding-bottom: 18px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }
    .kicker { font-size: 13px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
    .title { font-size: 23px; font-weight: 700; line-height: 1.2; letter-spacing: -0.025em; }
    .meta { font-size: 15px; color: var(--muted); }
    .row { display: flex; align-items: center; gap: 12px; padding: 11px 0; font-size: 16px; }
    .row + .row { border-top: 1px solid var(--line); }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
    .name { font-weight: 600; color: var(--ink-2); letter-spacing: -0.01em; }
    .host { margin-left: auto; font-size: 13px; color: var(--faint); }
  </style>
</head>
<body>
  <canvas id="field" width="1200" height="630"></canvas>

  <div class="copy">
    <div class="wordmark" aria-hidden="true">${wordmark}</div>
    <h1>Your bookmarks already contain a <em>reading path.</em><span class="caret"></span></h1>
    <p class="lede">An online bookmark library for saved links, synced folders and shared collections.</p>
    <ol class="modes">
      ${modes.map((m, i) => `<li><i>0${i + 1}</i>${m}</li>`).join('')}
    </ol>
  </div>

  <div class="card">
    <div class="head">
      <span class="kicker">Interface Systems</span>
      <span class="title">A path through modern UI foundations</span>
      <span class="meta">42 bookmarks · by Mira Okada</span>
    </div>
    ${rows
      .map(
        ([source, name, host]) =>
          `<div class="row"><span class="dot" style="background: var(--source-${source})"></span><span class="name">${name}</span><span class="host">${host}</span></div>`,
      )
      .join('')}
  </div>

  <script>
    /* One frame of the hero DitherField: 8×8 Bayer threshold over the
       domain-warped ridged flow, shaded --accent / --accent-ink / --surface
       on --accent-soft. The calm side is the copy column instead of the
       page center, so the headline reads on plain paper and the field
       gathers behind the card. */
    const BAYER = [
      0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
      12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
      3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
      15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ].map((v) => (v + 0.5) / 64)
    const BG = [236, 243, 250]
    const ACCENT = [56, 102, 149]
    const DEEP = [17, 58, 95]
    const SHEEN = [253, 254, 254]
    const CELL = 5
    const T = 12

    const flowV = (nx, ny, t) => {
      const fx = nx + t * 0.016
      const fy = ny - t * 0.011
      const qx = Math.sin(fx * 3.1 + t * 0.3) + 0.5 * Math.sin(fx * 6.7 - t * 0.23)
      const qy = Math.cos(fy * 2.6 - t * 0.24) + 0.5 * Math.sin(fy * 5.9 + t * 0.19)
      let v = 0.5 + 0.5 * Math.sin(fx * 4.4 + qx * 1.9 + fy * 3.2 + qy * 1.7 + t * 0.34)
      v = 1 - Math.abs(2 * v - 1)
      v = v * v * 0.92 + 0.05
      v += 0.1 * Math.sin(fx * 9.0 - fy * 7.0 + t * 0.5)
      return v
    }
    const smooth = (a, b, x) => {
      const k = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return k * k * (3 - 2 * k)
    }

    const canvas = document.getElementById('field')
    const ctx = canvas.getContext('2d')
    const COLS = Math.ceil(1200 / CELL)
    const ROWS = Math.ceil(630 / CELL)
    const off = document.createElement('canvas')
    off.width = COLS
    off.height = ROWS
    const octx = off.getContext('2d')
    const img = octx.createImageData(COLS, ROWS)
    const d = img.data
    let i = 0
    for (let y = 0; y < ROWS; y++) {
      const ny = y / ROWS
      const rowB = (y & 7) << 3
      for (let x = 0; x < COLS; x++) {
        const nx = x / COLS
        let v = flowV(nx, ny, T)
        const edge = 0.5 + 0.05 * Math.sin(ny * 5.2 + 0.8)
        const calm = smooth(edge, edge + 0.28, nx)
        v *= calm
        let c = BG
        if (calm > 0 && v > BAYER[rowB | (x & 7)] - 0.02) c = v > 0.88 ? SHEEN : v > 0.68 ? DEEP : ACCENT
        d[i++] = c[0]
        d[i++] = c[1]
        d[i++] = c[2]
        d[i++] = 255
      }
    }
    octx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(off, 0, 0, 1200, 630)
  </script>
</body>
</html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(html, { waitUntil: 'load' })
const faces = await page.evaluate(async () => {
  await document.fonts.ready
  return [...document.fonts].map((f) => `${f.family} ${f.status}`)
})
if (faces.some((f) => !f.endsWith(' loaded'))) throw new Error(`font failed to load: ${faces.join(', ')}`)
await page.screenshot({
  path: path.resolve('public/og-cover.png'),
  type: 'png',
})
await browser.close()
console.log('wrote public/og-cover.png')
