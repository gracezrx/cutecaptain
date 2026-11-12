# Feature map

How to reach each feature in the running product, what to click, and where its code lives. An agent fixing a bug starts here: find the feature, walk its path in the browser, reproduce, then fix. Selectors are the accessible names Playwright uses (`getByRole`, `getByLabel`); keep them in step with the code when you rename a control.

**Where it runs in verification:** `cd desktop && npm run e2e` boots the real server in demo mode (no model keys) with the built web app at `http://127.0.0.1:8099`. Mac-app-only features (menu bar panel, global shortcut, screen snapshot, the floating Captain) can't be driven in CI; verify them by reading `src-tauri/src/lib.rs` and the panel code, and say so in the PR.

## Accounts

| Feature | Entry point | Controls | Verify | Code |
| --- | --- | --- | --- | --- |
| Sign up | `/` → tab **Create account** | labels `Your name`, `Work email`, `Password`, `Team name`; submit button `Create account` | lands on Home with the **Get started** guide open; button `Done` closes it | `desktop/src/components/AuthScreen.tsx`, `server/src/api/auth.ts`, `server/src/app/auth.ts` |
| Sign in | `/` → tab **Sign in** | labels `Email or username`, `Password`; button `Sign in` | sidebar shows **General** | same |
| Sign out | sidebar bottom, button `Sign out` | | back to the auth screen | `desktop/src/dashboard/Sidebar.tsx` |
| Forgot password | Sign in → **Forgot password?** | label `Work email`; button `Email me a link` | confirmation text; needs `SMTP_URL` to send | `AuthScreen.tsx`, `server/src/app/passwords.ts` |
| Invites | sidebar workspace menu → **Invite**, or Home → `Invite` | | `/invite?token=…` opens sign-up in joining mode | `server/src/app/workspaces.ts` → `makeInvite`, `api/workspaces.ts` |

## Workspace shell

| Feature | Entry point | Controls | Verify | Code |
| --- | --- | --- | --- | --- |
| Home (overview) | sidebar **Home** | cards: Needs a yes, Tokens, Cost, This month; buttons `Ask Captain`, `Invite`, `Get started` | greeting "Good morning, {name}" | `desktop/src/dashboard/Overview.tsx`, `server/src/app/dashboard.ts` |
| Get started guide | Home → `Get started` (opens itself after sign-up) | 5 steps; button `Done` | progress "n of 5 done" | `desktop/src/dashboard/SetupGuide.tsx`, `desktop/src/lib/setup.ts` |
| Sidebar sections | always | sections `Group chats`, `Direct messages`; buttons `New group chat`, `New message`, `Browse`, `Search messages`, `Settings` | | `desktop/src/dashboard/Sidebar.tsx` |
| Find a chat | sidebar search field `Find a chat` | | filters the chat list | `Sidebar.tsx` |
| Pinned Captain | sidebar card **Captain** under the workspace | click opens the DM with Captain | | `Sidebar.tsx` → `PinnedCaptain` |

## Chat

| Feature | Entry point | Controls | Verify | Code |
| --- | --- | --- | --- | --- |
| Open a group chat | sidebar → button `General` (every workspace has it) | | header "General · Everyone in the workspace, and the agents" | `desktop/src/dashboard/ChatView.tsx` |
| Send a message | composer textbox `Message` (placeholder "Message General · @ to bring in an agent"), button `Send` | Enter sends | message row shows text; `POST /channels/:id/posts` | `desktop/src/components/Composer.tsx`, `desktop/src/lib/send.ts`, `server/src/app/posts.ts` |
| New group chat | sidebar `New group chat` | modal "New group chat": labels `Name`, `What it is for` | new row under Group chats | `desktop/src/dashboard/Dialogs.tsx`, `server/src/app/channels.ts` |
| Browse channels | sidebar `Browse` | | list of public channels; join | `Dialogs.tsx`, `GET /workspaces/:id/channels/browse` |
| Direct message | sidebar `New message` | field placeholder `Find a person or agent` | DM row under Direct messages | `Dialogs.tsx` |
| Threads | message row → button `Reply in thread` | thread pane with textbox `Reply in thread`; button `Close thread` | "Thread · n replies" header | `ChatView.tsx`, `server/src/app/posts.ts` |
| Reactions | hover a message → `More reactions` | 18 Crew reactions | `POST /posts/:id/reactions` | `desktop/src/components/Crew.tsx`, `server/src/shared/emoji.ts` |
| Files | composer button `Attach a file`; button `Remove attachment` | up to 25 MB | image inline, other files download | `desktop/src/components/Files.tsx`, `server/src/files/storage.ts` |
| Search | sidebar `Search messages` | field placeholder `Words, names, numbers…` | results list | `Dialogs.tsx`, `server/src/store/posts.ts` → `searchPosts` |
| Edit / delete | message row menu; button `Delete message` | own messages only; admins delete any | | `server/src/app/posts.ts` |
| Real-time | second browser context on the same channel | | message appears without reload; reconnect within 2 min replays up to 256 events | `desktop/src/lib/realtime.ts`, `server/src/realtime/hub.ts` |

