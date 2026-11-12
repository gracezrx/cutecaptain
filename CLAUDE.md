# Captain Desktop — working in this repo

Captain is a group chat where a team and its AI agents work together. One TypeScript server (`server/`, Fastify + Postgres) and one React app (`desktop/`) that runs as a Mac app (Tauri), a web app the server hosts at `/`, and a Chrome extension. Read `docs/ARCHITECTURE.md` once; `DECISIONS.md` records why things are the way they are, with the file each choice lives in.

## The rules are in CI, not here

The structure of the codebase is enforced mechanically. A PR that breaks any of these does not merge, whoever or whatever wrote it:

- **Layers**: `api → app → (agents, connectors, llm) → store → db`. `api/` calls `app/`, which owns permissions and hooks. Nothing imports upward. `desktop/` reaches the server only through `server/src/shared/`. `node scripts/check-boundaries.mjs`
- **Ratchet**: `scripts/ratchet.json` holds counts of known debt (`useEffect` in `desktop/`, `api → store` skips). They may go down, never up. When you lower one, update the baseline in the same PR: `node scripts/ratchet.mjs --update`.
- **Types and build**: `npm run typecheck` and `npm run build` in both packages.
- **Server tests**: `cd server && npm test` (needs Postgres at `postgres://postgres@127.0.0.1:5432/captain_test`).
- **E2E**: `cd desktop && npm run build && npm run e2e` boots the real server in demo mode and drives the web app. The smoke path (sign up → General → post → `@captain` reply) must stay green, and the run must produce zero console errors or 4xx/5xx responses.

If you find yourself leaving the same review note twice, stop and turn it into a check in `scripts/` or CI. The third time is too late.

## How to work

- **Small, atomic PRs.** One concern per PR: a bug, a feature slice, a refactor. A big task becomes several PRs, each green on its own. Never mix a refactor with a behaviour change.
- **Prove it works.** A PR says how the change was verified and attaches evidence: which e2e spec covers it (new or existing), the screenshot path under `desktop/e2e/evidence/`, the server test. "Should work now" is not evidence. Use the `prove` skill.
- **Bugs: reproduced before, gone after.** Write the failing e2e spec or server test first, watch it fail, fix, watch it pass. Use the `bugfix` skill. A fix with no failing test first is a guess.
- **Find the feature in `docs/FEATURE_MAP.md`** before touching code: it gives the entry point, the control names, and the files. If the feature isn't there, add the row in the same PR.
- **Read before you diagnose.** Never state a root cause you haven't seen in code or in a log. If you can't reproduce, say so and stop; don't ship a speculative fix.
- **Don't widen scope.** Found another bug on the way? Open an issue labelled `agent` with the reproduction path; don't fix it in this PR.
- **No stale commentary.** Comments explain *why* when the code can't; they never narrate *what* the code does or record opinions from a review.

## Where things live

| Concern | Files |
| --- | --- |
| HTTP routes | `server/src/api/*.ts` (thin; validation with zod, then `app/`) |
| Permissions, hooks, business rules | `server/src/app/*.ts`, `app/permissions.ts` |
| SQL | `server/src/store/*.ts`; migrations in `server/src/db/migrations/NNNN_*.sql` (numbered, append-only) |
| Agents | `server/src/agents/` — `triggers.ts` (when an agent answers), `planner.ts`, `orchestrator.ts`, `runner.ts`, `tools/` |
| Model routing, budgets, demo mode | `server/src/llm/` |
| Real-time | `server/src/realtime/hub.ts` (sequence numbers, replay) |
| Shared types (server ↔ app) | `server/src/shared/types.ts` — the only server file the app imports |
| App state | `desktop/src/lib/store.ts` (zustand), `lib/api.ts`, `lib/realtime.ts` |
| Screens | `desktop/src/dashboard/` (web + Mac window), `panel/` (menu bar), `orb/` (floating Captain), `extension/` |
| Mac-only | `desktop/src-tauri/src/lib.rs` |

## Conventions

- TypeScript strict, ES modules, 4-space indent, single quotes, no semicolons omitted. Match the file you're in.
- Server tests are `node:test` in `server/test/*.test.ts` against a real server on a random port (`test/helpers.ts`). Prefer one more case in an existing file over a new file.
- E2E specs in `desktop/e2e/*.spec.ts` use accessible names (`getByRole`, `getByLabel`), never CSS classes. Keep the smoke spec to the happy path; put feature-specific checks in their own spec.
- Env config lives in `server/src/config.ts`; document any new variable in `docs/DEPLOY.md`.
- Never run `server/scripts/reset-db.mjs` against anything but a local database.

## Running locally

```
# Postgres on localhost, then:
cd server && npm ci && npm run dev          # API + web app on :8080 (demo-mode agents, no keys needed)
cd desktop && npm ci && npm run dev         # Vite dev server on :1420
cd desktop && npm run build && npm run e2e  # verification suite
```
