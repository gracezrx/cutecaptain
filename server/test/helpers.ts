// Test harness: a real server on a random port against a fresh database
// (TEST_DATABASE_URL, default postgres://postgres@127.0.0.1:5432/captain_test),
// with a scriptable OpenAI-compatible model server for router tests.

import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';

import postgres from 'postgres';
import WebSocket from 'ws';

import {boot, type Instance} from '../src/boot.js';
import {Catalog, type ModelCfg} from '../src/llm/catalog.js';
import type {EventEnvelope, Session} from '../src/shared/types.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/captain_test';

export async function resetDatabase(): Promise<void> {
    const sql = postgres(TEST_DB, {max: 1, onnotice: () => undefined});
    await sql.unsafe('drop schema if exists public cascade; create schema public;');
    await sql.end();
}

export type TestServer = {
    base: string;
    instance: Instance;
    stop: () => Promise<void>;
};

export async function startServer(opts: {catalog?: Catalog} = {}): Promise<TestServer> {
    await resetDatabase();
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-files-'));
    const instance = await boot({databaseUrl: TEST_DB, filesDir, catalog: opts.catalog ?? new Catalog({providers: {}, models: []})});
    await instance.app.listen({port: 0, host: '127.0.0.1'});
    const port = (instance.app.server.address() as AddressInfo).port;
    return {
        base: `http://127.0.0.1:${port}`,
        instance,
        stop: async () => {
            await instance.stop();
            fs.rmSync(filesDir, {recursive: true, force: true});
        },
    };
}

export class ApiError extends Error {
    readonly status: number;
    readonly body: {error?: string; message?: string};

    constructor(status: number, body: {error?: string; message?: string}) {
        super(`${status} ${body.error}: ${body.message}`);
        this.status = status;
        this.body = body;
    }
}

export function client(base: string, token = '') {
    const call = async <T = any>(method: string, p: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${base}/api/v1${p}`, {
            method,
            headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {})},
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const json = (await res.json().catch(() => ({}))) as {error?: string; message?: string};
        if (!res.ok) {
            throw new ApiError(res.status, json);
        }
        return json as T;
    };
    return {
        token,
        get: <T = any>(p: string) => call<T>('GET', p),
        post: <T = any>(p: string, body: unknown = {}) => call<T>('POST', p, body),
        patch: <T = any>(p: string, body: unknown) => call<T>('PATCH', p, body),
        put: <T = any>(p: string, body: unknown) => call<T>('PUT', p, body),
        del: <T = any>(p: string) => call<T>('DELETE', p),
    };
}

export type Client = ReturnType<typeof client>;

let counter = 0;
export async function signup(base: string, opts: {name?: string; workspaceName?: string; invite?: string} = {}): Promise<{session: Session; api: Client}> {
    counter++;
    const session = await client(base).post<Session>('/auth/signup', {
        email: `person${counter}.${Date.now()}@example.com`, password: 'correct horse battery', name: opts.name ?? `Person ${counter}`,
        workspaceName: opts.workspaceName, invite: opts.invite,
    });
    return {session, api: client(base, session.token)};
}

export async function expectStatus(p: Promise<unknown>, status: number): Promise<ApiError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof ApiError && e.status === status) {
            return e;
        }
        throw new Error(`expected ${status}, got ${e instanceof ApiError ? e.status : e}`);
    }
    throw new Error(`expected ${status}, got success`);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) {
            return v;
        }
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

// A WebSocket client that records events.
export async function socket(base: string, token: string, extra: {connectionId?: string; lastSeq?: number} = {}): Promise<{ws: WebSocket; events: EventEnvelope[]; close: () => void}> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/websocket`);
    const events: EventEnvelope[] = [];
    ws.on('message', (m) => {
        const e = JSON.parse(m.toString());
        if (e.event) {
            events.push(e);
        }
    });
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    ws.send(JSON.stringify({action: 'auth', seq: 1, token, ...extra}));
    await waitFor(async () => events.find((e) => e.event === 'hello'), 3000, 'hello');
    return {ws, events, close: () => ws.close()};
}

// ------------------------------------------------------------ fake model provider

export type Scripted = {text?: string; toolCalls?: {name: string; args: Record<string, unknown>}[]; status?: number; delayMs?: number; errorMessage?: string};
export type FakeRequest = {model: string; messages: {role: string; content: unknown; tool_calls?: unknown}[]; tools?: {function: {name: string}}[]; stream?: boolean; auth?: string; max_tokens?: number};

export async function fakeProvider(script: (req: FakeRequest) => Scripted): Promise<{url: string; requests: FakeRequest[]; close: () => Promise<void>}> {
    const requests: FakeRequest[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
            const body = {...(JSON.parse(raw) as FakeRequest), auth: req.headers.authorization};
            requests.push(body);
            const s = script(body);
            if (s.delayMs) {
                await new Promise((r) => setTimeout(r, s.delayMs));
            }
            if (s.status && s.status !== 200) {
                res.writeHead(s.status, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: s.errorMessage ?? 'scripted failure', code: s.status}}));
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
            const text = s.text ?? '';
            for (let i = 0; i < text.length; i += 8) {
                send({choices: [{index: 0, delta: {content: text.slice(i, i + 8)}, finish_reason: null}]});
            }
            (s.toolCalls ?? []).forEach((c, i) => {
                const args = JSON.stringify(c.args);
                send({choices: [{index: 0, delta: {tool_calls: [{index: i, id: `call_${i}_${requests.length}`, type: 'function', function: {name: c.name, arguments: ''}}]}}]});
                send({choices: [{index: 0, delta: {tool_calls: [{index: i, function: {arguments: args.slice(0, 5)}}]}}]});
                send({choices: [{index: 0, delta: {tool_calls: [{index: i, function: {arguments: args.slice(5)}}]}}]});
            });
            send({choices: [{index: 0, delta: {}, finish_reason: s.toolCalls?.length ? 'tool_calls' : 'stop'}]});
            send({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 500}});
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return {url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r()))};
}

export function model(id: string, tier: ModelCfg['tier'], priority: number, routes: [string, string][], extra: Partial<ModelCfg> = {}): ModelCfg {
    return {id, label: id, vendor: 'Test', tier, priority, vision: false, tools: true, priceInPerM: 1, priceOutPerM: 2, routes, ...extra};
}

export function lastUserText(req: FakeRequest): string {
    const m = [...req.messages].reverse().find((x) => x.role === 'user');
    if (!m) {
        return '';
    }
    return typeof m.content === 'string' ? m.content : (m.content as {type: string; text?: string}[]).map((p) => p.text ?? '').join(' ');
}

export function systemText(req: FakeRequest): string {
    return req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
}

// ------------------------------------------------------------ devices

// A Mac app (or Chrome) on the socket: registers, answers requests with the
// given handler, and records what it was asked.
export async function fakeDevice(base: string, token: string, reg: {id?: string | null; kind: 'mac' | 'chrome'; name: string; capabilities?: string[]}, handler: (tool: string, args: Record<string, unknown>, id: string) => {ok: boolean; result?: unknown; error?: string} | 'ignore') {
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
            const out = handler(msg.data.tool, msg.data.args, msg.data.id);
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
    // A message of the device's own on its socket (device_progress…).
    const send = (msg: Record<string, unknown>) => sock.ws.send(JSON.stringify(msg));
    return {id: deviceId, asked, events: sock.events, close, send};
}
