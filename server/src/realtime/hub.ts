// The real-time hub, modeled on Mattermost's web hub:
// - one WebSocket per window; the first message authenticates it
// - every event has a sequence number per connection; the last 256 sent are
//   kept, so a client that reconnects within two minutes gets a lossless replay
// - "droppable" events (typing, streaming text) are skipped for a client whose
//   send buffer is backed up; everything else is always delivered
// - with several server instances, events travel between them over Postgres
//   LISTEN/NOTIFY (see cluster.ts)

import type {WebSocket} from 'ws';

import type {ClientMessage, DeviceRegistration, EventEnvelope, ServerEvent} from '../shared/types.js';
import {newId} from '../util/ids.js';
import {log} from '../util/log.js';

const BUFFER = 256;
const REPLAY_WINDOW_MS = 120_000;
const AUTH_TIMEOUT_MS = 10_000;
const SLOW_CLIENT_BYTES = 1_000_000;

type Conn = {
    id: string;
    userId: string;
    sessionId: string;
    ws: WebSocket | null;
    seq: number;
    buffer: EventEnvelope[];
    alive: boolean;
    disconnectedAt: number | null;
    device: string | null; // the device id this socket registered as
};

export type PublishOptions = {droppable?: boolean; exceptConnectionId?: string};

export type HubDeps = {
    authenticate: (token: string) => Promise<{userId: string; sessionId: string} | null>;
    // Which of these sessions are still signed in (checked on every sweep).
    validSessions?: (sessionIds: string[]) => Promise<Set<string>>;
    onTyping: (userId: string, channelId: string, rootId: string | null, connectionId: string) => Promise<void>;
    forward?: (userIds: string[], event: ServerEvent, opts: PublishOptions) => void; // to other nodes
    // Devices (the Mac app, the Chrome extension) on this socket.
    onDeviceRegister?: (userId: string, connectionId: string, device: DeviceRegistration) => Promise<{id: string} | {error: string}>;
    onDeviceResult?: (userId: string, connectionId: string, requestId: string, ok: boolean, result: unknown, error: string | undefined) => Promise<void>;
    onDeviceProgress?: (userId: string, connectionId: string, requestId: string, progress: {text?: string; site?: string; thumb?: string}) => Promise<void>;
    onDeviceClosed?: (connectionId: string) => Promise<void>;
    onDevicesAlive?: (connectionIds: string[]) => Promise<void>; // every sweep, the live sockets
};

export class Hub {
    private conns = new Map<string, Conn>();
    private byUser = new Map<string, Set<string>>();
    private pinger: NodeJS.Timeout | null = null;
    private readonly deps: HubDeps;

    constructor(deps: HubDeps) {
        this.deps = deps;
    }

    start(): void {
        this.pinger = setInterval(() => this.sweep(), 30_000);
    }

    stop(): void {
        if (this.pinger) {
            clearInterval(this.pinger);
        }
        for (const c of this.conns.values()) {
            c.ws?.close(1001, 'server shutting down');
        }
    }

    get connectionCount(): number {
        let n = 0;
        for (const c of this.conns.values()) {
            n += c.ws ? 1 : 0;
        }
        return n;
    }

    isOnline(userId: string): boolean {
        return [...(this.byUser.get(userId) ?? [])].some((id) => this.conns.get(id)?.ws);
    }

