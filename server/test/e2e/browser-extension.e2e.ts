// The Chrome extension for real: a real Chromium with desktop/dist-extension
// loaded, signed in to a real server, registers as a device; a scripted
// model works a made-up webmail page through it. Checks what can only be
// checked in a browser: Captain's tab opens in the background in a
// "Captain" group while the person's own tab stays in front, Send stops for
// approval with what it would send and goes through once approved, and a
// password field is refused.
//
//   cd desktop && npm run build:extension
//   cd server && npm run test:extension
//
// Needs Postgres (as for the other server tests) and Playwright's Chromium.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {Catalog} from '../../src/llm/catalog.js';
import type {EventEnvelope} from '../../src/shared/types.js';

import {fakeProvider, type FakeRequest, model, signup, socket, startServer, type TestServer, waitFor} from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(here, '../../../desktop/dist-extension');
const SITES = path.join(here, 'sites');
const EVIDENCE = path.join(here, 'evidence');

// Playwright isn't a server dependency; it's installed with the machine's tools.
type Page = {url(): string; evaluate<T>(fn: string | (() => T)): Promise<T>; screenshot(o: {path: string}): Promise<unknown>; goto(u: string): Promise<unknown>; bringToFront(): Promise<void>};
type Worker = {evaluate<T, A>(fn: (a: A) => T | Promise<T>, arg?: A): Promise<T>};
type Context = {pages(): Page[]; newPage(): Promise<Page>; serviceWorkers(): Worker[]; waitForEvent(e: string, o?: {timeout: number}): Promise<Worker>; close(): Promise<void>};
const {chromium} = createRequire(import.meta.url)('playwright') as {chromium: {launchPersistentContext(dir: string, o: Record<string, unknown>): Promise<Context>}};
// Inside the extension's worker (worker.evaluate), the Chrome APIs.
declare const chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any

type Post = {id: string; type: string; props: Record<string, any>};
type Run = {id: string; status: string; error: string | null};

