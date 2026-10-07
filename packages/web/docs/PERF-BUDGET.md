# Performance budget

## Entry / main chunk

| Surface | Budget | Notes |
|---------|--------|-------|
| Homepage main JS (gzip) | ≤ 148 KB | Measured via `npm run build` (2026-08-20: **119.0 KB** with eager `Landing`; 2026-09-25: **156,743 bytes** measured by check:bundle-budget; 2026-09-28: **137,501 bytes** after R15-27 split the trust pages, ⌘K palette and badge hooks out) |
| Entry linked CSS (sum, gzip) | ≤ 50 KB | All unique linked build stylesheets; split files cannot bypass the aggregate gate. |
| Fonts | Self-hosted Latin variable + system CJK | Instrument Sans + Newsreader remain distributed through `@fontsource-variable`; Vite emits content-hashed `/assets/*.woff2` and nginx serves `/assets/` for one year with `immutable`. Controlled mobile A/B rejected font preloads. Noto SC is not on the first-paint path. |

## Loading strategy

1. **Self-hosted Latin fonts** — the existing `@fontsource-variable` CSS imports stay at the top of `main.tsx`, preserve `font-display: swap` and Unicode subsets, and flow through Vite's content-hashed asset pipeline. No font is preloaded: the controlled M-17 mobile A/B found zero preload consistently faster than the tested one- and two-font sets. CJK uses PingFang / YaHei / Songti (local Noto only if already installed).
2. **Eager `Landing`** — `App.tsx` statically imports the homepage so the first visit does not wait on a second JS chunk. Other routes stay `lazy()`.
3. **Route chunk prefetch** in `TopNav` — `pointerenter` / `focus` on nav links warms the lazy page module so View Transitions do not wait on the network.
4. **Analyze mode** — `rollup-plugin-visualizer` loads only when `vite build --mode analyze`.

## How to check

```bash
npm run check:bundle-budget   # gzip of the homepage entry chunk vs 148 KB
npm run analyze               # optional treemap at docs/bundle-stats.html
```

`known-frontend-ci` static job runs `check:bundle-budget` after `npm run build`. If entry JS gzip exceeds 148 KB or linked CSS gzip exceeds 50 KB the job fails — shrink or re-split before merging.

## M-17 initial local CWV evidence (2026-08-31, rejected preload A)

This is a local synthetic comparison, not production RUM and not a promise of a score increase. It used the same cached Chrome for Testing 149 binary, Lighthouse 12.8.2 mobile defaults (simulated throttling), a Vite production build, and `vite preview` at `http://127.0.0.1:4173`. Each row is one run, so score-level movement is noisy. The constructed collection slug had no local Product API behind preview; its loading/error path makes that row especially unsuitable for trend claims.

| Route | Before score / FCP / LCP / CLS | After score / FCP / LCP / CLS | Observed LCP node |
|---|---|---|---|
| `/` | 81 / 2637 ms / 4189 ms / 0.0216 | 74 / 3519 ms / 4929 ms / 0.0213 | `.landing-hero` section |
| `/explore` | 72 / 2530 ms / 3071 ms / 0.3963 | 62 / 3429 ms / 4027 ms / 0.3949 | `.lede` paragraph |
| `/c/performance-contract` | 53 / 2472 ms / 11943 ms / 0.3467 | 48 / 3492 ms / 12333 ms / 0.3467 | loading/error-state `h1` |

The single after sample regressed rather than improved. Do not present these scores as a win: a single lab run cannot separate run variance from early-font bandwidth competition. It did show that two normal-font preloads moved request discovery from about 2630 ms to about 596 ms, but the controlled follow-up below rejected that load strategy because earlier discovery did not improve FCP/LCP. A separate unthrottled Playwright navigation of this rejected A variant recorded:

| Resource | Initiator | Start | End | Status |
|---|---|---:|---:|---:|
| `/fonts/instrument-sans-latin-wdth-normal.woff2` | `link` | 8.7 ms | 12.4 ms | 200 |
| `/fonts/newsreader-latin-opsz-normal.woff2` | `link` | 9.1 ms | 13.4 ms | 200 |
| built entry CSS | `link` | 9.1 ms | 19.1 ms | 200 |
| `/fonts/newsreader-latin-opsz-italic.woff2` | `css` | 64.8 ms | 92.9 ms | 200 |

Both rejected A preloads began during HTML parsing, alongside the stylesheet rather than after CSS evaluation. Waiting five seconds produced no font/preload/404 console warning. Lighthouse originally could not launch through the unavailable `npx` command (`command not found`), and an attempted unsupported `--chrome-path` flag ended with `Unable to connect to Chrome`; the successful runs used `npm exec --package lighthouse@12.8.2` and `CHROME_PATH=/home/whiten/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`. No score was substituted for either failed attempt.

### Controlled font-preload A/B and final decision

