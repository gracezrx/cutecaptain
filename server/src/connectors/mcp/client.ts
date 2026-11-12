// A small client for remote MCP servers over Streamable HTTP (as in
// Captain's main web product, backend/services/mcp_connector_service.py):
// every JSON-RPC message is a POST to the server's one URL; answers come
// back as JSON or as a short event stream. Each use does the handshake
// (initialize, then notifications/initialized) and keeps the session id the
// server hands out.

import {call, McpError} from './net.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOLS = 40;
const MAX_PAGES = 4;

export type McpAuth = {token: string; header?: string | null} | null;

export type McpToolInfo = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: {readOnlyHint?: boolean; destructiveHint?: boolean; title?: string};
};

type RpcAnswer = {result?: unknown; error?: {code?: number; message?: string}};

export class McpClient {
    private id = 0;
    private session: string | null = null;
    private version: string | null = null;
    serverName = '';

    constructor(private readonly url: string, private readonly auth: McpAuth, private readonly signal?: AbortSignal) {}

    private headers(): Record<string, string> {
        const h: Record<string, string> = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'};
        if (this.auth?.token) {
            if (this.auth.header) {
                h[this.auth.header] = this.auth.token;
            } else {
                h.Authorization = `Bearer ${this.auth.token}`;
            }
        }
        if (this.session) {
            h['Mcp-Session-Id'] = this.session;
        }
        if (this.version) {
            h['MCP-Protocol-Version'] = this.version;
        }
        return h;
    }

    private async post(message: Record<string, unknown>, timeoutMs: number): Promise<{text: string; type: string}> {
        const res = await call(this.url, {method: 'POST', headers: this.headers(), body: JSON.stringify(message), timeoutMs, signal: this.signal});
        if (res.status === 401 || res.status === 403) {
            throw new McpError(`The server turned down the sign-in (HTTP ${res.status}).`, res.status, res.headers.get('www-authenticate'));
        }
        if (res.status >= 400) {
            throw new McpError(`The server answered HTTP ${res.status}.`, res.status);
        }
        const session = res.headers.get('mcp-session-id');
        if (session) {
            this.session = session.slice(0, 256);
        }
        return {text: res.text, type: res.headers.get('content-type') ?? ''};
    }

    private async request(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
        const id = ++this.id;
        const {text, type} = await this.post({jsonrpc: '2.0', id, method, params}, timeoutMs);
        const answer = parseAnswer(text, type, id);
        if (!answer) {
            throw new McpError('The server sent an answer Captain couldn\'t read.');
        }
        if (answer.error) {
            // The server's own words aren't shown or kept: only the code.
            throw new McpError(`The server returned an error${typeof answer.error.code === 'number' ? ` (code ${answer.error.code})` : ''}.`);
        }
        return answer.result;
    }

    async initialize(): Promise<void> {
        const result = await this.request('initialize', {protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'cutecaptain', version: '1.0.0'}}) as {protocolVersion?: unknown; serverInfo?: {name?: unknown}} | undefined;
        this.version = typeof result?.protocolVersion === 'string' ? result.protocolVersion.slice(0, 32) : MCP_PROTOCOL_VERSION;
        this.serverName = typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name.slice(0, 100) : '';
        await this.post({jsonrpc: '2.0', method: 'notifications/initialized'}, 10_000);
    }

    async listTools(): Promise<McpToolInfo[]> {
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
            const result = await this.request('tools/list', cursor ? {cursor} : {}) as {tools?: unknown[]; nextCursor?: unknown} | undefined;
            for (const raw of result?.tools ?? []) {
                const t = raw as Record<string, unknown>;
                if (typeof t?.name !== 'string' || !t.name.trim() || tools.length >= MAX_TOOLS) {
                    continue;
                }
                const ann = (t.annotations && typeof t.annotations === 'object' ? t.annotations : {}) as Record<string, unknown>;
                tools.push({
                    name: t.name.trim().slice(0, 120),
                    description: typeof t.description === 'string' ? t.description.slice(0, 900) : '',
                    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema as Record<string, unknown> : {type: 'object', properties: {}},
                    annotations: {
                        ...(typeof ann.readOnlyHint === 'boolean' ? {readOnlyHint: ann.readOnlyHint} : {}),
                        ...(typeof ann.destructiveHint === 'boolean' ? {destructiveHint: ann.destructiveHint} : {}),
                        ...(typeof ann.title === 'string' ? {title: ann.title.slice(0, 120)} : {}),
                    },
                });
            }
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
            if (!cursor) {
                break;
            }
        }
        return tools;
    }

    async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{text: string; isError: boolean}> {
        const result = await this.request('tools/call', {name, arguments: args}, timeoutMs);
        return resultText(result);
    }
}

// The JSON-RPC answer with this id, from a JSON body or an event stream.
export function parseAnswer(text: string, type: string, id: number): RpcAnswer | null {
    const pick = (msg: unknown): RpcAnswer | null => {
        const m = msg as {id?: unknown; result?: unknown; error?: unknown};
        return m && m.id === id && ('result' in m || 'error' in m) ? m as RpcAnswer : null;
    };
    if (type.includes('text/event-stream')) {
        for (const event of text.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) {
                continue;
            }
            try {
                const parsed = JSON.parse(data);
                const hit = Array.isArray(parsed) ? parsed.map(pick).find(Boolean) : pick(parsed);
                if (hit) {
                    return hit;
                }
            } catch {
                // not JSON: skip
            }
        }
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.map(pick).find(Boolean) ?? null : pick(parsed);
    } catch {
        return null;
    }
}

const MAX_RESULT_CHARS = 20_000;

// A tool's result as text: its text and resource blocks, or its structured
// content as JSON when there's no text.
export function resultText(result: unknown): {text: string; isError: boolean} {
    const r = (result ?? {}) as {content?: unknown[]; structuredContent?: unknown; isError?: unknown};
    const parts: string[] = [];
    for (const block of (Array.isArray(r.content) ? r.content : []).slice(0, 50)) {
        const b = block as {type?: string; text?: unknown; resource?: {text?: unknown; uri?: unknown}};
        if (b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text);
        } else if (b.type === 'resource' && typeof b.resource?.text === 'string') {
            parts.push(b.resource.text);
        } else if (b.type === 'resource_link' && typeof (b as {uri?: unknown}).uri === 'string') {
            parts.push(String((b as {uri: string}).uri));
        }
    }
    if (!parts.length && r.structuredContent !== undefined) {
        parts.push(JSON.stringify(r.structuredContent));
    }
    let text = parts.join('\n\n');
    if (text.length > MAX_RESULT_CHARS) {
        text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[cut short]`;
    }
    return {text, isError: r.isError === true};
}
