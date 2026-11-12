// Captain using the person's other apps: the device's own stop before
// sending, paying or deleting (approval, then the same request again with the
// device's target), the hand-over when only the person can go on, the
// fastest-route guide, live progress for the little Captain, Show me, and
// the OpenAI computer-use engine against a fake Responses API.

import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {routeGuide} from '../src/agents/playbooks.js';
import {modelArgs} from '../src/agents/runner.js';
import {onOwnAccount} from '../src/connectors/composio.js';
import {Catalog} from '../src/llm/catalog.js';
import type {EventEnvelope} from '../src/shared/types.js';

import {fakeDevice, fakeProvider, type FakeRequest, model, signup, socket, startServer, systemText, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; rootId: string | null; props: Record<string, any>};
type Run = {id: string; status: string; error: string | null};

const PNG = `data:image/png;base64,${Buffer.from('a picture of the tab').toString('base64')}`;
const JPEG = `data:image/jpeg;base64,${Buffer.from('a small picture').toString('base64')}`;

// OpenAI's Responses API, scripted: each call gets the next scripted body.
type ResponsesCall = {body: Record<string, any>; auth?: string};
async function fakeResponses(next: (call: ResponsesCall, n: number) => Record<string, unknown>) {
    const calls: ResponsesCall[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const call = {body: JSON.parse(raw), auth: req.headers.authorization};
            calls.push(call);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(next(call, calls.length)));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r()))};
}

