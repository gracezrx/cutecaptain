// Agents using a person's Mac and Chrome: a fake device on the socket, a
// scripted model that looks, clicks and types, and what the person is asked.

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {Catalog} from '../src/llm/catalog.js';
import type {EventEnvelope} from '../src/shared/types.js';

import {expectStatus, fakeProvider, type FakeRequest, model, signup, socket, startServer, systemText, type TestServer, waitFor} from './helpers.js';

type Post = {id: string; type: string; message: string; userId: string; rootId: string | null; props: Record<string, any>};
type Run = {id: string; status: string; kind: string; rootPostId: string | null; error: string | null};
type Device = {id: string; kind: string; name: string; online: boolean; autopilot: boolean; capabilities: string[]};

const PNG = `data:image/png;base64,${Buffer.from('fake png bytes').toString('base64')}`;

// A Mac app (or Chrome) on the socket: registers, answers requests with the
// given handler, and records what it was asked.
async function fakeDevice(base: string, token: string, reg: {id?: string | null; kind: 'mac' | 'chrome'; name: string; capabilities?: string[]}, handler: (tool: string, args: Record<string, unknown>) => {ok: boolean; result?: unknown; error?: string} | 'ignore') {
    const sock = await socket(base, token);
    const asked: {id: string; tool: string; args: Record<string, unknown>; runId: string | null}[] = [];
    let deviceId = '';
    sock.ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.status === 'OK' && msg.data?.deviceId) {
            deviceId = msg.data.deviceId;
        }
        if (msg.event === 'device_request' && msg.data.deviceId === deviceId) {
            asked.push({id: msg.data.id, tool: msg.data.tool, args: msg.data.args, runId: msg.data.runId});
            const out = handler(msg.data.tool, msg.data.args);
            if (out !== 'ignore') {
                sock.ws.send(JSON.stringify({action: 'device_result', seq: 99, requestId: msg.data.id, ...out}));
            }
        }
    });
    sock.ws.send(JSON.stringify({action: 'device_register', seq: 2, device: {id: reg.id ?? null, kind: reg.kind, name: reg.name, capabilities: reg.capabilities ?? []}}));
    await waitFor(async () => deviceId || null, 3000, 'device id');
    // Closing waits until the server has marked it offline.
    const close = async () => {
        sock.close();
        await waitFor(async () => {
            const res = await fetch(`${base}/api/v1/devices`, {headers: {Authorization: `Bearer ${token}`}});
            const list = (await res.json()) as {id: string; online: boolean}[];
            const me = list.find((d) => d.id === deviceId);
            return !me || !me.online || null;
        }, 5000, 'device offline');
    };
    return {id: deviceId, asked, events: sock.events, close};
}

