# Legacy demo surface

The modules under `data/` are local seed data for the existing offline demo
pages. They are not Product API responses and must not import or emulate the
Phase 1 client in `src/api`.

Phase 1 session, collection, and editor traffic goes through the canonical
`src/api` entry point.