    // A new socket: wait for {action: "auth"} before sending anything.
    accept(ws: WebSocket): void {
        let authed = false;
        const timer = setTimeout(() => !authed && ws.close(4001, 'authentication timeout'), AUTH_TIMEOUT_MS);
        ws.on('message', async (raw) => {
            let msg: ClientMessage;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (!authed) {
                if (msg.action !== 'auth') {
                    ws.close(4001, 'authenticate first');
                    return;
                }
                const who = await this.deps.authenticate(msg.token).catch(() => null);
                if (!who) {
                    ws.send(JSON.stringify({status: 'FAIL', seqReply: msg.seq, error: 'invalid session'}));
                    ws.close(4001, 'invalid session');
                    return;
                }
                authed = true;
                clearTimeout(timer);
                this.bind(ws, who.userId, who.sessionId, msg.connectionId, msg.lastSeq);
                return;
            }
            const conn = this.connFor(ws);
            if (!conn) {
                return;
            }
            if (msg.action === 'ping') {
                ws.send(JSON.stringify({status: 'OK', seqReply: msg.seq, data: {text: 'pong', serverTime: Date.now()}}));
            } else if (msg.action === 'typing' && typeof msg.channelId === 'string') {
                void this.deps.onTyping(conn.userId, msg.channelId, msg.rootId ?? null, conn.id).catch(() => undefined);
            } else if (msg.action === 'device_register' && this.deps.onDeviceRegister && msg.device && typeof msg.device === 'object') {
                const d = msg.device;
                const reg: DeviceRegistration = {
                    id: typeof d.id === 'string' && d.id ? d.id : null,
                    kind: d.kind === 'chrome' ? 'chrome' : 'mac',
                    name: String(d.name ?? '').slice(0, 80) || (d.kind === 'chrome' ? 'Chrome' : 'Mac'),
                    capabilities: Array.isArray(d.capabilities) ? d.capabilities.filter((c): c is string => typeof c === 'string').slice(0, 100) : [],
                };
                const out = await this.deps.onDeviceRegister(conn.userId, conn.id, reg).catch((e: Error) => ({error: e.message}));
                conn.device = 'id' in out ? out.id : null;
                ws.send(JSON.stringify('id' in out ? {status: 'OK', seqReply: msg.seq, data: {deviceId: out.id}} : {status: 'FAIL', seqReply: msg.seq, error: out.error}));
            } else if (msg.action === 'device_result' && this.deps.onDeviceResult && typeof msg.requestId === 'string') {
                void this.deps.onDeviceResult(conn.userId, conn.id, msg.requestId, Boolean(msg.ok), msg.result, typeof msg.error === 'string' ? msg.error : undefined).catch(() => undefined);
            } else if (msg.action === 'device_progress' && this.deps.onDeviceProgress && typeof msg.requestId === 'string') {
                const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
                const thumb = typeof msg.thumb === 'string' && msg.thumb.length <= 200_000 ? msg.thumb : undefined; // a small picture, or none
                void this.deps.onDeviceProgress(conn.userId, conn.id, msg.requestId, {text: str(msg.text, 200), site: str(msg.site, 120), thumb}).catch(() => undefined);
            }
        });
        ws.on('pong', () => {
            const c = this.connFor(ws);
            if (c) {
                c.alive = true;
            }
        });
        ws.on('close', () => {
            clearTimeout(timer);
            const c = this.connFor(ws);
            if (c) {
                c.ws = null;
                c.disconnectedAt = Date.now();
                if (c.device) {
                    // A device is only usable while its socket is up: it registers again on reconnect.
                    c.device = null;
                    void this.deps.onDeviceClosed?.(c.id).catch(() => undefined);
                }
            }
        });
        ws.on('error', () => undefined);
    }

    private connFor(ws: WebSocket): Conn | undefined {
        return (ws as unknown as {__conn?: Conn}).__conn;
    }

    private bind(ws: WebSocket, userId: string, sessionId: string, connectionId?: string, lastSeq?: number): void {
        const previous = connectionId ? this.conns.get(connectionId) : undefined;
        let conn: Conn;
        let replayed = false;
        if (previous && previous.userId === userId && !previous.ws && typeof lastSeq === 'number' && this.canReplay(previous, lastSeq)) {
            conn = previous;
            conn.ws = ws;
            conn.sessionId = sessionId;
            conn.disconnectedAt = null;
            replayed = true;
        } else {
            conn = {id: newId(), userId, sessionId, ws, seq: 0, buffer: [], alive: true, disconnectedAt: null, device: null};
            this.conns.set(conn.id, conn);
            const set = this.byUser.get(userId) ?? new Set();
            set.add(conn.id);
            this.byUser.set(userId, set);
        }
        (ws as unknown as {__conn?: Conn}).__conn = conn;
        conn.alive = true;
        if (replayed) {
            // Hello first (not sequenced), then everything they missed.
            ws.send(JSON.stringify({event: 'hello', data: {connectionId: conn.id, serverTime: Date.now(), replayed: true}, seq: -1}));
            for (const e of conn.buffer.filter((x) => x.seq > (lastSeq as number))) {
                ws.send(JSON.stringify(e));
            }
        } else {
            this.send(conn, {event: 'hello', data: {connectionId: conn.id, serverTime: Date.now(), replayed: false}}, false);
        }
    }

