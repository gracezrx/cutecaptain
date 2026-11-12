// The real-time connection. Authenticates with the first message, keeps the
// connection id and last sequence number, and on reconnect asks the server to
// replay what it missed. If the server can't (too long offline), onResync
// tells the app to reload its state instead.

import {getToken, sessionEnded, websocketUrl} from './api';
import type {EventEnvelope, ServerEvent} from './types';

type Handlers = {
    onEvent: (e: ServerEvent) => void;
    onState: (s: 'connecting' | 'online' | 'offline') => void;
    onResync: () => void;
    // The server's answer to something we sent (status OK/FAIL, seqReply, data).
    onReply?: (r: {status: string; seqReply?: number; data?: Record<string, unknown>; error?: string}) => void;
};

export class Socket {
    private ws: WebSocket | null = null;
    private connectionId: string | null = null;
    private lastSeq = -1;
    private attempt = 0;
    private timer: number | null = null;
    private closed = false;
    private everConnected = false;
    private seq = 1;
    private readonly h: Handlers;

    constructor(h: Handlers) {
        this.h = h;
    }

    open(): void {
        this.closed = false;
        this.connect();
        window.addEventListener('online', this.retryNow);
    }

    close(): void {
        this.closed = true;
        window.removeEventListener('online', this.retryNow);
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.ws?.close();
        this.ws = null;
    }

    send(msg: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({...msg, seq: this.seq++}));
        }
    }

    typing(channelId: string, rootId: string | null): void {
        this.send({action: 'typing', channelId, rootId});
    }

    get online(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    // Drop the connection and make a new one (a device registration is per connection).
    reconnect(): void {
        if (this.closed) {
            return;
        }
        this.ws?.close();
    }

    private retryNow = () => {
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.connect();
        }
    };

    private connect(): void {
        if (this.closed) {
            return;
        }
        this.h.onState('connecting');
        const ws = new WebSocket(websocketUrl());
        this.ws = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({
                action: 'auth', seq: this.seq++, token: getToken(),
                ...(this.connectionId ? {connectionId: this.connectionId, lastSeq: this.lastSeq} : {}),
            }));
        };
        ws.onmessage = (m) => {
            let msg: EventEnvelope | {status: string};
            try {
                msg = JSON.parse(m.data as string);
            } catch {
                return;
            }
            if (!('event' in msg)) {
                this.h.onReply?.(msg as {status: string});
                return;
            }
            if (msg.seq >= 0) {
                this.lastSeq = msg.seq;
            }
            if (msg.event === 'hello') {
                const {connectionId, replayed} = msg.data;
                const resync = this.everConnected && !replayed;
                this.connectionId = connectionId;
                if (!replayed) {
                    this.lastSeq = msg.seq;
                }
                this.attempt = 0;
                this.everConnected = true;
                this.h.onState('online');
                if (resync) {
                    this.h.onResync();
                }
                return;
            }
            this.h.onEvent(msg);
        };
        ws.onclose = (e) => {
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            if (this.closed) {
                return;
            }
            this.h.onState('offline');
            if (e.code === 4001) {
                // The session is no longer valid: sign out instead of retrying.
                sessionEnded();
                return;
            }
            const delay = Math.min(30_000, 500 * 2 ** this.attempt++) + Math.random() * 500;
            this.timer = window.setTimeout(() => this.connect(), delay);
        };
    }
}
