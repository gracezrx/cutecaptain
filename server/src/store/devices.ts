// Devices (a person's Mac app or Chrome extension), the requests agents send
// them, and the grants that let a run use one.

import type {Db} from '../db/index.js';
import type {DeviceKind} from '../shared/types.js';
import {newId, now} from '../util/ids.js';

export type DeviceRow = {
    id: string;
    userId: string;
    kind: DeviceKind;
    name: string;
    capabilities: string[];
    online: boolean;
    connectionId: string | null;
    nodeId: string | null;
    autopilot: boolean;
    lastSeenAt: number;
    createdAt: number;
    updatedAt: number;
};

export type DeviceRequestStatus = 'pending' | 'done' | 'failed' | 'expired' | 'cancelled';

export type DeviceRequestRow = {
    id: string;
    deviceId: string;
    userId: string;
    runId: string | null;
    stepId: string | null;
    tool: string;
    args: Record<string, unknown>;
    status: DeviceRequestStatus;
    result: unknown;
    createdAt: number;
    answeredAt: number | null;
};

// A device coming online. Its id is kept by the device, so the same Mac keeps
// its settings (autopilot) across sign-ins; an unknown id gets a new row.
export async function registerDevice(db: Db, r: {id: string | null; userId: string; kind: DeviceKind; name: string; capabilities: string[]; connectionId: string; nodeId: string}): Promise<DeviceRow> {
    const t = now();
    if (r.id) {
        const [existing] = await db`
            update devices set
                kind = ${r.kind}, name = ${r.name}, capabilities = ${db.json(r.capabilities as never)}, online = true,
                connection_id = ${r.connectionId}, node_id = ${r.nodeId}, last_seen_at = ${t}, updated_at = ${t}
            where id = ${r.id} and user_id = ${r.userId}
            returning *`;
        if (existing) {
            return existing as unknown as DeviceRow;
        }
    }
    const [row] = await db`
        insert into devices (id, user_id, kind, name, capabilities, online, connection_id, node_id, autopilot, last_seen_at, created_at, updated_at)
        values (${newId()}, ${r.userId}, ${r.kind}, ${r.name}, ${db.json(r.capabilities as never)}, true, ${r.connectionId}, ${r.nodeId}, false, ${t}, ${t}, ${t})
        returning *`;
    return row as unknown as DeviceRow;
}

export async function touchDevices(db: Db, connectionIds: string[]): Promise<void> {
    if (connectionIds.length) {
        await db`update devices set last_seen_at = ${now()} where connection_id = any(${connectionIds}) and online`;
    }
}

export async function deviceOffline(db: Db, connectionId: string): Promise<DeviceRow | null> {
    const [row] = await db`update devices set online = false, connection_id = null, updated_at = ${now()} where connection_id = ${connectionId} returning *`;
    return (row as unknown as DeviceRow) ?? null;
}

// Devices of a server that stopped: a restart marks them offline until they reconnect.
export async function devicesOfNodeOffline(db: Db, nodeId: string): Promise<void> {
    await db`update devices set online = false, connection_id = null, updated_at = ${now()} where node_id = ${nodeId} and online`;
}

export async function getDevice(db: Db, id: string): Promise<DeviceRow | null> {
    const [row] = await db`select * from devices where id = ${id}`;
    return (row as unknown as DeviceRow) ?? null;
}

export async function listDevices(db: Db, userId: string): Promise<DeviceRow[]> {
    return (await db`select * from devices where user_id = ${userId} order by created_at`) as unknown as DeviceRow[];
}

// A device counts as online while its socket is up and it was seen lately
// (a server that died without saying so stops counting after the grace period).
export const ONLINE_GRACE_MS = 120_000;

export async function onlineDevices(db: Db, userId: string): Promise<DeviceRow[]> {
    return (await db`select * from devices where user_id = ${userId} and online and last_seen_at > ${now() - ONLINE_GRACE_MS} order by last_seen_at desc, created_at desc`) as unknown as DeviceRow[];
}

export async function updateDevice(db: Db, id: string, patch: Partial<Pick<DeviceRow, 'name' | 'autopilot'>>): Promise<DeviceRow> {
    const [row] = await db`
        update devices set
            name = coalesce(${patch.name ?? null}, name),
            autopilot = coalesce(${patch.autopilot ?? null}, autopilot),
            updated_at = ${now()}
        where id = ${id}
        returning *`;
    return row as unknown as DeviceRow;
}

export async function deleteDevice(db: Db, id: string): Promise<void> {
    await db`delete from devices where id = ${id}`;
}

// ------------------------------------------------------------ requests

export async function createDeviceRequest(db: Db, r: Pick<DeviceRequestRow, 'deviceId' | 'userId' | 'runId' | 'stepId' | 'tool' | 'args'>): Promise<DeviceRequestRow> {
    const [row] = await db`
        insert into device_requests (id, device_id, user_id, run_id, step_id, tool, args, status, created_at)
        values (${newId()}, ${r.deviceId}, ${r.userId}, ${r.runId}, ${r.stepId}, ${r.tool}, ${db.json(r.args as never)}, 'pending', ${now()})
        returning *`;
    return row as unknown as DeviceRequestRow;
}

export async function getDeviceRequest(db: Db, id: string): Promise<DeviceRequestRow | null> {
    const [row] = await db`select * from device_requests where id = ${id}`;
    return (row as unknown as DeviceRequestRow) ?? null;
}

// Record the device's answer. Only the first answer counts.
export async function answerDeviceRequest(db: Db, id: string, deviceId: string, status: 'done' | 'failed', result: unknown): Promise<DeviceRequestRow | null> {
    const [row] = await db`
        update device_requests set status = ${status}, result = ${db.json(result as never)}, answered_at = ${now()}
        where id = ${id} and device_id = ${deviceId} and status = 'pending'
        returning *`;
    return (row as unknown as DeviceRequestRow) ?? null;
}

export async function closeDeviceRequest(db: Db, id: string, status: 'expired' | 'cancelled'): Promise<void> {
    await db`update device_requests set status = ${status}, answered_at = ${now()} where id = ${id} and status = 'pending'`;
}

// Requests a device hasn't answered (for a device that reconnects, or polls).
export async function pendingDeviceRequests(db: Db, deviceId: string): Promise<DeviceRequestRow[]> {
    return (await db`select * from device_requests where device_id = ${deviceId} and status = 'pending' order by created_at`) as unknown as DeviceRequestRow[];
}

export async function cleanupDeviceRequests(db: Db): Promise<void> {
    await db`delete from device_requests where created_at < ${now() - 7 * 86_400_000}`;
}

// ------------------------------------------------------------ grants

export async function grantDevice(db: Db, runId: string, deviceId: string, userId: string): Promise<void> {
    await db`insert into device_grants (run_id, device_id, granted_by, granted_at) values (${runId}, ${deviceId}, ${userId}, ${now()}) on conflict do nothing`;
}

export async function grantedDevices(db: Db, runId: string): Promise<Set<string>> {
    const rows = await db`select device_id from device_grants where run_id = ${runId}`;
    return new Set(rows.map((r) => r.deviceId as string));
}
