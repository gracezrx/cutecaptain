---
name: bugfix
description: Fix a bug the way this repo requires — reproduced before the fix, gone after, with the failing test written first. Use for any issue labelled bug or agent, and for anything a user reports as broken.
---

# Bug fix: reproduced before, gone after

The acceptance standard is a test that failed before the fix and passes after. A fix with no failing test first is a guess, however plausible.

## Steps

1. **Read the report, then the code.** Map it to a row in `docs/FEATURE_MAP.md`. Read the files that row names, and the test files near them. Do not state a root cause yet.
2. **Reproduce in the real product.** Write the smallest e2e spec (`desktop/e2e/<area>.spec.ts`) or server test (`server/test/<area>.test.ts`) that walks the reported path and asserts the correct behaviour. Run it. **It must fail.** Save the failing output; note the screenshot Playwright saved under `desktop/e2e/evidence/runs/`.
   - If you cannot make it fail, stop. Say in the issue what you tried, what you observed, and what information would let someone reproduce it. Do not ship a speculative fix.
   - If `main` already has a fix (check `git log -S` and the test), say so and close.
3. **Find the cause with evidence.** Logs (`E2E_SERVER_LOG=debug npm run e2e`), the Playwright trace (`npx playwright show-trace …`), a `console.log` you remove afterwards. Quote the line that proves it in the PR.
4. **Fix the smallest thing.** Stay inside the files the feature map names unless the cause is elsewhere. No refactoring in the same PR; open an `agent` issue for that.
5. **Run the test again. It must pass.** Then the full gates: boundaries, ratchet, typecheck both packages, `server npm test`, `desktop npm run e2e`.
6. **Open the PR** with:
   - the issue number
   - "Reproduced: `<spec name>` failed with `<one line of the failure>`"
   - "Fixed: `<what changed, one sentence>`; `<spec name>` passes; screenshot `<path>`"
   - anything you noticed but did not touch, as a new issue

## Common traps here

- Agents answer in a thread that opens itself; a reply "missing" from the channel is usually in the thread.
- Sign-up lands on Home with the Get started guide open; the composer is in General.
- Demo-mode replies end with "Demo mode: …" — a test asserting on reply text should assert on that, not on model output.
- The server serves the web app from `desktop/dist`; a stale build shows yesterday's bug. Run `npm run build` before `npm run e2e`.