The follow-up used one production build and one local static preview service. Only the marker-bounded preload links varied; JS, CSS, WOFF2 bytes, response behavior, Chrome 149, and Lighthouse 12.8.2 mobile simulated-throttling configuration stayed fixed. Each Lighthouse invocation used a fresh browser profile/cache. Homepage variants ran in interleaved orders `A/B/C/D`, `D/C/B/A`, and `B/D/A/C` to avoid assigning time drift to one variant:

- A — Instrument Sans normal + Newsreader normal preloads (the rejected initial implementation).
- B — only Instrument Sans normal preload.
- C — Instrument Sans normal + Newsreader italic preloads.
- D — no font preloads; the candidate's stable self-hosted fonts remain CSS-discovered.

Playwright computed style confirmed the actual hero needs: `.landing-hero-lead` is Instrument Sans Variable, normal, weight 700; `.typewriter-text` is Newsreader Variable, italic, weight 500. In A, Newsreader normal was initiated by `link` while the typed word's italic file was still initiated by CSS. In C the italic file correctly became a `link` request. All variants waited five seconds without a preload/font/404 console warning.

| Variant | Scores (3 runs) | FCP ms (3 runs; median) | LCP ms (3 runs; median) | CLS median |
|---|---|---|---|---:|
| A: Instrument normal + Newsreader normal | 57, 57, 57 | 7083, 7100, 7078; **7083** | 8513, 8508, 8503; **8508** | 0.0212 |
| B: Instrument normal | 59, 59, 59 | 6364, 6411, 6371; **6371** | 8416, 8466, 8431; **8431** | 0.0213 |
| C: Instrument normal + Newsreader italic | 58, 57, 57 | 7144, 7202, 7160; **7160** | 8483, 8529, 8499; **8499** | 0.0213 |
| D: no preload | 60, 59, 60 | 6088, 6143, 6100; **6100** | 7638, 7714, 7670; **7670** | 0.0216 |

Absolute values were slower than the earlier single samples, reinforcing why cross-time score comparisons are unsafe. Within the controlled interleaved run, however, D won every round: its median FCP was 271 ms faster than B and 983/1060 ms faster than A/C; its median LCP was 761 ms faster than B and 838/829 ms faster than A/C.

Explore then compared D with B, the closest minimal-preload contender, twice in alternating order. Both scored 43. D recorded FCP/LCP 6051/6668 ms and 6032/6640 ms; B recorded 6313/6926 ms and 6327/6945 ms. Zero preload again avoided a consistent regression, so D is the final preload decision; the caching review below determines which self-hosting pipeline remains in production. `/c/:slug` was not resampled because the missing local Product API had already made that route's loading/error-state LCP unsuitable for a font trend.

The result overturns both implementation assumptions tested by the candidate. First, earlier discovery did not translate into better FCP/LCP. Second, once no preload is emitted, stable `/fonts/name.woff2` URLs have no discovery advantage over the existing Vite output. They also weaken repeat-visit caching: `/assets/<content-hash>.woff2` already receives one-year `immutable` headers from nginx, while an unversioned stable filename either receives shorter caching or risks serving stale bytes after a future Fontsource upgrade if marked immutable.

The stable `/fonts` pipeline was therefore test-only and rejected. No runtime, build, generator, workflow, style-gate, or font-asset change lands from M-17. The final production decision is:

- emit no font preload;
- retain the four existing `@fontsource-variable` CSS imports;
- retain Vite content-hashed `/assets/*.woff2` output and nginx's one-year immutable `/assets/` policy;
- revisit only with production RUM or a cache-safe versioned design that demonstrates an FCP/LCP benefit.

### Font assets, build, and licensing

The final untouched dependency pipeline owns licensing and distribution. A fresh production build emitted ten content-hashed WOFF2 files under `dist/assets/` (Instrument Sans Latin/Latin-ext normal+italic and Newsreader Latin/Latin-ext/Vietnamese normal+italic), no `dist/fonts/` directory, and no font preload in `dist/index.html`. The final homepage entry gzip is **142,211 bytes**, within the 180,000-byte budget. The temporary stable assets, notices, custom CSS, generator logic, tests, and CI wiring used while evaluating the candidate were removed before final verification.

### Landing LCP and social image conclusions

No Landing typewriter change was justified. The first render already contains the complete static word `collection.`, the reduced-motion contract freezes that complete word, and both before and after Lighthouse identify the whole hero section—not a later injected character—as the LCP node. The existing Landing contract remains the regression guard.

`public/og-cover.png` is 25,757 bytes, far below the 300 KB re-export threshold, so M-17 did not alter it. `print.css` remains a `media="print"` stylesheet and is not on the screen render-blocking path.

Commands used for the implementation gates:

```bash
npm ci
npm run build
npm exec -- vitest run src/styles/css-layers.contract.test.ts src/lib/agentPublicHome.test.ts src/lib/generate-agent-public.test.ts
node --test scripts/style-drift-contract.mjs
npm test
npm run lint
npm run lint:css
npm exec -- tsc -b --pretty false
npm run check:bundle-budget
git diff --check
```
