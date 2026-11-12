// An agent's computer_* request, done on this Mac through the captain-desk
// helper (src-tauri/desk/main.swift). The agent sees the screen as an image
// at most MAX_WIDTH pixels wide and gives every coordinate in that image's
// pixels; this file converts to and from screen points, so the helper and
// macOS only ever see points.

import {invoke} from '@tauri-apps/api/core';

import {cardDetails, displayLabel, ENTER_SENDS_APPS, isOutbound, isSecretField, isSendKey, SECRET_REFUSAL, targetOf} from './gate';
import type {DeviceResult} from './types';

export const MAX_WIDTH = 1440;

type Screen = {width: number; height: number; scale: number; front: string};
type Shot = {png: string; width: number; height: number; screenWidth: number; screenHeight: number; front?: string; regionX?: number; regionY?: number; regionWidth?: number; regionHeight?: number};
type AxNode = {role: string; title?: string; value?: string; desc?: string; x: number; y: number; w: number; h: number; enabled?: boolean; focused?: boolean; selected?: boolean; depth: number};
type Ax = {app: string; pid: number; nodes: AxNode[]; total: number; truncated: boolean; windows: Win[]};
type Win = {app: string; pid: number; title: string; x: number; y: number; w: number; h: number};
type Apps = {apps: {name: string; bundle: string; pid: number; front: boolean; hidden: boolean}[]; windows: Win[]};

// The last screen size seen, for converting before the first screenshot.
let screen: Screen | null = null;

async function desk<T = Record<string, unknown>>(args: string[], opts: {stdin?: string; timeoutMs?: number} = {}): Promise<T> {
    return invoke<T>('desk_run', {args, stdin: opts.stdin ?? null, timeoutMs: opts.timeoutMs ?? null});
}

async function screenSize(): Promise<Screen> {
    screen = await desk<Screen>(['screen']);
    return screen;
}

// Image pixels per screen point: the whole screen fits in MAX_WIDTH.
function factor(s: {width: number}): number {
    return Math.min(1, MAX_WIDTH / Math.max(1, s.width));
}

async function toPoints(x: unknown, y: unknown): Promise<{x: number; y: number}> {
    const s = screen ?? await screenSize();
    const k = factor(s);
    return {x: Math.round(Number(x) / k), y: Math.round(Number(y) / k)};
}

const n = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.parseFloat(String(v ?? '')) || fallback);
const px = (v: number) => Math.round(v);

function image(shot: Shot): string {
    return `data:image/png;base64,${shot.png}`;
}

// What the screen looks like, as text: the app in front and the image's size.
function describeShot(shot: Shot): string {
    return `Screenshot ${shot.width}×${shot.height}${shot.front ? `. App in front: ${shot.front}` : ''}. Give coordinates as pixels in this image.`;
}

function nodeLine(nd: AxNode, k: number): string {
    const role = nd.role.replace(/^AX/, '');
    const bits = [
        nd.title ? `"${nd.title}"` : '',
        nd.value ? `value: ${JSON.stringify(nd.value)}` : '',
        nd.desc && nd.desc !== nd.title ? `(${nd.desc})` : '',
        nd.enabled === false ? 'disabled' : '',
        nd.focused ? 'focused' : '',
        nd.selected ? 'selected' : '',
    ].filter(Boolean).join(' ');
    const cx = px((nd.x + nd.w / 2) * k);
    const cy = px((nd.y + nd.h / 2) * k);
    return `${'  '.repeat(Math.min(nd.depth, 8))}${role} ${bits} @(${cx},${cy}) ${px(nd.w * k)}×${px(nd.h * k)}`;
}

export type ComputerArgs = Record<string, unknown>;

// ---- the gate (lib/gate.ts): stop before sending, paying, posting, deleting

type Hit = {role: string; subrole?: string; title?: string; desc?: string; help?: string; app?: string};

const PRESSABLE = ['AXButton', 'AXMenuItem', 'AXLink', 'AXMenuButton', 'AXPopUpButton', 'AXCheckBox', 'AXRadioButton', 'AXCell'];
const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];

