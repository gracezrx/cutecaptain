## What changed

<!-- One concern per PR. What, and why. Link the issue: Closes #N -->

## Verification

<!-- Evidence from the real product, not "should work". Delete lines that don't apply. -->

- Reproduced before: `<spec or test name>` failed with `<one line of the failure>`
- Gone after: `<spec or test name>` passes
- Screenshot: `desktop/e2e/evidence/<file>.png` — shows `<what you saw>`
- Server test: `server/test/<file>.test.ts` → `<case name>`
- Not verifiable in CI (Mac-only / needs model keys): `<what, and how it was checked instead>`

## Gates

- [ ] `node scripts/check-boundaries.mjs`
- [ ] `node scripts/ratchet.mjs` (baseline lowered if a count went down)
- [ ] `server`: typecheck, test
- [ ] `desktop`: typecheck, build, e2e
- [ ] `docs/FEATURE_MAP.md` updated if a control or entry point changed

## Noticed, not touched

<!-- Anything else you saw. Open an issue labelled `agent` with a reproduction path. -->