## Agents

| Feature | Entry point | Controls | Verify | Code |
| --- | --- | --- | --- | --- |
| Ask one agent | type `@captain …` (or `@researcher`, `@writer`, `@analyst`, `@designer`) in any chat | | reply arrives in the message's thread, which opens itself; in demo mode the reply ends with "Demo mode: add a model key…" | `server/src/agents/triggers.ts`, `runner.ts`, `llm/demo.ts` |
| Team run | mention two or more agents in one message | plan card "Captain is coordinating @a and @b" | one combined answer; steps in the thread | `agents/planner.ts` (`named`, `namedPlan`), `orchestrator.ts` |
| Captain joins in | chat header button `Captain joins in` | toggle | Captain replies unprompted when it sees fit | `server/src/agents/joinin.ts` |
| Stop a run | plan card → **Stop** | | `POST /runs/:id/cancel` | `desktop/src/components/PlanCard.tsx`, `server/src/app/agents.ts` → `cancelRun` |
| Approvals | an agent calls `send_email` or `request_approval` | decision card: approve / change / decline | Home "Needs a yes" count; `POST /posts/:id/actions/:action` | `desktop/src/components/DecisionCard.tsx`, `server/src/agents/tools/actions.ts`, `orchestrator.ts` → `decide` |
| Made files | agent calls `create_document` / `create_presentation` / spreadsheet | attachment on the reply | file downloads from `/files/:id/content` | `server/src/files/make/*.ts`, `agents/tools/files.ts` |
| Agent settings | `Settings` → **Agents** | instructions, tools, difficulty tier, pinned model | `PATCH /agents/:id` | `desktop/src/dashboard/Settings.tsx`, `server/src/store/agents.ts` |

## Settings and admin

| Feature | Entry point | Controls | Verify | Code |
| --- | --- | --- | --- | --- |
| People | `Settings` → **People** | roles owner/admin/member/guest; remove; one-time password link | | `Settings.tsx`, `server/src/app/workspaces.ts`, `app/permissions.ts` |
| Models and keys | `Settings` → **Models** (instance admins only) | add provider key; `Add key` on Home | agents stop saying "Demo mode" | `server/src/api/admin.ts`, `llm/keys.ts`, `llm/catalog.ts` |
| Budget and spend | Home → Cost / This month | per-workspace monthly budget (default $20) | `GET /workspaces/:id/usage` | `server/src/llm/router.ts`, `store/usage.ts` |
| Integrations (MCP) | `Settings` → **Integrations** | add an MCP server, OAuth | `GET /workspaces/:id/mcp` | `server/src/connectors/mcp/*`, `app/mcp.ts` |

## Mac app and extension (not driven in CI)

| Feature | Entry point | Code |
| --- | --- | --- |
| Menu bar panel | **⌃⇧C** anywhere; tabs `What needs you`, `Write to a chat`; `Add a screen snapshot` | `desktop/src/panel/Panel.tsx`, `src-tauri/src/lib.rs` |
| Floating Captain (orb) | hold the orb or **⌃⇧Space**; `Talk to Captain` | `desktop/src/orb/Orb.tsx`, `Mascot.tsx`, `lib/talk.ts`, `lib/spoken.ts` |
| Dictation | composer `EN` button / mic | `desktop/src/lib/dictation.ts` |
| Built-in server | app starts the server on `127.0.0.1:8787` | `src-tauri/src/lib.rs`, `desktop/scripts/bundle-server.mjs` |
| Chrome extension | toolbar popup, side panel (`Open in the side panel`), page tools | `desktop/src/extension/*`, `vite.extension.config.ts` |

## Keeping this current

- Renamed a control? Update its row. The e2e suite uses these names.
- Added a feature? Add a row with its entry point and code before the PR is opened; the PR template asks for it.
- A bug report that doesn't map to a row is a sign the map is incomplete, not that the report is wrong.