describe('browser use: Captain in the person\'s other apps', () => {
    let s: TestServer;
    let provider: Awaited<ReturnType<typeof fakeProvider>>;
    let openai: Awaited<ReturnType<typeof fakeResponses>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let other: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let dmId: string;

    let script: (req: FakeRequest) => ReturnType<Parameters<typeof fakeProvider>[0]>;
    let respond: (call: ResponsesCall, n: number) => Record<string, unknown> = () => ({id: 'r0', output: []});

    before(async () => {
        provider = await fakeProvider((req) => script(req));
        openai = await fakeResponses((c, n) => respond(c, n));
        process.env.TEST_BROWSER_KEY = 'k';
        delete process.env.TEST_OPENAI_KEY;
        const catalog = new Catalog({
            providers: {
                p: {label: 'P', baseUrl: provider.url, apiKeyEnv: 'TEST_BROWSER_KEY'},
                openai: {label: 'OpenAI', baseUrl: openai.url, apiKeyEnv: 'TEST_OPENAI_KEY'},
            },
            models: [
                model('text', 'balanced', 100, [['p', 'text-upstream']]),
                model('eyes', 'balanced', 50, [['p', 'eyes-upstream']], {vision: true}),
            ],
        });
        s = await startServer({catalog});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Browser use'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        other = await signup(s.base, {name: 'Mia', invite: invite.token});
        const agents: {handle: string; userId: string}[] = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
        dmId = (await owner.api.post(`/workspaces/${wsId}/dms`, {userId: agents.find((a) => a.handle === 'captain')!.userId})).id;
    });
    after(async () => {
        delete process.env.TEST_OPENAI_KEY;
        await s.stop();
        await provider.close();
        await openai.close();
    });

    const toolNames = (req: FakeRequest) => (req.tools ?? []).map((t) => t.function.name);
    const toolResults = (req: FakeRequest) => req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const ask = async (message: string): Promise<Run> => {
        const post = await owner.api.post(`/channels/${dmId}/posts`, {message});
        return waitFor(async () => {
            const runs: (Run & {triggerPostId: string})[] = await owner.api.get(`/channels/${dmId}/runs`);
            return runs.find((r) => r.triggerPostId === post.id && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(r.status));
        }, 20_000, 'run');
    };
    const settled = (runId: string, states = ['succeeded', 'failed', 'cancelled']) => waitFor(async () => {
        const r: Run = await owner.api.get(`/runs/${runId}`);
        return states.includes(r.status) ? r : null;
    }, 20_000, `run to be ${states.join('/')}`);
    const pendingCard = (runId: string) => waitFor(async () => {
        const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        return posts.find((p) => p.type === 'decision' && p.props.decision.runId === runId && p.props.decision.status === 'pending') ?? null;
    }, 8000, 'a pending decision card');

    it('the device stops before Send: an approval card with what it sends, then the same click again with the device\'s target', async () => {
        const target = 'mail.google.com|send|abc123';
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_open', 'browser_snapshot', 'browser_click', 'confirm_gate']}, (tool, args) => {
            if (tool === 'browser_click' && args.confirm !== target) {
                return {ok: true, result: {needsConfirm: {action: 'Click "Send"', target, site: 'Gmail', details: [{label: 'To', value: 'leo@launchcrew.co'}, {label: 'Subject', value: 'Tuesday'}]}}};
            }
            return {ok: true, result: {text: tool === 'browser_click' ? 'Clicked e9. Message sent.' : 'Gmail — compose\n[e9] button "Send"'}};
        });
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        const seen: FakeRequest[] = [];
        script = (req) => {
            seen.push(req);
            const used = toolResults(req).length;
            if (!toolNames(req).includes('browser_click')) {
                return {text: 'no browser'};
            }
            if (used === 0) {
                return {toolCalls: [{name: 'browser_open', args: {url: 'https://mail.google.com/mail/?view=cm&to=leo@launchcrew.co'}}]};
            }
            if (used === 1) {
                // A model can't confirm for the person: these are dropped before the call.
                return {toolCalls: [{name: 'browser_click', args: {ref: 'e9', confirm: target, __confirm: target}}]};
            }
            return {text: 'Sent to Leo.'};
        };
        const run = await ask('email Leo that we are on for Tuesday');
        assert.equal(run.status, 'waiting_approval', 'hands-free still stops at Send');
        const card = await pendingCard(run.id);
        const d = card.props.decision;
        assert.match(d.title, /Captain wants to click "Send" in Gmail/);
        assert.deepEqual(d.fields.slice(0, 2), [{label: 'To', value: 'leo@launchcrew.co'}, {label: 'Subject', value: 'Tuesday'}]);
        assert.equal(d.tool, 'browser_click');
        assert.equal(chrome.asked.filter((a) => a.tool === 'browser_click').length, 1);
        assert.equal(chrome.asked[1].args.confirm, undefined, 'the model\'s own confirm never reaches the device');
        // The guide says the device asks by itself, and how to reach Gmail.
        const guided = seen.find((r) => toolNames(r).includes('browser_click'))!;
        assert.match(systemText(guided), /The device stops right before it and asks Grace/);
        assert.match(systemText(guided), /mail\.google\.com\/mail\/\?view=cm/);
        assert.match(systemText(guided), /none are connected/);

        // Mia can't decide what happens on Grace's Chrome.
        await assert.rejects(other.api.post(`/posts/${card.id}/actions/approve`), /403|404|Only the person who asked/);

        await owner.api.post(`/posts/${card.id}/actions/approve`);
        const done = await settled(run.id);
        assert.equal(done.status, 'succeeded', done.error ?? '');
        const clicks = chrome.asked.filter((a) => a.tool === 'browser_click');
        assert.equal(clicks.length, 2);
        assert.equal(clicks[1].args.confirm, target, 'the approved click carries the device\'s target');
        assert.equal(clicks[1].args.ref, 'e9');
        const last = seen[seen.length - 1];
        assert.ok(toolResults(last).some((t) => t.includes('Message sent')));
        await chrome.close();
    });

    it('a declined Send is not done, and the agent hears it', async () => {
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_click', 'confirm_gate']}, (_tool, args) => (
            args.confirm ? {ok: true, result: {text: 'sent'}} : {ok: true, result: {needsConfirm: {action: 'Click "Delete forever"', target: 't', site: 'Gmail'}}}
        ));
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        let told = '';
        script = (req) => {
            const results = toolResults(req);
            if (!toolNames(req).includes('browser_click')) {
                return {text: 'no browser'};
            }
            if (!results.length) {
                return {toolCalls: [{name: 'browser_click', args: {ref: 'e3'}}]};
            }
            told = results[results.length - 1];
            return {text: 'OK, I left it.'};
        };
        const run = await ask('empty my trash');
        const card = await pendingCard(run.id);
        assert.match(card.props.decision.title, /click "Delete forever" in Gmail/);
        assert.deepEqual(card.props.decision.fields, [{label: 'Where', value: 'Gmail'}]);
        await owner.api.post(`/posts/${card.id}/actions/reject`);
        assert.equal((await settled(run.id)).status, 'succeeded');
        assert.match(told, /rejected this action/);
        assert.equal(chrome.asked.length, 1, 'nothing was sent again');
        await chrome.close();
    });

    it('a password field needs the person: the agent hands over, the card says Done / Stop, and it carries on', async () => {
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_type', 'browser_snapshot', 'confirm_gate']}, (tool) => (
            tool === 'browser_type' ? {ok: true, result: {needsPerson: 'That\'s a password field.'}} : {ok: true, result: {text: 'Inbox (3)'}}
        ));
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        const results: string[] = [];
        script = (req) => {
            const r = toolResults(req);
            if (!toolNames(req).includes('hand_over')) {
                return {text: 'no hand-over tool'};
            }
            if (r.length === 0) {
                return {toolCalls: [{name: 'browser_type', args: {ref: 'e2', text: 'hunter2'}}]};
            }
            if (r.length === 1) {
                results.push(r[0]);
                return {toolCalls: [{name: 'hand_over', args: {what: 'Sign in to Gmail in Captain\'s tab', why: 'it needs your password'}}]};
            }
            if (r.length === 2) {
                results.push(r[1]);
                return {toolCalls: [{name: 'browser_snapshot', args: {}}]};
            }
            return {text: 'Signed in; the inbox is open.'};
        };
        const run = await ask('check my gmail');
        assert.match(results[0], /password field/);
        assert.match(results[0], /hand_over/);
        const card = await pendingCard(run.id);
        const d = card.props.decision;
        assert.equal(d.kind, 'handover');
        assert.equal(d.deviceId, chrome.id);
        assert.match(d.title, /^Your turn: Sign in to Gmail/);
        assert.match(card.message, /your turn/);
        await owner.api.post(`/posts/${card.id}/actions/approve`);
        assert.equal((await settled(run.id)).status, 'succeeded');
        assert.match(results[1], /says it's done/);
        assert.deepEqual(chrome.asked.map((a) => a.tool), ['browser_type', 'browser_snapshot']);
        await chrome.close();
    });

    it('Chrome\'s progress reaches the person\'s other screens, Show me reaches the extension, and nobody else\'s', async () => {
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_open', 'confirm_gate']}, () => 'ignore');
        const mac = await socket(s.base, owner.session.token); // the Mac app's dashboard
        const mia = await socket(s.base, other.session.token);
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        script = (req) => (toolNames(req).includes('browser_open') && !toolResults(req).length ? {toolCalls: [{name: 'browser_open', args: {url: 'https://calendar.google.com/calendar/r/agenda'}}]} : {text: 'ok'});
        // The extension never answers here: the run stays at work while it reports progress.
        const post: Post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'what is on my calendar tomorrow'});
        const req = await waitFor(async () => chrome.asked[0] ?? null, 8000, 'the request');
        const run = await waitFor(async () => ((await owner.api.get(`/channels/${dmId}/runs`)) as (Run & {triggerPostId: string})[]).find((r) => r.triggerPostId === post.id) ?? null, 5000, 'the run');
        // The extension says what it's doing, with a small picture.
        chrome.send({action: 'device_progress', seq: 5, requestId: req.id, text: 'Opening calendar', site: 'Google Calendar', thumb: JPEG});
        const progress = await waitFor(async () => mac.events.find((e) => e.event === 'device_progress') ?? null, 5000, 'progress on the Mac');
        const p = progress.data as {deviceId: string; kind: string; runId: string; text: string; site: string; thumb: string; background: boolean};
        assert.equal(p.deviceId, chrome.id);
        assert.equal(p.kind, 'chrome');
        assert.equal(p.runId, run.id);
        assert.equal(p.site, 'Google Calendar');
        assert.equal(p.thumb, JPEG);
        assert.equal(p.background, true);
        assert.ok(!mia.events.some((e) => e.event === 'device_progress'), 'nobody else sees it');

        await owner.api.post(`/devices/${chrome.id}/show`, {});
        await waitFor(async () => chrome.events.find((e: EventEnvelope) => e.event === 'device_show') ?? null, 5000, 'show me');
        await assert.rejects(other.api.post(`/devices/${chrome.id}/show`, {}), /403|not yours/);
        await owner.api.post(`/runs/${run.id}/cancel`);
        mac.close();
        mia.close();
        await chrome.close();
    });

    it('the fastest route: connected apps first, then Chrome, then the screen, with the recipes for the apps asked about', () => {
        const tools = new Set(['gmail_send_email', 'gmail_fetch_emails', 'browser_open']);
        const guide = routeGuide({tools, chrome: true, mac: true}, 'reply to Leo and check my calendar for tomorrow', new Date(Date.UTC(2026, 10, 12)));
        assert.match(guide, /Thursday, November 12, 2026/);
        assert.match(guide, /1\. Connected apps, through their tools .*Gmail/);
        assert.match(guide, /### Gmail\n- Connected: gmail_send_email, gmail_fetch_emails\. Use these first\./);
        assert.match(guide, /### Google Calendar/);
        assert.match(guide, /calendar\.google\.com\/calendar\/r\/eventedit/);
        assert.ok(!/### ChatGPT/.test(guide), 'only the apps asked about');
        const noChrome = routeGuide({tools: new Set(), chrome: false, mac: true}, 'run this in chatgpt');
        assert.match(noChrome, /Their Chrome: not connected/);
        assert.ok(!/chatgpt\.com\/\?q=/.test(noChrome), 'no browser recipe without Chrome');
        // Only the person can decide what happens on their own devices.
        for (const t of ['browser_click', 'computer_click', 'screen_task', 'browser_task', 'hand_over']) {
            assert.equal(onOwnAccount(t), true, t);
        }
        // The model can't set what only an approval sets.
        assert.deepEqual(modelArgs('browser_click', {ref: 'e1', confirm: 'x', __cua: {}}), {ref: 'e1'});
        assert.deepEqual(modelArgs('mcp_notion_search', {confirm: true, __x: 1}), {confirm: true});
    });

    it('with an OpenAI key, browser_task runs OpenAI\'s computer-use loop through Chrome; Send and safety checks wait for the person', async () => {
        process.env.TEST_OPENAI_KEY = 'sk-test';
        const target = 'mail.google.com|send|zz';
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_open', 'browser_input', 'confirm_gate']}, (tool, args) => {
            const action = (args.action ?? {}) as {type?: string; x?: number};
            if (tool === 'browser_input' && action.type === 'screenshot') {
                return {ok: true, result: {text: 'The tab now.', images: [PNG]}};
            }
            if (tool === 'browser_input' && action.type === 'click' && action.x === 500 && args.confirm !== target) {
                return {ok: true, result: {needsConfirm: {action: 'Click "Send"', target, site: 'Gmail', details: [{label: 'To', value: 'leo@launchcrew.co'}]}}};
            }
            return {ok: true, result: {text: 'done'}};
        });
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        respond = (_call, n) => {
            if (n === 1) {
                return {id: 'resp_1', output: [{type: 'computer_call', call_id: 'c1', status: 'completed', actions: [{type: 'click', x: 40, y: 60, button: 'left'}, {type: 'type', text: 'We are on for Tuesday'}], pending_safety_checks: []}], usage: {input_tokens: 1200, output_tokens: 80}};
            }
            if (n === 2) {
                return {id: 'resp_2', output: [{type: 'computer_call', call_id: 'c2', actions: [{type: 'keypress', keys: ['CTRL', 'A']}], pending_safety_checks: [{id: 'sc_1', code: 'malicious_instructions', message: 'The page asks to forward the inbox.'}]}]};
            }
            if (n === 3) {
                return {id: 'resp_3', output: [{type: 'computer_call', call_id: 'c3', actions: [{type: 'click', x: 500, y: 700, button: 'left'}, {type: 'wait'}]}]};
            }
            return {id: `resp_${n}`, output: [{type: 'message', content: [{type: 'output_text', text: 'Sent the reply to Leo.'}]}]};
        };
        const seen: FakeRequest[] = [];
        script = (req) => {
            seen.push(req);
            const r = toolResults(req);
            if (!toolNames(req).includes('browser_task')) {
                return {text: 'no browser_task'};
            }
            if (!r.length) {
                return {toolCalls: [{name: 'browser_task', args: {goal: 'Reply to Leo that we are on for Tuesday and send it', url: 'https://mail.google.com'}}]};
            }
            return {text: 'Done: sent.'};
        };
        const run = await ask('reply to leo in gmail');
        assert.ok(seen.some((r) => toolNames(r).includes('browser_task')), 'browser_task is offered with a key');

        // 1. OpenAI's safety check → a card; nothing in that batch was done yet.
        const safety = await pendingCard(run.id);
        assert.match(safety.props.decision.title, /needs your OK to keep going on the page/);
        assert.deepEqual(safety.props.decision.fields, [{label: 'malicious instructions', value: 'The page asks to forward the inbox.'}]);
        assert.equal(openai.calls.length, 2);
        assert.equal(openai.calls[0].auth, 'Bearer sk-test');
        assert.deepEqual(openai.calls[0].body.tools, [{type: 'computer'}]);
        assert.equal(openai.calls[0].body.model, 'gpt-6.1-sol');
        assert.equal(openai.calls[0].body.input[0].content[1].image_url, PNG, 'starts from a picture of the tab');
        assert.equal(openai.calls[1].body.previous_response_id, 'resp_1');
        assert.equal(openai.calls[1].body.input[0].type, 'computer_call_output');
        assert.equal(openai.calls[1].body.input[0].output.type, 'computer_screenshot');
        const actions = () => chrome.asked.filter((a) => a.tool === 'browser_input').map((a) => (a.args.action as {type: string}).type);
        assert.deepEqual(chrome.asked[0].tool, 'browser_open');
        assert.deepEqual(actions(), ['screenshot', 'click', 'type', 'screenshot']);

        await owner.api.post(`/posts/${safety.id}/actions/approve`);
        // 2. The device's own stop before Send → another card.
        const send = await waitFor(async () => {
            const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
            return posts.find((p) => p.type === 'decision' && p.props.decision.runId === run.id && p.props.decision.status === 'pending' && /Send/.test(p.props.decision.title)) ?? null;
        }, 10_000, 'the Send card');
        assert.equal(openai.calls[2].body.input[0].acknowledged_safety_checks[0].id, 'sc_1', 'the person\'s yes goes back as an acknowledgement');
        assert.match(send.props.decision.title, /wants to click "Send" in Gmail/);
        await owner.api.post(`/posts/${send.id}/actions/approve`);
        const done = await settled(run.id);
        assert.equal(done.status, 'succeeded', done.error ?? '');
        const confirmed = chrome.asked.filter((a) => a.tool === 'browser_input' && (a.args.action as {x?: number}).x === 500);
        assert.equal(confirmed.length, 2);
        assert.equal(confirmed[1].args.confirm, target);
        assert.equal(openai.calls.length, 4);
        assert.equal(openai.calls[3].body.previous_response_id, 'resp_3');
        const final = seen[seen.length - 1];
        assert.ok(toolResults(final).some((t) => /Sent the reply to Leo/.test(t)), 'the model\'s words come back as the result');
        // Its tokens are on the bill like any other model's.
        const usage = await owner.api.get(`/workspaces/${wsId}/usage`).catch(() => null);
        if (usage && Array.isArray(usage.byModel)) {
            assert.ok(usage.byModel.some((m: {modelId?: string; model?: string}) => (m.modelId ?? m.model) === 'gpt-6.1-sol'));
        }
        delete process.env.TEST_OPENAI_KEY;
        await chrome.close();
    });

    it('without an OpenAI key there are no screen_task or browser_task tools', async () => {
        delete process.env.TEST_OPENAI_KEY;
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Mac', capabilities: ['computer_screenshot', 'confirm_gate']}, () => ({ok: true, result: {text: 'ok'}}));
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true});
        const offered: string[][] = [];
        script = (req) => {
            offered.push(toolNames(req));
            return {text: 'ok'};
        };
        await settled((await ask('open numbers')).id);
        assert.ok(offered.some((n) => n.includes('computer_screenshot') && n.includes('hand_over')));
        assert.ok(offered.every((n) => !n.includes('screen_task') && !n.includes('browser_task')));
        await mac.close();
    });
});
