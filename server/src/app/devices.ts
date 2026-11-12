// Devices: a person's Mac app or Chrome extension, registered over its
// socket. Agents send a device requests (take a screenshot, click here, open
// this page); the device answers over the same socket. Requests are rows in
// device_requests, so a device that reconnects can still answer, and the
// waiting tool hears the answer through NOTIFY from whichever server took it.

import type {Sql} from '../db/index.js';
import type {Device, DeviceRegistration, DeviceRequest, DeviceResult} from '../shared/types.js';
import {
    answerDeviceRequest, cleanupDeviceRequests, closeDeviceRequest, createDeviceRequest, deleteDevice, deviceOffline, type DeviceRow, devicesOfNodeOffline,
    getDevice, getDeviceRequest, grantedDevices, listDevices, onlineDevices, pendingDeviceRequests, registerDevice, touchDevices, updateDevice,
} from '../store/devices.js';
import type {UserRow} from '../store/users.js';
import {forbidden, notFound} from '../util/errors.js';
import {log} from '../util/log.js';

import type {Ctx} from './context.js';

const CHANNEL = 'captain_device';
const POLL_MS = 1500;

export function toDevice(d: DeviceRow): Device {
    return {id: d.id, kind: d.kind, name: d.name, capabilities: d.capabilities, online: d.online, autopilot: d.autopilot, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt};
}

// ------------------------------------------------------------ registry

export class Devices {
    private readonly sql: Sql;
    private readonly nodeId: string;
    private ctx: Ctx | null = null;
    private listener: {unlisten: () => Promise<void>} | null = null;
    private waiting = new Map<string, () => void>(); // request id → wake the tool waiting on it
    private queues = new Map<string, Promise<unknown>>(); // one request at a time per device
    private cleaner: NodeJS.Timeout | null = null;

    constructor(sql: Sql, nodeId: string) {
        this.sql = sql;
        this.nodeId = nodeId;
    }

    attach(ctx: Ctx): void {
        this.ctx = ctx;
    }

    async start(): Promise<void> {
        // Devices of an earlier run of this server are gone until they reconnect.
        await devicesOfNodeOffline(this.sql, this.nodeId).catch(() => undefined);
        this.listener = await this.sql.listen(CHANNEL, (id) => this.waiting.get(id)?.()).catch((err) => {
            log.warn({err: (err as Error).message}, 'device notifications unavailable; polling instead');
            return null;
        });
        this.cleaner = setInterval(() => void cleanupDeviceRequests(this.sql).catch(() => undefined), 3_600_000);
    }

    async stop(): Promise<void> {
        if (this.cleaner) {
            clearInterval(this.cleaner);
        }
        await this.listener?.unlisten().catch(() => undefined);
        await devicesOfNodeOffline(this.sql, this.nodeId).catch(() => undefined);
    }

    // ---- hub callbacks

    async register(userId: string, connectionId: string, reg: DeviceRegistration): Promise<{id: string}> {
        const row = await registerDevice(this.sql, {id: reg.id, userId, kind: reg.kind, name: reg.name, capabilities: reg.capabilities, connectionId, nodeId: this.nodeId});
        this.ctx?.hub.publish([userId], {event: 'device_updated', data: {device: toDevice(row)}});
        // Requests sent while it was away: send them again.
        for (const r of await pendingDeviceRequests(this.sql, row.id)) {
            this.ctx?.hub.publish([userId], {event: 'device_request', data: {id: r.id, deviceId: r.deviceId, runId: r.runId, stepId: r.stepId, tool: r.tool, args: r.args, deadline: r.createdAt + 60_000}});
        }
        return {id: row.id};
    }

    async closed(connectionId: string): Promise<void> {
        const row = await deviceOffline(this.sql, connectionId);
        if (row) {
            this.ctx?.hub.publish([row.userId], {event: 'device_updated', data: {device: toDevice(row)}});
        }
    }

    async alive(connectionIds: string[]): Promise<void> {
        await touchDevices(this.sql, connectionIds);
    }

    async answered(userId: string, connectionId: string, requestId: string, ok: boolean, result: unknown, error: string | undefined): Promise<void> {
        const req = await getDeviceRequest(this.sql, requestId);
        if (!req || req.userId !== userId) {
            return;
        }
        const device = await getDevice(this.sql, req.deviceId);
        if (!device || device.connectionId !== connectionId) {
            return; // not the device this was sent to
        }
        const value: DeviceResult & {error?: string} = ok ? normalizeResult(result) : {error: (error || 'The device couldn\'t do that.').slice(0, 2000)};
        const row = await answerDeviceRequest(this.sql, requestId, device.id, ok ? 'done' : 'failed', value);
        if (row) {
            await this.sql`select pg_notify(${CHANNEL}, ${requestId})`.catch(() => undefined);
            this.waiting.get(requestId)?.();
        }
    }

    // ---- for tools

    async online(user: UserRow): Promise<DeviceRow[]> {
        return onlineDevices(this.sql, user.id);
    }