// The fields in the window in front (To, Subject, the body…), for the card.
async function frontFields(): Promise<{label: string; value: string}[]> {
    const ax = await desk<Ax>(['ax', 'front', '', '250'], {timeoutMs: 8000}).catch(() => null);
    if (!ax) {
        return [];
    }
    return ax.nodes.filter((nd) => TEXT_ROLES.includes(nd.role) && nd.value).map((nd) => ({label: (nd.title || nd.desc || (nd.role === 'AXTextArea' ? 'Message' : 'Field')).replace(/:$/, ''), value: nd.value ?? ''}));
}

async function gate(action: string, label: string, app: string, confirm: unknown): Promise<DeviceResult | null> {
    const details = cardDetails(await frontFields());
    const target = targetOf(app, label, details);
    if (confirm === target) {
        return null;
    }
    return {needsConfirm: {action, target, site: app, details: confirm ? [{label: 'Note', value: 'This changed after you approved it, so here it is again.'}, ...details].slice(0, 8) : details}};
}

async function clickGate(p: {x: number; y: number}, confirm: unknown): Promise<DeviceResult | null> {
    const hit = await desk<Hit>(['hit', String(p.x), String(p.y)]).catch(() => null);
    const label = hit && PRESSABLE.includes(hit.role) ? (hit.title || hit.desc || hit.help || '') : '';
    return label && isOutbound(label, hit?.app ?? '') ? gate(`Click "${displayLabel(label)}"`, label, hit?.app || 'the app in front', confirm) : null;
}

async function focusedField(): Promise<Hit & {placeholder?: string} | null> {
    return desk<Hit & {placeholder?: string}>(['focused']).catch(() => null);
}

async function secretField(): Promise<boolean> {
    const f = await focusedField();
    return Boolean(f && isSecretField({subrole: f.subrole, label: `${f.title ?? ''} ${f.desc ?? ''} ${f.placeholder ?? ''}`}));
}

// Keys that send: cmd+enter and friends anywhere text is being written, and
// plain Enter in a chat app's message box.
async function keyGate(combo: string, confirm: unknown): Promise<DeviceResult | null> {
    const f = await focusedField();
    const app = f?.app ?? '';
    const inText = Boolean(f && TEXT_ROLES.includes(f.role));
    const c = combo.toLowerCase();
    const sends = isSendKey(c) ? inText || app === 'Mail' : (c === 'enter' || c === 'return') && inText && ENTER_SENDS_APPS.includes(app);
    return sends ? gate(`Press ${combo} (Send)`, 'Send', app || 'the app in front', confirm) : null;
}