describe('devices: agents using the person\'s Mac and Chrome', () => {
    let s: TestServer;
    let provider: Awaited<ReturnType<typeof fakeProvider>>;
    let owner: Awaited<ReturnType<typeof signup>>;
    let other: Awaited<ReturnType<typeof signup>>;
    let wsId: string;
    let generalId: string;
    let dmId: string;
    let captainUserId: string;

    // The model's script for the current test, keyed by what it sees.
    let script: (req: FakeRequest) => ReturnType<Parameters<typeof fakeProvider>[0]>;

    before(async () => {
        provider = await fakeProvider((req) => script(req));
        process.env.TEST_DEVICE_KEY = 'k';
        const catalog = new Catalog({
            providers: {p: {label: 'P', baseUrl: provider.url, apiKeyEnv: 'TEST_DEVICE_KEY'}},
            models: [
                model('text', 'balanced', 100, [['p', 'text-upstream']]),
                model('eyes', 'balanced', 50, [['p', 'eyes-upstream']], {vision: true}),
            ],
        });
        s = await startServer({catalog});
        owner = await signup(s.base, {name: 'Grace', workspaceName: 'Devices'});
        [{id: wsId}] = await owner.api.get('/workspaces');
        const invite = await owner.api.post(`/workspaces/${wsId}/invites`, {});
        other = await signup(s.base, {name: 'Mia', invite: invite.token});
        generalId = (await owner.api.get(`/workspaces/${wsId}/channels`)).channels[0].id;
        const agents: {handle: string; userId: string}[] = (await owner.api.get(`/workspaces/${wsId}/agents`)).agents;
        captainUserId = agents.find((a) => a.handle === 'captain')!.userId;
        dmId = (await owner.api.post(`/workspaces/${wsId}/dms`, {userId: captainUserId})).id;
    });
    after(async () => {
        await s.stop();
        await provider.close();
    });

    const ask = async (api: typeof owner.api, message: string, channelId = dmId): Promise<{post: Post; run: Run}> => {
        const post = await api.post(`/channels/${channelId}/posts`, {message});
        const run = await waitFor(async () => {
            const runs: (Run & {triggerPostId: string})[] = await api.get(`/channels/${channelId}/runs`);
            return runs.find((r) => r.triggerPostId === post.id && ['succeeded', 'failed', 'cancelled', 'waiting_approval'].includes(r.status));
        }, 20_000, 'run');
        return {post, run};
    };
    const settled = (runId: string) => waitFor(async () => {
        const r: Run = await owner.api.get(`/runs/${runId}`);
        return ['succeeded', 'failed', 'cancelled'].includes(r.status) ? r : null;
    }, 20_000, 'run to end');
    const toolNames = (req: FakeRequest) => (req.tools ?? []).map((t) => t.function.name);
    const lastTool = (req: FakeRequest) => [...req.messages].reverse().find((m) => m.role === 'tool') as {content: string} | undefined;

    it('a device registers over the socket, is listed, and goes offline when the socket closes', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Grace\'s MacBook', capabilities: ['computer_screenshot', 'computer_click']}, () => ({ok: true, result: {text: 'ok'}}));
        const [d]: Device[] = await owner.api.get('/devices');
        assert.equal(d.id, mac.id);
        assert.equal(d.kind, 'mac');
        assert.equal(d.online, true);
        assert.equal(d.autopilot, false);
        assert.deepEqual(d.capabilities, ['computer_screenshot', 'computer_click']);
        assert.ok(mac.events.some((e: EventEnvelope) => e.event === 'device_updated' && (e.data as {device: Device}).device.online));
        // Nobody else sees or changes it.
        assert.deepEqual(await other.api.get('/devices'), []);
        await expectStatus(other.api.patch(`/devices/${mac.id}`, {autopilot: true}), 403);
        await mac.close();
        assert.equal(((await owner.api.get('/devices')) as Device[])[0].online, false);
        // The same id, registering again, is the same device (its settings stick).
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true, name: 'Studio Mac'});
        const again = await fakeDevice(s.base, owner.session.token, {id: mac.id, kind: 'mac', name: 'Grace\'s MacBook'}, () => ({ok: true}));
        assert.equal(again.id, mac.id);
        const [after1]: Device[] = await owner.api.get('/devices');
        assert.equal(after1.autopilot, true);
        assert.equal(after1.online, true);
        await again.close();
        await owner.api.del(`/devices/${mac.id}`);
        assert.deepEqual(await owner.api.get('/devices'), []);
    });

    it('with no device online, agents get no computer or browser tools', async () => {
        const seen: string[][] = [];
        script = (req) => {
            seen.push(toolNames(req));
            return {text: 'No screen here.'};
        };
        const {run} = await ask(owner.api, 'click the button on my screen');
        assert.equal(run.status, 'succeeded');
        assert.ok(seen.length >= 1);
        assert.ok(seen.every((names) => !names.some((n) => n.startsWith('computer_') || n.startsWith('browser_'))));
    });

    it('asks once per task, then looks, clicks and types on the Mac; screenshots reach a vision model', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Grace\'s MacBook'}, (tool) => {
            if (tool === 'computer_screenshot') {
                return {ok: true, result: {text: 'Screen 1440×900. Front app: Numbers.', images: [PNG]}};
            }
            if (tool === 'computer_read_screen') {
                return {ok: true, result: {text: '[1] cell "Revenue" (120,200)\n[2] cell "$42,000" (260,200)'}};
            }
            return {ok: true, result: {text: 'done'}};
        });
        const requests: FakeRequest[] = [];
        script = (req) => {
            requests.push(req);
            const names = toolNames(req);
            const toolsUsed = req.messages.filter((m) => m.role === 'tool').length;
            if (!names.includes('computer_screenshot')) {
                return {text: 'no device tools'};
            }
            if (toolsUsed === 0) {
                return {toolCalls: [{name: 'computer_screenshot', args: {}}]};
            }
            if (toolsUsed === 1) {
                return {toolCalls: [{name: 'computer_read_screen', args: {}}, {name: 'computer_click', args: {x: 260, y: 200, count: 2}}]};
            }
            if (toolsUsed === 3) {
                return {toolCalls: [{name: 'computer_type', args: {text: 'hello', submit: true}}]};
            }
            return {text: 'Revenue is $42,000. I typed hello into the cell.'};
        };
        const {post, run} = await ask(owner.api, 'read revenue from my spreadsheet and type hello');
        // The first action waits for the person.
        assert.equal(run.status, 'waiting_approval');
        assert.equal(mac.asked.length, 0, 'nothing reaches the Mac before the person says yes');
        const [card] = await waitFor(async () => {
            const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
            const cards = posts.filter((p) => p.type === 'decision' && p.props.decision.status === 'pending');
            return cards.length ? cards : null;
        }, 5000, 'decision card');
        assert.match(card.props.decision.title, /Let Captain use Grace's MacBook for this task/);
        assert.equal(card.props.decision.fields[0].value, 'Looking at the screen');
        // The system prompt explains how to work on the screen.
        const offered = requests.find((r) => toolNames(r).includes('computer_screenshot'))!;
        assert.match(systemText(offered), /Using Grace's Mac/);
        assert.match(systemText(offered), /computer_read_screen/);
        assert.ok(!toolNames(offered).includes('use_computer'), 'the switch itself is not a tool');
        assert.ok(toolNames(offered).includes('computer_clipboard'), 'a device with no capability list gets every tool');
        assert.ok(!toolNames(offered).some((n) => n.startsWith('browser_')), 'no Chrome, no browser tools');

        await owner.api.post(`/posts/${card.id}/actions/approve`);
        const done = await settled(run.id);
        assert.equal(done.status, 'succeeded', done.error ?? '');
        assert.deepEqual(mac.asked.map((a) => a.tool), ['computer_screenshot', 'computer_read_screen', 'computer_click', 'computer_type']);
        assert.deepEqual(mac.asked[2].args, {x: 260, y: 200, count: 2});
        assert.ok(mac.asked.every((a) => a.runId === run.id));
        // One question for the whole task: the later actions didn't ask again.
        const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        assert.equal(posts.filter((p) => p.type === 'decision' && p.rootId === null && p.props.decision.runId === run.id).length, 1);
        // After the screenshot, the model that continued could see, and saw the image after the tool result.
        const withImage = requests.find((r) => r.messages.some((m) => Array.isArray(m.content) && (m.content as {type: string}[]).some((p) => p.type === 'image_url')))!;
        assert.ok(withImage, 'the screenshot reached the model');
        assert.equal(withImage.model, 'eyes-upstream');
        const idx = withImage.messages.findIndex((m) => Array.isArray(m.content));
        assert.equal(withImage.messages[idx - 1].role, 'tool');
        assert.match(String((withImage.messages[idx].content as {text?: string}[])[0].text), /latest image/);
        // The read-screen text came back as the tool's result.
        const read = requests.find((r) => r.messages.some((m) => m.role === 'tool' && String(m.content).includes('$42,000')));
        assert.ok(read, 'the screen text reached the model');
        // The device hears when the run ends.
        await waitFor(async () => mac.events.some((e: EventEnvelope) => e.event === 'device_released' && (e.data as {runId: string}).runId === run.id) || null, 3000, 'released');
        assert.ok(post.id);
        await mac.close();
    });

    it('a device on hands-free is used without asking; Chrome gets the browser tools', async () => {
        const chrome = await fakeDevice(s.base, owner.session.token, {kind: 'chrome', name: 'Chrome', capabilities: ['browser_tabs', 'browser_open', 'browser_snapshot', 'browser_click', 'browser_type']}, (tool) => {
            if (tool === 'browser_open') {
                return {ok: true, result: {text: 'Gmail — Inbox\n[e1] button "Compose"\n[e2] textbox "Search mail"'}};
            }
            return {ok: true, result: {text: 'ok'}};
        });
        await owner.api.patch(`/devices/${chrome.id}`, {autopilot: true});
        script = (req) => {
            const names = toolNames(req);
            const used = req.messages.filter((m) => m.role === 'tool').length;
            if (!names.includes('browser_open')) {
                return {text: 'no browser'};
            }
            assert.ok(!names.includes('browser_screenshot'), 'only what the extension says it can do');
            assert.ok(!names.includes('computer_screenshot'));
            if (used === 0) {
                return {toolCalls: [{name: 'browser_open', args: {url: 'https://mail.google.com'}}]};
            }
            if (used === 1) {
                return {toolCalls: [{name: 'browser_click', args: {ref: 'e1'}}]};
            }
            return {text: 'Opened Gmail and started a new message.'};
        };
        const {run} = await ask(owner.api, 'open gmail and start an email');
        assert.equal(run.status, 'succeeded', run.error ?? '');
        assert.deepEqual(chrome.asked.map((a) => a.tool), ['browser_open', 'browser_click']);
        const posts: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        assert.ok(!posts.some((p) => p.type === 'decision' && p.props.decision.runId === run.id), 'hands-free: no question');
        await chrome.close();
    });

    it('a device that fails or stays silent tells the agent, which can still answer', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Mac'}, (tool) => (tool === 'computer_open' ? {ok: false, error: 'Captain needs Screen Recording permission.'} : {ok: true, result: {text: 'ok'}}));
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true});
        let told = '';
        script = (req) => {
            const used = req.messages.filter((m) => m.role === 'tool').length;
            if (!toolNames(req).includes('computer_open')) {
                return {text: 'no tools'};
            }
            if (used === 0) {
                return {toolCalls: [{name: 'computer_open', args: {app: 'Numbers'}}]};
            }
            told = lastTool(req)!.content;
            return {text: `Couldn't: ${told}`};
        };
        const {run} = await ask(owner.api, 'open numbers');
        assert.equal(run.status, 'succeeded');
        assert.match(told, /computer_open tool failed: Captain needs Screen Recording permission/);
        await mac.close();
    });

    it('a request nobody answers times out, and stopping the run cancels what is pending', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Sleepy Mac'}, () => 'ignore');
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true});
        script = (req) => {
            const used = req.messages.filter((m) => m.role === 'tool').length;
            if (!toolNames(req).includes('computer_click')) {
                return {text: 'no tools'};
            }
            if (used === 0) {
                return {toolCalls: [{name: 'computer_click', args: {x: 1, y: 1}}]};
            }
            return {text: 'gave up'};
        };
        const post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'click somewhere'});
        const run = await waitFor(async () => {
            const runs: (Run & {triggerPostId: string})[] = await owner.api.get(`/channels/${dmId}/runs`);
            return runs.find((r) => r.triggerPostId === post.id && r.status === 'running');
        }, 10_000, 'running');
        await waitFor(async () => (mac.asked.length ? true : null), 5000, 'request sent');
        await owner.api.post(`/runs/${run.id}/cancel`);
        const ended = await settled(run.id);
        assert.equal(ended.status, 'cancelled');
        await waitFor(async () => {
            const [row] = await s.instance.ctx.sql`select status from device_requests where id = ${mac.asked[0].id}`;
            return row.status === 'cancelled' || null;
        }, 5000, 'the pending request to be cancelled');
        await mac.close();
    });

    it('a device can answer over HTTP too, and only for its own requests', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Mac'}, () => 'ignore');
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true});
        script = (req) => {
            const used = req.messages.filter((m) => m.role === 'tool').length;
            if (!toolNames(req).includes('computer_apps')) {
                return {text: 'no tools'};
            }
            if (used === 0) {
                return {toolCalls: [{name: 'computer_apps', args: {}}]};
            }
            return {text: lastTool(req)!.content};
        };
        const post = await owner.api.post(`/channels/${dmId}/posts`, {message: 'what is open?'});
        await waitFor(async () => (mac.asked.length ? true : null), 5000, 'request sent');
        const req = mac.asked[0];
        // Someone else can't answer for it.
        await expectStatus(other.api.post(`/devices/${mac.id}/requests/${req.id}`, {ok: true, result: {text: 'nope'}}), 403);
        await owner.api.post(`/devices/${mac.id}/requests/${req.id}`, {ok: true, result: {text: 'Numbers, Chrome (front)'}});
        const run = await waitFor(async () => {
            const runs: (Run & {triggerPostId: string})[] = await owner.api.get(`/channels/${dmId}/runs`);
            return runs.find((r) => r.triggerPostId === post.id && r.status === 'succeeded');
        }, 10_000, 'run');
        const thread: Post[] = await owner.api.get(`/channels/${dmId}/posts`);
        const answer = thread.find((p) => p.userId === captainUserId && p.message.includes('Numbers, Chrome'));
        assert.ok(answer, 'the HTTP answer reached the agent');
        assert.ok(run.id);
        await mac.close();
    });

    it('a bot asking a bot never gets device tools; the planner is told screen work is one step at a time', async () => {
        const mac = await fakeDevice(s.base, owner.session.token, {kind: 'mac', name: 'Mac'}, () => ({ok: true, result: {text: 'ok'}}));
        await owner.api.patch(`/devices/${mac.id}`, {autopilot: true});
        const systems: string[] = [];
        script = (req) => {
            systems.push(systemText(req));
            if (systemText(req).startsWith('ROLE: PLANNER')) {
                return {text: '{"mode":"direct"}'};
            }
            return {text: 'ok'};
        };
        const {run} = await ask(owner.api, '@captain open the Q3 spreadsheet in Numbers, pull the revenue total from the summary tab, and email it to Sam with a short note', generalId);
        assert.equal(run.status, 'succeeded');
        const planner = systems.find((t) => t.startsWith('ROLE: PLANNER'));
        assert.ok(planner && /one mouse/.test(planner));
        await mac.close();
        assert.ok(generalId);
    });
});
