# Running Captain

## On your machine (development)

You need Node 22 and Postgres 14 or newer.

```bash
createdb captain                         # or: docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
cd server
cp .env.example .env                     # optional; model keys can be pasted in the app
npm install
npm run dev                              # http://localhost:8080 (API); applies migrations on start

cd ../desktop
npm install
npm run dev                              # http://localhost:1420 (app, talks to :8080)
```

- Open http://localhost:1420 and create an account. That makes your workspace, with #general and five agents. The first account on a server also runs it: it can set model keys.
- The menu bar panel's browser preview is at http://localhost:1420/panel.html.
- With no model key set, agents answer in **demo mode**. Plans, approvals and documents still work, so you can click through everything. To turn on real models, see [Model keys](#model-keys).

Run the tests with `cd server && npm test`. They need a `captain_test` database, and `TEST_DATABASE_URL` overrides its address. They exercise:

- accounts, invites and roles
- channels, threads, files and real-time replay
- orchestration: plans, approvals, stopping a run
- routing and fallback against scripted model providers
- the job queue

## With Docker Compose (one machine)

```bash
cp server/.env.example .env
# set APP_SECRET (openssl rand -hex 32), PUBLIC_URL, and at least one model key
docker compose up -d --build
open http://localhost:8080
```

This runs Postgres and the Captain image. The image holds the API, the web app, real-time updates and the agent workers. Data lives in two volumes: `pgdata` for the database and `files` for uploads.

## With Supabase as the database

Captain needs only Postgres from Supabase: no Supabase Auth, storage or client keys. The server creates its own tables in the `public` schema on first start.

1. In the Supabase dashboard, open the project and click **Connect**.
2. Copy the **Session pooler** connection string. It looks like `postgres://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   - Use the session pooler, port **5432**. The transaction pooler (6543) can't carry real-time updates between instances or the migration lock, and the server warns if you use it.
   - The direct connection (`db.<project-ref>.supabase.co`) works too where the host has IPv6. Render doesn't, so use the pooler there.
3. Put your database password in place of `[YOUR-PASSWORD]`. If you don't know it, reset it under **Project Settings → Database**.
4. Set the whole string as `DATABASE_URL` on your host. Keep it out of the repo and out of chat: it gives full access to the database.

What the server does for Supabase:

- It turns on TLS for Supabase addresses.
- It turns on row-level security for every table it creates. Supabase publishes the `public` schema through its Data API to anyone holding the project's public key. With row-level security on and no policies, that API returns nothing. The server connects as the tables' owner, so its own queries aren't affected.

Connection budget: each instance opens up to `DATABASE_POOL_SIZE` (default 10) connections, plus one for real-time and one for the migration lock. Supabase's smallest plan allows about 15 pooler connections per user, so with two instances set `DATABASE_POOL_SIZE=5`.

## On Render

`render.yaml` is a Blueprint for one Docker web service with a 10 GB disk for uploads. It uses your own database, such as Supabase.

1. In Render: **New → Blueprint**, and pick this repo.
2. Fill in the values marked `sync: false`:
   - `DATABASE_URL`: the Supabase session pooler string from above
   - `PUBLIC_URL`, such as `https://captain-xxxx.onrender.com`
   - `INSTANCE_ADMINS`: your email, so only you can set model keys
   - optionally a model key such as `OPENROUTER_API_KEY` (or paste it in the app later)
   - optionally `TAVILY_API_KEY` for web search
   - optionally `SMTP_URL` and `MAIL_FROM` for email
3. Deploy. Migrations run when the service starts, and the health check is `/readyz`.
4. Right away, open the site, sign up with the email you put in `INSTANCE_ADMINS`, and paste your model key (below).
5. Invite testers from Settings → People. The Blueprint sets `OPEN_SIGNUP=false`: model keys are shared by every workspace, so open sign-up would let strangers spend your credit. The first person can always sign up. Set it to `true` when you want anyone to join.

Render generates `APP_SECRET` once and keeps it. Don't change it later: it encrypts saved model keys.

Any host that runs a Docker image and gives it Postgres works the same way: Fly.io, Railway, a VM.

## Model keys

The people who run the server set model keys in the app, under **Settings → Models & spend → Model keys**. Everyone else sees only which models are on.

- **Who runs the server:** exactly the people listed in `INSTANCE_ADMINS`; if it's empty, the first person to sign up. Emails aren't verified yet, so sign up with a listed address before anyone else can.
- **Their accounts are protected:** workspace owners can't make password-reset links for them, or for anyone who is also in another workspace. Those people use "Forgot password?".
- **Which key:** one [OpenRouter key](https://openrouter.ai/keys) turns on every model in the catalog. Vendor keys (Anthropic, OpenAI, Google, DeepSeek, Moonshot, …) are listed under "Other providers". They're tried before OpenRouter for their own models.
- **Saving tries the key.** The server sends a tiny request to the provider's cheapest model. A key the provider rejects isn't saved; other problems, such as no credit, are shown and the key is kept. **Check** repeats the test later.
- **Storage:** keys are encrypted with `APP_SECRET` (AES-256-GCM) and never sent back to the app, only their last four characters. Every instance picks up a change within a second.
- **Precedence:** a key saved in Settings wins over the same provider's environment variable. **Remove** goes back to the environment variable, if there is one.
- Saving and removing keys are recorded in `audit_log`.

## Keys and settings

All settings are environment variables. `server/.env.example` lists each one with a note. To go live you need:

| Setting | What for |
| --- | --- |
| `APP_SECRET` | Signs file links and encrypts saved model keys. In production the server refuses to start without one. |
| `DATABASE_URL` | Postgres 14 or newer, such as Supabase's session pooler. |
| `PUBLIC_URL` | Used to build invite links. |
| `INSTANCE_ADMINS` | Your email: who may set model keys. |
| A model key | Pasted in Settings, or set here. `OPENROUTER_API_KEY` covers every model in the catalog. Vendor keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, …) are tried first for their own models. `LLM_GATEWAY_URL` with `LLM_GATEWAY_KEY` adds any OpenAI-compatible gateway. |

Optional:

| Setting | What for |
| --- | --- |
| `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` | Web search for agents. |
| `SMTP_URL`, `MAIL_FROM` | Agents send real email after approval. |
| `OPEN_SIGNUP=false` | Invite-only. |
| `TRUST_PROXY=1` | Behind one load balancer (Render, Fly, Railway). Leave `false` when the server is exposed directly. |
| `EMAIL_DAILY_LIMIT` | Email recipients per workspace per day (default 100). |
| `CORS_ORIGINS` | Browser origins other than the server itself and the Mac app. |
| `DATABASE_POOL_SIZE` | Connections per instance (default 10). |
| `DATABASE_SSL` | `require` forces TLS, `disable` turns it off. It's on automatically for Supabase, Neon and Render. |

To add or reprioritize models, edit `server/config/models.json`. Check the prices there: they're estimates.

## The Mac app

### Download it

GitHub builds the app on a Mac: **Actions → Mac app → Run workflow** (leave "release" on). About ten minutes later, the [app-latest release](../../releases/tag/app-latest) has:

- `cutecaptain.dmg`: open it and drag cutecaptain to Applications
- `cutecaptain-mac.zip`: the same app, zipped
- `cutecaptain-Chrome-extension.zip`: the extension

Until Quest Space's Developer ID is added (see Signing and notarizing below), the app is signed ad hoc, so macOS asks the first time: right-click cutecaptain → **Open**. If macOS still refuses, open **System Settings → Privacy & Security** and click **Open Anyway**.

### Captain on this Mac (the built-in server)

The app carries the server and runs it with the Mac's Node.js (22 or newer), on `http://127.0.0.1:8787`, only reachable from the Mac itself.

- On first launch, choose **This Mac**. If you ran the Captain server yourself before, the app finds its `server/.env` in a `cutecaptain` folder (or `captain-desktop`, the repo's name before Nov 3, 2026) in your home folder, `~/Documents`, `~/Developer`, `~/Projects`, `~/code`, `~/Documents/GitHub` or `~/GitHub` and shows its Supabase project: click **Connect**. It uses that file's `DATABASE_URL` and `APP_SECRET`, so model keys saved by that server keep working. macOS may ask once to let cutecaptain read your Documents folder.
- Otherwise, paste the database address (Supabase → Connect → Session pooler, as it is) and type the database password in its own field; the app puts it in place of `[YOUR-PASSWORD]`. You can paste a whole server `.env` instead.
- The address and secret are kept in `~/Library/Application Support/ai.captainspace.cutecaptain/secrets.json`, readable only by you (mode 600), together with your session. Not the Keychain: until the app is signed with a Developer ID, each build has a new identity and macOS hides the earlier build's Keychain items, so every update asked for the database again. Data uploads go to `~/Library/Application Support/ai.captainspace.cutecaptain/files`, and the server's log is in `~/Library/Logs/ai.captainspace.cutecaptain/server.log`. Before the rename the folders were named `ai.captainspace.desktop`; the first start after updating moves them to the new names, so the session and database settings carry over.
- The server starts with the app and stops when you quit. The menu bar menu has **Restart Captain on this Mac**.
- It serves the web app too: `http://127.0.0.1:8787` in any browser on that Mac.

### Voice and shortcuts

- **Shortcuts:** ⌃⇧C opens the panel to write. ⌃⇧Space talks to Captain: hold it while you talk, or tap it, talk, and tap again to send. Change either one in Settings → This Mac or the setup guide. If another app already uses the keys (Lock In uses ⌘⇧Space), or they're made only of ⌥ (macOS 15 refuses those), Settings says the shortcut isn't working.
- **Setup guide:** opens after your first sign-in, and any time from the menu bar icon → **Get started…**, Home, or Settings → This Mac. Each step has a quick test: Captain says back what it heard, sends a test banner, and shows a test snapshot.
- **The little Captain:** a small mascot that floats above other windows (from the "Captain Lite — floating Captain" design).
  - **Hold** it, or hold ⌃⇧Space, and talk. The talk card shows where it's going: name a chat ("…for the launch room") or agents ("have Writer…") and it picks them; otherwise it goes to Captain. Let go to send; Esc cancels.
  - **Type into <app>** on the talk card types what you said where your cursor is, in the app you were using ("new line" and "scratch that" work). macOS asks for Accessibility the first time.
  - After you send, a card shows the plan's steps as they go, then the answer, read aloud.
  - **Click** it for the card at the top right: what needs you (approve right there, or reply by voice) and what's being worked on. **Double-click** to talk hands-free.
  - **Drag** it anywhere; it settles on the nearest edge. **Right-click** for English or 中文, spoken answers on or off, or hide. The menu bar menu brings it back.
  - A gold count shows how many things need you.
- **How voice works:** the app carries a small helper, `captain-voice` (`src-tauri/voice/main.swift`). It uses Apple's speech recognition, on the Mac itself when the language allows, and Apple's voices to read answers aloud. macOS asks once for Microphone and Speech Recognition. Download better voices in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.
- Building the app yourself needs Xcode's command-line tools for the helpers (`npm run build:voice`, run automatically by `tauri build`).
- To use a hosted server instead, choose **A Captain server** on the sign-in screen.

### Agents on this Mac (computer use)

While Captain is open, agents you ask can work on your Mac: see the screen, read the app in front as text, click, type, press keys, open apps, files and addresses, and read or set the clipboard. Tell the little Captain "grab the total from my spreadsheet and email it to Sam" and it carries the task through on your screen.

- **Turn it on:** Settings → This Mac → **Agents on this Mac** (on by default once the permissions are granted), or the setup guide's **Agents on this Mac** step. It needs two permissions for Captain: **Accessibility** (to click, type and read apps) and **Screen Recording** (to see the screen). Settings shows which are on, with a button to the right page of System Settings, and a test that shows what Captain sees. Captain's own windows are left out of what it sees, so an agent never clicks Captain itself.
- **Asking you:** the first time a task needs the Mac, a decision card asks once ("Let Captain use Grace's MacBook for this task"); approve it in the panel, the thread or the little Captain. **Hands-free** (Settings → This Mac) skips that question. Either way, sending, paying, deleting and posting still ask first unless your request plainly said to do it.
- **While it works:** the little Captain shows each step ("Opening Numbers", "Typing…"). Keep your hands off the mouse and keyboard. **Esc** in any app, or Stop on the card, stops the run at once.
- **How it works:** the app carries a second helper, `captain-desk` (`src-tauri/desk/main.swift`). The dashboard window registers this Mac as a device over its connection to the server; each tool call an agent makes (`computer_screenshot`, `computer_click`, …) is relayed to the Mac, done by the helper, and answered. The server offers the tools only while the Mac is online, only to agents with **Use the person's Mac** on (Settings → Agents; Captain and Researcher by default), and only for the person who asked. Server limits: `AGENT_MAX_COMPUTER_ROUNDS` (80) actions per step.
- **Chrome too:** with the extension's **Let agents use this Chrome** on (see below), agents get `browser_*` tools and prefer them for web pages; without it they drive Chrome through the screen like any other app.

### Build it yourself

You need macOS 13 or newer, Xcode command-line tools, Rust (`rustup`), and Node 22.

```bash
cd desktop
npm install
npm run tauri build -- --bundles app,dmg
# → src-tauri/target/release/bundle/macos/cutecaptain.app and dmg/cutecaptain_0.1.0_aarch64.dmg
```

- The build copies the server into the app first (`npm run bundle:server`).
- `VITE_CAPTAIN_URL=https://captain.example.com` makes a hosted server the default instead of the built-in one.
- `npm run tauri dev` runs the app against the dev server.
- On first use, macOS asks for Screen Recording (snapshots), Microphone and Speech Recognition (voice typing), and Notifications.

### Signing and notarizing

With Quest Space's Apple Developer account, the GitHub build signs the app with its Developer ID and has Apple notarize it, so it opens without a warning. Someone with access to the account adds six repository secrets (GitHub → the repo → Settings → Secrets and variables → Actions):

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | The "Developer ID Application" certificate with its private key, exported from Keychain Access as a .p12 and encoded: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the .p12 |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, e.g. `Developer ID Application: Quest Space Inc. (AB12CD34EF)` (`security find-identity -v -p codesigning` lists it) |
| `APPLE_ID` | The Apple ID email of an account member |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com → Sign-In and Security → App-Specific Passwords) |
| `APPLE_TEAM_ID` | The 10-character team ID (developer.apple.com → Membership) |

Then run the workflow again. The run's summary says which signing it used. Without the secrets, builds are signed ad hoc.

## The Chrome extension

Install from the Mac app: setup guide → **The Chrome extension** → **Show the extension in Finder**, then in `chrome://extensions` turn on **Developer mode**, click **Load unpacked**, and choose that folder. Or unzip `Captain-Chrome-extension.zip` from the release and load that folder instead. To build it: `cd desktop && npm run build:extension` (output in `desktop/dist-extension`).

- **Toolbar button (or ⌥⇧C):** a popup to write to any chat, see what needs you, and approve or reject decisions. The panel button opens the same view in Chrome's side panel, which stays open next to the page and shows each conversation.
- **This page, Selection, Let agents read it:** add a link, a quote, or the page's text as a file agents read. Pages are read only when you click.
- **Right-click → Send to Captain:** a page, a link, selected text, an image, or a screenshot of the tab.
- **Badge:** decisions and mentions waiting for you, checked every minute.
- **Server:** it signs in to the Mac app's built-in server (**This Mac**) or to a hosted one, which Chrome asks to allow at sign-in.
- **Let agents use this Chrome** (a switch in the popup): this Chrome registers as a device, and agents you ask can open pages, read them as numbered elements, click, type (in rich editors too: Gmail, ChatGPT, Docs), press keys, choose in dropdowns, scroll and take screenshots, one action at a time, in a tab of their own or the one you're on. Turning it on asks Chrome once for permission on all sites and for the debugger (so Enter and shortcuts are real key presses; Chrome shows a "Captain started debugging this browser" bar while a key is pressed). The first time a task needs Chrome, a decision card asks you once; hands-free is per device in the Mac app's Settings → This Mac (or `PATCH /devices/:id`). The toolbar button's tooltip says what it's doing.
- **Permissions:**
  - The popup reads only the tab you opened it on.
  - The side panel asks Chrome once for permission to read pages, the first time you use a page button there.
  - "Let agents use this Chrome" asks for all sites and the debugger, from that click, and can be turned off again any time (chrome://extensions → Captain → Details to remove the permissions).

## Operating it

- **Upgrades:** deploy the new image. Migrations apply at start under a lock, so several instances starting at once is safe. Never edit an applied migration; add a new numbered file.
- **Backups:** back up the database (Supabase and other managed Postgres do this daily) and the files disk.
- **Logs:**
  - The logs are JSON in production.
  - Each model call is in the `usage_events` table.
  - Security-relevant actions are in `audit_log`: sign-ins, role changes, approvals, deleted messages.
- **Scaling:** see [ARCHITECTURE.md](ARCHITECTURE.md#scaling-and-availability). Before running more than one instance, put uploads on shared storage.

### Before inviting people you don't know

- [ ] `APP_SECRET` is set and the site is on HTTPS.
- [ ] `INSTANCE_ADMINS` names you, and you've signed up with that address.
- [ ] `OPEN_SIGNUP=false` until you're ready for strangers (and their model use) on your keys.
- [ ] `TRUST_PROXY` matches your setup (`1` behind one load balancer), so sign-in limits apply per real client.
- [ ] Decide on `OPEN_SIGNUP`, and set a monthly budget per workspace (Settings → Models & spend).
- [ ] Set `SMTP_URL` so "Forgot password?" can email links; without it, admins make reset links in Settings → People.
