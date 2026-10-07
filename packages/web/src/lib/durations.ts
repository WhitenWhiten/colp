/* JS mirror of the --duration-* motion tokens in tokens.css (M01). Any
   setTimeout/animation clock that must stay in lockstep with a CSS motion
   token reads from here instead of restating the number — retuning a token
   then fails the motion contract (motion-contract.test.ts) instead of
   silently desynchronising the two clocks. Values are milliseconds.
   Deliberately NOT here: debounce/poll/read-dwell timers and the demo
   simulations (typewriter cadence, fake AI latency) — those are UX timings,
   not motion-token mirrors. */
export const DURATION_FAST_MS = 120 // --duration-fast: micro feedback
export const DURATION_STATE_MS = 180 // --duration-state: state changes
export const DURATION_SPATIAL_MS = 320 // --duration-spatial: spatial moves (lift/shadow)
export const DURATION_ENTER_MS = 400 // --duration-enter: entrances
export const DURATION_LOOP_MS = 1200 // --duration-loop: ambient loading loops
export const DURATION_AMBIENT_MS = 3000 // --duration-ambient: slow decorative loops
