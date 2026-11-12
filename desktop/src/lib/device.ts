// This Mac as a device agents can use. The dashboard window (which owns the
// socket) registers it when the connection comes up, carries out each
// device_request with the captain-desk helper (computer.ts), answers over
// the socket, and shows the little Captain what's happening. Esc, in any
// app, stops the run (lib.rs registers it while an agent is at work).
//
// Settings: "Let agents use this Mac" (kept on this Mac; off means it never
// registers) and hands-free (kept on the server, per device).

import {emitTo, listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';

import {api} from './api';
import {COMPUTER_CAPABILITIES, runComputer} from './computer';
import {isTauri, secretGet, secretSet} from './native';
import type {Device, DeviceRequest, ServerEvent} from './types';

const KEY_ID = 'device.id';
const KEY_ENABLED = 'device.enabled';

// What the orb shows while an agent works on this Mac.
export type DriveActivity = {runId: string | null; text: string; phase: 'working' | 'done' | 'stopped' | 'error'};

type Send = (msg: Record<string, unknown>) => void;

let send: Send | null = null;
let deviceId: string | null = null;
let registered = false;
let enabled = true;
let name = 'This Mac';
let queue: Promise<unknown> = Promise.resolve();
let current: {request: DeviceRequest; cancel: () => void} | null = null;
let driving: string | null = null; // the run at work on this Mac
let idleTimer: number | undefined;
const listeners = new Set<(d: Device[]) => void>();
let devices: Device[] = [];

export async function deviceEnabled(): Promise<boolean> {
    return (await secretGet(KEY_ENABLED)) !== '0';
}

export async function setDeviceEnabled(on: boolean): Promise<void> {
    enabled = on;
    await secretSet(KEY_ENABLED, on ? '1' : '0');
    // Registration is per connection: a fresh one picks the new setting up.
    reconnectRequested?.();
}

let reconnectRequested: (() => void) | null = null;

export function thisDeviceId(): string | null {
    return deviceId;
}

export function onDevices(fn: (d: Device[]) => void): () => void {
    listeners.add(fn);
    fn(devices);
    return () => listeners.delete(fn);
}

export async function refreshDevices(): Promise<Device[]> {
    devices = await api.devices().catch(() => devices);
    listeners.forEach((fn) => fn(devices));
    return devices;
}

async function computerName(): Promise<string> {
    try {
        const s = await invoke<{computer?: string}>('desk_run', {args: ['screen'], stdin: null, timeoutMs: 5000});
        return s.computer?.trim() || 'This Mac';
    } catch {
        return 'This Mac';
    }
}

// Called by realtime.ts when the socket is up (again).
export async function deviceOnline(): Promise<void> {
    if (!isTauri || !send) {
        return;
    }
    registered = false;
    enabled = await deviceEnabled();
    if (!enabled) {
        return;
    }
    deviceId = deviceId ?? (await secretGet(KEY_ID));
    name = await computerName();
    send({action: 'device_register', device: {id: deviceId, kind: 'mac', name, capabilities: COMPUTER_CAPABILITIES}});
    registered = true;
}

export function deviceOffline(): void {
    registered = false;
}

// The server's reply to device_register.
export async function deviceRegistered(id: string): Promise<void> {
    if (id !== deviceId) {
        deviceId = id;
        await secretSet(KEY_ID, id);
    }
    void refreshDevices();
}

function tell(activity: DriveActivity): void {
    void emitTo('orb', 'device-activity', activity).catch(() => undefined);
}

function startDriving(runId: string | null): void {
    window.clearTimeout(idleTimer);
    if (driving !== runId) {
        driving = runId;
        void invoke('drive_escape', {active: true}).catch(() => undefined);
    }
}

function stopDriving(phase: DriveActivity['phase'], text: string): void {
    const runId = driving;
    driving = null;
    void invoke('drive_escape', {active: false}).catch(() => undefined);
    tell({runId, text, phase});
}

// A request for this device: do it (one at a time), answer, show the orb.
function handleRequest(req: DeviceRequest): void {
    if (!send || req.deviceId !== deviceId) {
        return;
    }
    queue = queue.catch(() => undefined).then(async () => {
        if (!enabled) {
            send!({action: 'device_result', requestId: req.id, ok: false, error: 'Agents are turned off on this Mac (Settings → This Mac).'});
            return;
        }
        startDriving(req.runId);
        tell({runId: req.runId, text: describe(req), phase: 'working'});
        let cancelled = false;
        current = {request: req, cancel: () => (cancelled = true)};
        try {
            const result = await runComputer(req.tool, req.args);
            if (cancelled) {
                return;
            }
            answer(req, {ok: true, result});
        } catch (e) {
            if (!cancelled) {
                answer(req, {ok: false, error: (e as Error)?.message || 'That didn\'t work on this Mac.'});
            }
        } finally {
            current = null;
            // Quiet for a while: the run must be thinking or done; the orb relaxes.
            window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(() => {
                if (driving && !current) {
                    tell({runId: driving, text: 'Thinking…', phase: 'working'});
                }
            }, 8000);
        }
    });
}

function answer(req: DeviceRequest, body: {ok: boolean; result?: unknown; error?: string}): void {
    if (send && registered) {
        send({action: 'device_result', requestId: req.id, ...body});
    } else if (deviceId) {
        // Between reconnects: the HTTP way.
        void api.answerDevice(deviceId, req.id, body).catch(() => undefined);
    }
}

function describe(req: DeviceRequest): string {
    const a = req.args;
    const s = (v: unknown, n = 40) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
    switch (req.tool) {
    case 'computer_screenshot': return 'Looking at the screen';
    case 'computer_zoom': return 'Looking closer';
    case 'computer_read_screen': return a.app ? `Reading ${s(a.app)}` : 'Reading the screen';
    case 'computer_click': return a.count === 2 ? 'Double-clicking' : a.button === 'right' ? 'Right-clicking' : 'Clicking';
    case 'computer_move': return 'Hovering';
    case 'computer_drag': return 'Dragging';
    case 'computer_scroll': return `Scrolling ${s(a.direction)}`;
    case 'computer_type': return `Typing "${s(a.text, 30)}${String(a.text ?? '').length > 30 ? '…' : ''}"`;
    case 'computer_key': return `Pressing ${s(a.keys)}`;
    case 'computer_open': return `Opening ${s(a.app ?? a.url ?? a.path)}`;
    case 'computer_focus': return `Switching to ${s(a.app)}`;
    case 'computer_apps': return 'Checking what\'s open';
    case 'computer_clipboard': return a.action === 'write' ? 'Copying text' : 'Reading the clipboard';
    case 'computer_wait': return 'Waiting a moment';
    default: return 'Working';
    }
}

// Esc in any app, or Stop on the orb: end the run and refuse what's pending.
export async function stopDrive(reason = 'Stopped by you'): Promise<void> {
    const runId = driving;
    if (current) {
        current.cancel();
        answer(current.request, {ok: false, error: 'The person pressed Esc and stopped this. Don\'t go on.'});
        current = null;
    }
    stopDriving('stopped', reason);
    if (runId) {
        await api.cancelRun(runId).catch(() => undefined);
    }
}

// Events from the socket that concern devices. Returns true when handled.
export function handleDeviceEvent(e: ServerEvent): boolean {
    switch (e.event) {
    case 'device_request':
        handleRequest(e.data);
        return true;
    case 'device_updated': {
        const d = e.data.device;
        devices = devices.some((x) => x.id === d.id) ? devices.map((x) => (x.id === d.id ? d : x)) : [...devices, d];
        listeners.forEach((fn) => fn(devices));
        return true;
    }
    case 'device_released':
        if (e.data.deviceId === deviceId && driving === e.data.runId) {
            stopDriving('done', 'Done');
        }
        return true;
    default:
        return false;
    }
}

// Started once by the dashboard window, with a way to send on the socket.
export function startDeviceLink(sender: Send, reconnect: () => void): () => void {
    if (!isTauri) {
        return () => undefined;
    }
    send = sender;
    reconnectRequested = reconnect;
    let un: (() => void) | undefined;
    let un2: (() => void) | undefined;
    let gone = false;
    void listen('device-stop', () => void stopDrive()).then((u) => (gone ? u() : (un = u)));
    void listen('orb-stop-drive', () => void stopDrive()).then((u) => (gone ? u() : (un2 = u)));
    return () => {
        gone = true;
        un?.();
        un2?.();
        send = null;
        reconnectRequested = null;
        if (driving) {
            stopDriving('stopped', 'Signed out');
        }
    };
}