// The built extension, with the permissions the popup would ask for granted up front.
function testExtension(): string {
    if (!fs.existsSync(path.join(EXTENSION, 'manifest.json'))) {
        throw new Error('Build the extension first: cd desktop && npm run build:extension');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-ext-'));
    fs.cpSync(EXTENSION, dir, {recursive: true});
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.permissions = [...m.permissions, 'debugger'];
    m.host_permissions = [...m.host_permissions, '<all_urls>'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    return dir;
}

async function sitesServer(): Promise<{url: string; close: () => Promise<void>}> {
    const server = http.createServer((req, res) => {
        const file = path.join(SITES, path.basename(new URL(req.url ?? '/', 'http://x').pathname) || 'feed.html');
        if (!fs.existsSync(file)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r()))};
}

// OpenAI's Responses API, scripted (the computer-use engine's side).
async function fakeResponses(next: (n: number) => Promise<Record<string, unknown>>): Promise<{url: string; calls: Record<string, any>[]; close: () => Promise<void>}> {
    const calls: Record<string, any>[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
            calls.push(JSON.parse(raw));
            const body = await next(calls.length);
            res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, close: () => new Promise((r) => server.close(() => r()))};
}

describe('the Chrome extension, in a real Chromium', () => {
    let s: TestServer;
    let provider: Awaited<ReturnType<typeof fakeProvider>>;
    let sites: Awaited<ReturnType<typeof sitesServer>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let dmId: string;
    let context: Context;
    let worker: Worker;
    let mine: Page; // the person's own tab
    let deviceId: string;
    let script: (req: FakeRequest) => ReturnType<Parameters<typeof fakeProvider>[0]>;
    let openai: Awaited<ReturnType<typeof fakeResponses>>;
    let respond: (n: number) => Promise<Record<string, unknown>> = async () => ({id: 'r', output: []});

    before(async () => {
        fs.mkdirSync(EVIDENCE, {recursive: true});
        provider = await fakeProvider((req) => script(req));
        sites = await sitesServer();
        process.env.TEST_EXT_KEY = 'k';
        openai = await fakeResponses((n) => respond(n));
        const catalog = new Catalog({
            providers: {p: {label: 'P', baseUrl: provider.url, apiKeyEnv: 'TEST_EXT_KEY'}, openai: {label: 'OpenAI', baseUrl: openai.url, apiKeyEnv: 'TEST_EXT_OPENAI_KEY'}},
            models: [model('text', 'balanced', 100, [['p', 'text-upstream']]), model('eyes', 'balanced', 50, [['p', 'eyes-upstream']], {vision: true})],
        });
        s = await startServer({catalog});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Extension'});
        const [{id: wsId}] = await owner.api.get('/workspaces');
        const agents: {handle: string; userId: string}[] = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
        dmId = (await owner.api.post(`/workspaces/${wsId}/dms`, {userId: agents.find((a) => a.handle === 'captain')!.userId})).id;

        const ext = testExtension();
        context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'captain-chrome-')), {
            channel: 'chromium', headless: true, viewport: {width: 1280, height: 800},
            args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'],
        });
        worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 15_000});
        // The person is doing something else, in their own tab.
        mine = context.pages()[0] ?? await context.newPage();
        await mine.goto(`${sites.url}/feed.html`);
        await mine.bringToFront();
        // Signed in, with "Let agents use this Chrome" on.
        const me = await owner.api.get('/users/me');
        await worker.evaluate(async (a: {serverUrl: string; token: string; userId: string}) => {
            await chrome.storage.local.set({'captain.session': JSON.stringify(a), 'captain.agents': true});
        }, {serverUrl: s.base, token: owner.session.token, userId: me.id});
        const device = await waitFor(async () => ((await owner.api.get('/devices')) as {id: string; kind: string; online: boolean; capabilities: string[]}[]).find((d) => d.kind === 'chrome' && d.online) ?? null, 15_000, 'the extension to register');
        deviceId = device.id;
        assert.ok(device.capabilities.includes('confirm_gate'));
        assert.ok(device.capabilities.includes('browser_input'));
        await owner.api.patch(`/devices/${deviceId}`, {autopilot: true});
    });
    after(async () => {
        await context?.close().catch(() => undefined);
        await s?.stop();
        await provider?.close();
        await sites?.close();
        await openai?.close();
        delete process.env.TEST_EXT_OPENAI_KEY;
    });

    const toolResults = (req: FakeRequest) => req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const refOf = (text: string, label: RegExp) => new RegExp(`\\[(e\\d+)\\] [^\\n]*"${label.source}`, 'i').exec(text)?.[1];
    type TabInfo = {id: number; url: string; active: boolean; groupId: number};
    const tabs = (): Promise<{id: number; url: string; active: boolean; group: string | null}[]> => worker.evaluate(async () => {
        const all: TabInfo[] = await chrome.tabs.query({});
        const ids = [...new Set(all.map((t) => t.groupId).filter((g) => g !== undefined && g >= 0))];
        const groups: {id: number; title: string}[] = await Promise.all(ids.map((g) => chrome.tabGroups.get(g)));
        return all.map((t) => ({id: t.id, url: t.url ?? '', active: t.active, group: groups.find((g) => g.id === t.groupId)?.title ?? null}));
    }, undefined);

    it('drafts in a background Captain tab, stops before Send with what it sends, and sends once approved; the person\'s tab never moves', async () => {
        const watcher = await socket(s.base, owner.session.token); // the Mac app's dashboard, say
        const results: string[][] = [];
        script = (req) => {
            const r = toolResults(req);
            results.push(r);
            if (!(req.tools ?? []).some((t) => t.function.name === 'browser_open')) {
                return {text: 'no browser'};
            }
            if (r.length === 0) {
                return {toolCalls: [{name: 'browser_open', args: {url: `${sites.url}/mail.html?to=leo@launchcrew.co&su=Tuesday&body=${encodeURIComponent('We\'re on for Tuesday. Launch kit attached.')}`}}]};
            }
            if (r.length === 1) {
                return {toolCalls: [{name: 'browser_click', args: {ref: refOf(r[0], /Send/) ?? 'e0'}}]};
            }
            if (r.length === 2) {
                return {toolCalls: [{name: 'browser_screenshot', args: {}}]};
            }
            return {text: 'Sent to Leo.'};
        };
        const post: Post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'email Leo that we are on for Tuesday'});
        const run = await waitFor(async () => ((await owner.api.get(`/channels/${dmId}/runs`)) as (Run & {triggerPostId: string})[]).find((x) => x.triggerPostId === post.id && x.status === 'waiting_approval') ?? null, 30_000, 'the run to stop at Send');

        // Captain's tab: in the background, in the Captain group. The person's: still in front, same page.
        const t = await tabs();
        const cards: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        assert.ok(cards.some((p) => p.type === 'decision'));
        const captainTab = t.find((x) => x.url.includes('mail.html'))!;
        assert.ok(captainTab, 'a Captain tab with the mail page');
        assert.equal(captainTab.active, false, 'Captain\'s tab stays in the background');
        assert.equal(captainTab.group, 'Captain');
        const theirs = t.find((x) => x.url.endsWith('/feed.html'))!;
        assert.equal(theirs.active, true, 'the person\'s tab is still the one in front');
        assert.equal(mine.url(), `${sites.url}/feed.html`);

        // The card says what would be sent, and nothing was sent yet.
        const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        const card = posts.find((p) => p.type === 'decision' && p.props.decision.runId === run.id && p.props.decision.status === 'pending')!;
        assert.match(card.props.decision.title, /^Captain wants to click "Send" in 127\.0\.0\.1$/);
        const fields = Object.fromEntries((card.props.decision.fields as {label: string; value: string}[]).map((f) => [f.label, f.value]));
        assert.equal(fields.To, 'leo@launchcrew.co');
        assert.equal(fields.Subject, 'Tuesday');
        assert.match(fields['Message Body'] ?? '', /We're on for Tuesday/);
        const mail = context.pages().find((p) => p.url().includes('mail.html'))!;
        assert.deepEqual(await mail.evaluate('window.__sent.length'), 0, 'nothing sent before the person says yes');
        await mail.screenshot({path: path.join(EVIDENCE, 'captain-tab-before-send.png')});

        // The little Captain on the Mac heard what Chrome was doing.
        const progress = watcher.events.filter((e: EventEnvelope) => e.event === 'device_progress').map((e) => e.data as {text: string; site?: string; thumb?: string; runId: string});
        assert.ok(progress.some((p) => p.runId === run.id && /Opening/.test(p.text)), 'progress reached the person\'s other screens');
        const pictures = progress.filter((p) => p.thumb).length;

        await owner.api.post(`/posts/${card.id}/actions/approve`);
        const done = await waitFor(async () => {
            const r: Run = await owner.api.get(`/runs/${run.id}`);
            return ['succeeded', 'failed', 'cancelled'].includes(r.status) ? r : null;
        }, 30_000, 'the run to finish');
        assert.equal(done.status, 'succeeded', done.error ?? '');
        const sent = await mail.evaluate('window.__sent') as {to: string[]; subject: string; body: string}[];
        assert.equal(sent.length, 1, `sent exactly once: ${JSON.stringify(sent)}`);
        assert.deepEqual(sent[0].to, ['leo@launchcrew.co']);
        assert.equal(sent[0].subject, 'Tuesday');
        await mail.screenshot({path: path.join(EVIDENCE, 'captain-tab-after-send.png')});
        assert.equal((await tabs()).find((x) => x.url.endsWith('/feed.html'))!.active, true, 'still the person\'s tab in front');

        // A picture of the background tab: Chrome may or may not draw it; either answer is fine, never a hang.
        const shot = results.flat().find((x) => /as it looks now|isn't drawing it/.test(x));
        assert.ok(shot, 'browser_screenshot answered for a background tab');
        console.log(`background tab: picture ${/as it looks now/.test(shot) ? 'taken' : 'not drawn'}; ${pictures} small pictures for the little Captain`);
        watcher.close();
    });

    it('refuses to type into a password field and says only the person can', async () => {
        const results: string[][] = [];
        script = (req) => {
            const r = toolResults(req);
            results.push(r);
            if (r.length === 0) {
                return {toolCalls: [{name: 'browser_open', args: {url: `${sites.url}/login.html`}}]};
            }
            if (r.length === 1) {
                return {toolCalls: [{name: 'browser_type', args: {ref: refOf(r[0], /Password/) ?? 'e0', text: 'hunter2'}}]};
            }
            return {text: 'I need you to sign in.'};
        };
        const post: Post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'sign me in'});
        await waitFor(async () => ((await owner.api.get(`/channels/${dmId}/runs`)) as (Run & {triggerPostId: string})[]).find((x) => x.triggerPostId === post.id && x.status === 'succeeded') ?? null, 30_000, 'the run');
        const told = results.flat().find((x) => /password, code or card field/.test(x));
        assert.ok(told, 'the agent was told it\'s a password field');
        assert.match(told, /hand_over/);
        const login = context.pages().find((p) => p.url().includes('login.html'))!;
        assert.equal(await login.evaluate('document.querySelector("[name=password]").value'), '', 'nothing typed into it');
    });

    it('the computer-use engine works a background tab by pixels: real clicks and typing, and Send still waits for the person', async () => {
        process.env.TEST_EXT_OPENAI_KEY = 'sk-test';
        const page = () => context.pages().find((p) => p.url().includes('mail.html?to=mia'))!;
        const center = (sel: string) => page().evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`) as Promise<{x: number; y: number}>;
        respond = async (n) => {
            if (n === 1) {
                const subject = await center('#subject');
                const send = await center('#send');
                return {id: 'resp_1', output: [{type: 'computer_call', call_id: 'c1', actions: [
                    {type: 'click', x: subject.x, y: subject.y, button: 'left'}, {type: 'keypress', keys: ['END']}, {type: 'type', text: ' (confirmed)'},
                    {type: 'click', x: send.x, y: send.y, button: 'left'},
                ], pending_safety_checks: []}]};
            }
            return {id: `resp_${n}`, output: [{type: 'message', content: [{type: 'output_text', text: 'Sent the note to Mia.'}]}]};
        };
        const results: string[][] = [];
        script = (req) => {
            const r = toolResults(req);
            results.push(r);
            if (!(req.tools ?? []).some((t) => t.function.name === 'browser_task')) {
                return {text: 'no browser_task'};
            }
            return r.length ? {text: 'Done.'} : {toolCalls: [{name: 'browser_task', args: {goal: 'Confirm the subject and send it', url: `${sites.url}/mail.html?to=mia@launchcrew.co&su=Launch&body=See%20you%20there`}}]};
        };
        const post: Post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'send mia the note'});
        const run = await waitFor(async () => ((await owner.api.get(`/channels/${dmId}/runs`)) as (Run & {triggerPostId: string})[]).find((x) => x.triggerPostId === post.id && ['waiting_approval', 'succeeded', 'failed'].includes(x.status)) ?? null, 40_000, 'the engine to stop at Send');
        assert.equal(run.status, 'waiting_approval', run.error ?? JSON.stringify(results).slice(0, 600));
        assert.equal(openai.calls[0].input[0].content[1].image_url.slice(0, 22), 'data:image/png;base64,', 'it started from a picture of the background tab');
        assert.deepEqual(await page().evaluate('window.__sent.length'), 0, 'nothing sent yet');
        assert.equal(await page().evaluate('document.getElementById("subject").value'), 'Launch (confirmed)', 'real typing in a background tab');
        const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        const card = posts.find((p) => p.type === 'decision' && p.props.decision.runId === run.id && p.props.decision.status === 'pending')!;
        assert.match(card.props.decision.title, /click "Send" in 127\.0\.0\.1/);
        await owner.api.post(`/posts/${card.id}/actions/approve`);
        const done = await waitFor(async () => {
            const r: Run = await owner.api.get(`/runs/${run.id}`);
            return ['succeeded', 'failed', 'cancelled'].includes(r.status) ? r : null;
        }, 30_000, 'the run to finish');
        assert.equal(done.status, 'succeeded', done.error ?? '');
        const sent = await page().evaluate('window.__sent') as {how: string; to: string[]; subject: string}[];
        assert.equal(sent.length, 1, JSON.stringify(sent));
        assert.equal(sent[0].how, 'click (trusted)', 'a real mouse click, through the debugger');
        assert.equal(sent[0].subject, 'Launch (confirmed)');
        assert.equal(openai.calls[1].input[0].type, 'computer_call_output');
        assert.ok(results.flat().some((x) => /Sent the note to Mia/.test(x)));
        assert.equal((await tabs()).find((x) => x.url.endsWith('/feed.html'))!.active, true, 'the person\'s tab is still in front');
        delete process.env.TEST_EXT_OPENAI_KEY;
    });
});