export async function runComputer(tool: string, a: ComputerArgs): Promise<DeviceResult> {
    switch (tool) {
    case 'computer_screenshot': {
        const shot = await desk<Shot>(['screenshot', String(MAX_WIDTH)], {timeoutMs: 30_000});
        screen = {width: shot.screenWidth, height: shot.screenHeight, scale: 2, front: shot.front ?? ''};
        return {text: describeShot(shot), images: [image(shot)]};
    }
    case 'computer_zoom': {
        const s = screen ?? await screenSize();
        const k = factor(s);
        const x = n(a.x) / k;
        const y = n(a.y) / k;
        const w = Math.max(16, n(a.width, 200) / k);
        const h = Math.max(16, n(a.height, 200) / k);
        const shot = await desk<Shot>(['zoom', String(px(x)), String(px(y)), String(px(w)), String(px(h)), '1400'], {timeoutMs: 30_000});
        const rx = px((shot.regionX ?? x) * k);
        const ry = px((shot.regionY ?? y) * k);
        const rw = px((shot.regionWidth ?? w) * k);
        const rh = px((shot.regionHeight ?? h) * k);
        return {text: `Close-up of the region at (${rx},${ry}) ${rw}×${rh} of the full screenshot, shown ${shot.width}×${shot.height}. Coordinates for other tools are still in full-screenshot pixels: a point at (u,v) in this close-up is at (${rx} + u×${(rw / shot.width).toFixed(3)}, ${ry} + v×${(rh / shot.height).toFixed(3)}).`, images: [image(shot)]};
    }
    case 'computer_read_screen': {
        const s = screen ?? await screenSize();
        const k = factor(s);
        const max = Math.max(20, Math.min(1500, n(a.max, 400)));
        const ax = await desk<Ax>(['ax', String(a.app ?? 'front'), String(a.query ?? ''), String(max)], {timeoutMs: 20_000});
        if (!ax.nodes.length) {
            return {text: `${ax.app} shows nothing readable through Accessibility${a.query ? ` matching "${a.query}"` : ''}. Try computer_screenshot (and computer_zoom for small text), or click into the app first.`};
        }
        const windows = ax.windows.map((w) => `Window "${w.title || '(untitled)'}" at (${px(w.x * k)},${px(w.y * k)}) ${px(w.w * k)}×${px(w.h * k)}`);
        const lines = ax.nodes.map((nd) => nodeLine(nd, k));
        const head = `${ax.app}: ${ax.nodes.length}${ax.truncated ? ` of ${ax.total}` : ''} elements${a.query ? ` matching "${a.query}"` : ''}. Positions @(x,y) are centers in screenshot pixels; click them with computer_click.${ax.truncated ? ' More were left out: pass a query to narrow down, or a bigger max.' : ''}`;
        return {text: [head, ...windows, ...lines].join('\n')};
    }
    case 'computer_click': {
        const p = await toPoints(a.x, a.y);
        const stop = await clickGate(p, a.confirm);
        if (stop) {
            return stop;
        }
        const button = a.button === 'right' ? 'right' : a.button === 'middle' ? 'middle' : 'left';
        const count = Math.max(1, Math.min(3, n(a.count, 1)));
        const mods = Array.isArray(a.modifiers) ? a.modifiers.map(String).join(',') : '';
        await desk(['click', String(p.x), String(p.y), button, String(count), ...(mods ? [mods] : [])]);
        return {text: `Clicked at (${px(n(a.x))},${px(n(a.y))})${count > 1 ? ` ×${count}` : ''}. Look again to check the result.`};
    }
    case 'computer_move': {
        const p = await toPoints(a.x, a.y);
        await desk(['move', String(p.x), String(p.y)]);
        return {text: 'Moved the mouse there.'};
    }
    case 'computer_drag': {
        const from = await toPoints(a.fromX, a.fromY);
        const to = await toPoints(a.toX, a.toY);
        await desk(['drag', String(from.x), String(from.y), String(to.x), String(to.y)], {timeoutMs: 20_000});
        return {text: 'Dragged. Look again to check the result.'};
    }
    case 'computer_scroll': {
        const p = await toPoints(a.x, a.y);
        const dir = ['up', 'down', 'left', 'right'].includes(String(a.direction)) ? String(a.direction) : 'down';
        await desk(['scroll', String(p.x), String(p.y), dir, String(Math.max(1, Math.min(40, n(a.amount, 5))))]);
        return {text: `Scrolled ${dir}.`};
    }
    case 'computer_type': {
        const text = String(a.text ?? '');
        if (!text) {
            return {text: 'Nothing to type.'};
        }
        if (await secretField()) {
            return {needsPerson: SECRET_REFUSAL};
        }
        if (a.submit) {
            const stop = await keyGate('enter', a.confirm);
            if (stop) {
                return stop;
            }
        }
        await desk(['type', ...(a.submit ? ['--submit'] : [])], {stdin: text, timeoutMs: Math.min(120_000, 10_000 + text.length * 40)});
        return {text: `Typed ${text.length} characters${a.submit ? ' and pressed Enter' : ''}.`};
    }
    case 'computer_key': {
        const combos = String(a.keys ?? '').split(/\s+/).filter(Boolean);
        if (!combos.length) {
            return {text: 'Say which keys to press.'};
        }
        if (combos.some((k) => /^(cmd|command|ctrl|control)\+v$/i.test(k)) && await secretField()) {
            return {needsPerson: SECRET_REFUSAL};
        }
        for (const k of combos) {
            const stop = await keyGate(k, a.confirm);
            if (stop) {
                return stop;
            }
        }
        await desk(['key', ...combos]);
        return {text: `Pressed ${combos.join(', ')}.`};
    }
    case 'computer_open': {
        const target = String(a.app ?? a.url ?? a.path ?? '').trim();
        if (!target) {
            return {text: 'Say what to open: an app name, a web address or a file path.'};
        }
        const r = await desk<{front?: string; app?: string; alreadyRunning?: boolean}>(['open', target], {timeoutMs: 30_000});
        return {text: `Opened ${target}.${r.alreadyRunning ? ' It was already running and is now in front.' : r.front ? ` In front now: ${r.front}.` : ''} Take a screenshot or read the screen to go on.`};
    }
    case 'computer_focus': {
        const r = await desk<{app: string; note?: string}>(['focus', String(a.app ?? ''), ...(a.window ? [String(a.window)] : [])]);
        return {text: `${r.app} is in front.${r.note ? ` ${r.note}` : ''}`};
    }
    case 'computer_apps': {
        const s = screen ?? await screenSize();
        const k = factor(s);
        const r = await desk<Apps>(['apps']);
        const apps = r.apps.map((p) => `- ${p.name}${p.front ? ' (in front)' : ''}${p.hidden ? ' (hidden)' : ''}`);
        const windows = r.windows.map((w) => `- ${w.app}: "${w.title || '(untitled)'}" at (${px(w.x * k)},${px(w.y * k)}) ${px(w.w * k)}×${px(w.h * k)}`);
        return {text: `Running apps:\n${apps.join('\n')}\n\nWindows on screen (front to back, in screenshot pixels):\n${windows.join('\n') || '- none'}`};
    }
    case 'computer_clipboard': {
        if (a.action === 'write') {
            const text = String(a.text ?? '');
            await desk(['clipboard', 'set'], {stdin: text});
            return {text: `Put ${text.length} characters on the clipboard. Press cmd+v where it should go.`};
        }
        const r = await desk<{text: string}>(['clipboard', 'get']);
        return {text: r.text ? `Clipboard:\n${r.text}` : 'The clipboard is empty.'};
    }
    case 'computer_wait': {
        const secs = Math.max(1, Math.min(15, n(a.seconds, 2)));
        await new Promise((r) => setTimeout(r, secs * 1000));
        const shot = await desk<Shot>(['screenshot', String(MAX_WIDTH)], {timeoutMs: 30_000});
        screen = {width: shot.screenWidth, height: shot.screenHeight, scale: 2, front: shot.front ?? ''};
        return {text: `Waited ${secs}s. ${describeShot(shot)}`, images: [image(shot)]};
    }
    default:
        throw new Error(`This Mac can't do ${tool}.`);
    }
}

// What this Mac offers agents (the server only offers these as tools).
export const COMPUTER_CAPABILITIES = [
    'computer_screenshot', 'computer_zoom', 'computer_read_screen', 'computer_click', 'computer_move', 'computer_drag', 'computer_scroll', 'computer_type', 'computer_key',
    'computer_open', 'computer_focus', 'computer_apps', 'computer_clipboard', 'computer_wait',
    'confirm_gate', // stops before Send, Pay, Delete… and refuses password fields (lib/gate.ts)
];

export type Permissions = {accessibility: boolean; screen: boolean};

export async function permissions(): Promise<Permissions> {
    return desk<Permissions>(['permissions']);
}

// For Settings: a quick look, to check the permissions work.
export async function testScreenshot(): Promise<{image: string; front: string}> {
    const shot = await desk<Shot>(['screenshot', '800'], {timeoutMs: 30_000});
    return {image: image(shot), front: shot.front ?? ''};
}
