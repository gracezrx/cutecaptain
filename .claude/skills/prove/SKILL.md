---
name: prove
description: Prove a change works by running the real product (server + web app) and leaving evidence. Use before opening any PR, and whenever a PR template asks for verification. Not gstack's /verify (which makes the checks green); this is about evidence.
---

# Prove it works: run the product, leave evidence

A change is verified when the real app did the thing, and the proof survives the session. Reading code or passing typecheck is not verification.

## Steps

1. **Find the feature** in `docs/FEATURE_MAP.md`: entry point, control names, files. If it's missing, add the row now.
2. **Start from green.** `node scripts/check-boundaries.mjs && node scripts/ratchet.mjs`, then `cd server && npm run typecheck && npm test`, then `cd desktop && npm run typecheck && npm run build`.
3. **Drive the feature in the browser.** Add or extend a spec in `desktop/e2e/` that walks the user's path from the feature map and asserts the outcome. Take a screenshot at the moment the result is visible: `await page.screenshot({path: 'e2e/evidence/<feature>-<what>.png'})`. Capture console errors and 4xx/5xx responses the way `smoke.spec.ts` does, and assert there are none.
4. **Run it.** `cd desktop && npm run e2e`. If it needs model keys or Mac-only surfaces, say so in the PR and verify what can be verified (server tests, panel code read-through) instead.
5. **Check the evidence** by opening the screenshot (Read tool) and confirming it shows what the assertion claims. A green test with a blank screenshot is a broken test.
6. **Write it up** in the PR body under "Verification": the spec name, the screenshot path, what you saw. One sentence each.

## What counts as evidence

- A spec that fails without the change and passes with it
- A screenshot showing the result in the real UI
- A server test exercising the API path
- A log line or trace from a real run

## What does not

- "Typecheck passes"
- "Looked at the code and it should work"
- A unit test of a function the feature doesn't actually call
- A screenshot of the dev server with hand-edited state