    // Send a request and wait for the device's answer. Requests to one device
    // go one at a time, in order, so two steps can't fight over the mouse.
    async request(input: {device: DeviceRow; requester: UserRow; runId: string | null; stepId: string | null; tool: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs: number}): Promise<DeviceResult> {
        const previous = this.queues.get(input.device.id) ?? Promise.resolve();
        const mine = previous.catch(() => undefined).then(() => this.send(input));
        this.queues.set(input.device.id, mine);
        try {
            return await mine;
        } finally {
            if (this.queues.get(input.device.id) === mine) {
                this.queues.delete(input.device.id);
            }
        }
    }

    private async send(input: {device: DeviceRow; requester: UserRow; runId: string | null; stepId: string | null; tool: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs: number}): Promise<DeviceResult> {
        if (input.signal?.aborted) {
            throw new Error('stopped');
        }
        const device = await getDevice(this.sql, input.device.id);
        if (!device?.online) {
            throw new Error(`${input.device.name} is offline. Ask the person to open Captain there.`);
        }
        const req = await createDeviceRequest(this.sql, {deviceId: device.id, userId: input.requester.id, runId: input.runId, stepId: input.stepId, tool: input.tool, args: input.args});
        const deadline = Date.now() + input.timeoutMs;
        const event: DeviceRequest = {id: req.id, deviceId: device.id, runId: req.runId, stepId: req.stepId, tool: req.tool, args: req.args, deadline};
        this.ctx?.hub.publish([input.requester.id], {event: 'device_request', data: event});

        return new Promise<DeviceResult>((resolve, reject) => {
            let done = false;
            const finish = async () => {
                const row = await getDeviceRequest(this.sql, req.id).catch(() => null);
                if (!row || row.status === 'pending' || done) {
                    return false;
                }
                done = true;
                cleanup();
                const value = (row.result ?? {}) as DeviceResult & {error?: string};
                if (row.status === 'done') {
                    resolve({text: value.text, images: value.images});
                } else {
                    reject(new Error(value.error || 'The device couldn\'t do that.'));
                }
                return true;
            };
            const onAbort = () => {
                if (done) {
                    return;
                }
                done = true;
                cleanup();
                void closeDeviceRequest(this.sql, req.id, 'cancelled').catch(() => undefined);
                reject(new Error('stopped'));
            };
            const timer = setTimeout(() => {
                void finish().then((ok) => {
                    if (!ok && !done) {
                        done = true;
                        cleanup();
                        void closeDeviceRequest(this.sql, req.id, 'expired').catch(() => undefined);
                        reject(new Error(`${device.name} didn't answer in time (${Math.round(input.timeoutMs / 1000)}s). It may be busy, asleep or missing a permission.`));
                    }
                });
            }, input.timeoutMs);
            const poll = setInterval(() => void finish(), POLL_MS);
            const cleanup = () => {
                clearTimeout(timer);
                clearInterval(poll);
                this.waiting.delete(req.id);
                input.signal?.removeEventListener('abort', onAbort);
            };
            this.waiting.set(req.id, () => void finish());
            input.signal?.addEventListener('abort', onAbort);
        });
    }
}

// Only what a device may send back: a bounded text and a few PNG/JPEG data URLs.
function normalizeResult(raw: unknown): DeviceResult {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.slice(0, 60_000) : undefined;
    const images = Array.isArray(r.images) ? r.images.filter((i): i is string => typeof i === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(i) && i.length < 6_000_000).slice(0, 2) : undefined;
    return {text, images: images?.length ? images : undefined};
}

// ------------------------------------------------------------ for the API and tools

export async function myDevices(ctx: Ctx, user: UserRow): Promise<Device[]> {
    return (await listDevices(ctx.sql, user.id)).map(toDevice);
}

export async function usableDevices(ctx: Ctx, user: UserRow): Promise<DeviceRow[]> {
    return onlineDevices(ctx.sql, user.id);
}

export async function changeDevice(ctx: Ctx, user: UserRow, id: string, patch: {name?: string; autopilot?: boolean}): Promise<Device> {
    const d = await getDevice(ctx.sql, id);
    if (!d) {
        throw notFound('Device');
    }
    if (d.userId !== user.id) {
        throw forbidden('That device is not yours.');
    }
    const row = await updateDevice(ctx.sql, id, patch);
    ctx.hub.publish([user.id], {event: 'device_updated', data: {device: toDevice(row)}});
    return toDevice(row);
}

export async function removeDevice(ctx: Ctx, user: UserRow, id: string): Promise<void> {
    const d = await getDevice(ctx.sql, id);
    if (!d) {
        return;
    }
    if (d.userId !== user.id) {
        throw forbidden('That device is not yours.');
    }
    await deleteDevice(ctx.sql, id);
}

// A run ended: tell the devices it was using, so they stop showing "working".
export async function releaseDevices(ctx: Ctx, run: {id: string; requestedBy: string}): Promise<void> {
    const ids = await grantedDevices(ctx.sql, run.id).catch(() => new Set<string>());
    for (const deviceId of ids) {
        ctx.hub.publish([run.requestedBy], {event: 'device_released', data: {deviceId, runId: run.id}});
    }
}