    private canReplay(c: Conn, lastSeq: number): boolean {
        if (!c.disconnectedAt || Date.now() - c.disconnectedAt > REPLAY_WINDOW_MS) {
            return false;
        }
        if (lastSeq >= c.seq - 1) {
            return true; // nothing missed
        }
        return c.buffer.length > 0 && c.buffer[0].seq <= lastSeq + 1;
    }

    private send(c: Conn, event: ServerEvent, droppable: boolean): void {
        if (droppable && (!c.ws || c.ws.bufferedAmount > SLOW_CLIENT_BYTES)) {
            return; // never buffered either: replaying stale typing or partial text is pointless
        }
        const env = {...event, seq: c.seq++} as EventEnvelope;
        if (!droppable) {
            c.buffer.push(env);
            if (c.buffer.length > BUFFER) {
                c.buffer.shift();
            }
        }
        if (c.ws && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify(env));
        }
    }

    // Deliver to every connection of these users, on this node and others.
    publish(userIds: string[], event: ServerEvent, opts: PublishOptions = {}): void {
        this.deliver(userIds, event, opts);
        this.deps.forward?.(userIds, event, opts);
    }

    // Delivery from another node (no forwarding back).
    deliver(userIds: string[], event: ServerEvent, opts: PublishOptions = {}): void {
        for (const userId of new Set(userIds)) {
            for (const id of this.byUser.get(userId) ?? []) {
                const c = this.conns.get(id);
                if (c && id !== opts.exceptConnectionId) {
                    this.send(c, event, Boolean(opts.droppable));
                }
            }
        }
    }

    // Sign-outs: close the sockets of these sessions on this server, for good.
    closeSessions(sessionIds: string[]): void {
        const ids = new Set(sessionIds);
        for (const c of [...this.conns.values()]) {
            if (ids.has(c.sessionId)) {
                this.forget(c, 'signed out');
            }
        }
    }

    closeUserSessions(userId: string, exceptSessionId?: string): void {
        for (const id of [...(this.byUser.get(userId) ?? [])]) {
            const c = this.conns.get(id);
            if (c && c.sessionId !== exceptSessionId) {
                this.forget(c, 'signed out');
            }
        }
    }

    private forget(c: Conn, reason: string): void {
        c.ws?.close(4001, reason);
        c.ws = null;
        if (c.device) {
            c.device = null;
            void this.deps.onDeviceClosed?.(c.id).catch(() => undefined);
        }
        this.conns.delete(c.id);
        const set = this.byUser.get(c.userId);
        set?.delete(c.id);
        if (set && !set.size) {
            this.byUser.delete(c.userId);
        }
    }

    // Sessions ended on another server (or expired): close their sockets here too.
    private async revalidate(): Promise<void> {
        if (!this.deps.validSessions || !this.conns.size) {
            return;
        }
        const ids = [...new Set([...this.conns.values()].map((c) => c.sessionId))];
        const valid = await this.deps.validSessions(ids).catch(() => null);
        if (!valid) {
            return;
        }
        this.closeSessions(ids.filter((id) => !valid.has(id)));
    }

    // Ping live sockets; forget connections gone longer than the replay window.
    private sweep(): void {
        void this.revalidate();
        const t = Date.now();
        const devices = [...this.conns.values()].filter((c) => c.ws && c.device).map((c) => c.id);
        if (devices.length) {
            void this.deps.onDevicesAlive?.(devices).catch(() => undefined);
        }
        for (const c of this.conns.values()) {
            if (c.ws) {
                if (!c.alive) {
                    c.ws.terminate();
                    continue;
                }
                c.alive = false;
                c.ws.ping();
            } else if (c.disconnectedAt && t - c.disconnectedAt > REPLAY_WINDOW_MS) {
                this.conns.delete(c.id);
                const set = this.byUser.get(c.userId);
                set?.delete(c.id);
                if (set && !set.size) {
                    this.byUser.delete(c.userId);
                }
            }
        }
        log.debug({connections: this.connectionCount}, 'hub sweep');
    }
}
