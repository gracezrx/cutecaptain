// Using the person's own computer. While their Mac app is online, an agent
// working for them gets computer_* tools (see the screen, read it as text,
// click, type, open apps); while their Chrome extension is online, browser_*
// tools (tabs, pages as numbered elements, click, type, navigate). Each call
// is relayed to the device (app/devices.ts), which does it and answers.
//
// The first use in a run asks the person once ("Let Captain use your Mac for
// this task"), unless the device is on autopilot. Esc on the little Captain
// stops the run at any time.

import type {Ctx} from '../../app/context.js';
import type {DeviceResult} from '../../shared/types.js';
import {type DeviceRow, grantDevice, grantedDevices} from '../../store/devices.js';
import type {UserRow} from '../../store/users.js';

import {str, type Tool, type ToolContext} from './types.js';

// Agents with these on may use the person's devices (Settings → Agents).
export const useComputer: Tool = {
    name: 'use_computer',
    description: 'Use the person\'s Mac when their Captain app is open: see the screen, read it as text, click, type, open apps.',
    parameters: {type: 'object', properties: {}},
    external: false,
    marker: true,
    available: () => true,
    async run() {
        return {content: 'Use the computer_* tools instead.'};
    },
};

export const useBrowser: Tool = {
    name: 'use_browser',
    description: 'Use the person\'s Chrome when their Captain extension is on: open pages, read them, click, type, fill forms.',
    parameters: {type: 'object', properties: {}},
    external: false,
    marker: true,
    available: () => true,
    async run() {
        return {content: 'Use the browser_* tools instead.'};
    },
};

export const isDeviceTool = (name: string): boolean => name.startsWith('computer_') || name.startsWith('browser_');

type Spec = {
    description: string;
    parameters: Record<string, unknown>;
    activity: (a: Record<string, unknown>) => string;
    timeoutMs?: number;
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : Number.parseInt(String(v ?? ''), 10) || 0);
const at = (a: Record<string, unknown>) => `(${num(a.x)}, ${num(a.y)})`;
const short = (v: unknown, n = 40) => str(v, n).replace(/\s+/g, ' ');

const XY = {x: {type: 'number', description: 'Pixels from the left of the latest screenshot'}, y: {type: 'number', description: 'Pixels from the top of the latest screenshot'}};

export const COMPUTER: Record<string, Spec> = {
    computer_screenshot: {
        description: 'See the whole screen. Returns an image; the coordinates you give to other computer tools are pixels in this image. Take one before you act and again after, to check what happened.',
        parameters: {type: 'object', properties: {}},
        activity: () => 'Looking at the screen',
        timeoutMs: 45_000,
    },
    computer_zoom: {
        description: 'See part of the screen close up and sharp (small text, a table, a chart). Give the region in latest-screenshot pixels.',
        parameters: {type: 'object', properties: {...XY, width: {type: 'number'}, height: {type: 'number'}}, required: ['x', 'y', 'width', 'height']},
        activity: () => 'Looking closer',
        timeoutMs: 45_000,
    },
    computer_read_screen: {
        description: 'Read the app in front (or the app named) as text: every button, field, link, menu, table cell and text block, with its position. Faster and more exact than looking: use it to read spreadsheets, documents, lists and dialogs, and to find where to click. Positions are in latest-screenshot pixels.',
        parameters: {type: 'object', properties: {app: {type: 'string', description: 'App name, e.g. "Numbers". Default: the app in front.'}, query: {type: 'string', description: 'Only elements whose text contains this'}, max: {type: 'number', description: 'Most lines to return (default 400)'}}},
        activity: (a) => (a.app ? `Reading ${short(a.app)}` : 'Reading the screen'),
        timeoutMs: 45_000,
    },
    computer_click: {
        description: 'Click at a point. count 2 double-clicks, 3 triple-clicks; button right opens a context menu. Modifiers like ["cmd"] or ["shift"] hold those keys.',
        parameters: {type: 'object', properties: {...XY, button: {type: 'string', enum: ['left', 'right', 'middle']}, count: {type: 'number', enum: [1, 2, 3]}, modifiers: {type: 'array', items: {type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl']}}}, required: ['x', 'y']},
        activity: (a) => `${a.count === 2 ? 'Double-clicking' : a.button === 'right' ? 'Right-clicking' : 'Clicking'} ${at(a)}`,
    },
    computer_move: {
        description: 'Move the mouse to a point without clicking (to hover, or to reveal something).',
        parameters: {type: 'object', properties: XY, required: ['x', 'y']},
        activity: (a) => `Hovering ${at(a)}`,
    },
    computer_drag: {
        description: 'Press at one point and drag to another (select cells or text, move a file, resize).',
        parameters: {type: 'object', properties: {fromX: {type: 'number'}, fromY: {type: 'number'}, toX: {type: 'number'}, toY: {type: 'number'}}, required: ['fromX', 'fromY', 'toX', 'toY']},
        activity: (a) => `Dragging to (${num(a.toX)}, ${num(a.toY)})`,
    },
    computer_scroll: {
        description: 'Scroll at a point. amount is in notches (default 5).',
        parameters: {type: 'object', properties: {...XY, direction: {type: 'string', enum: ['up', 'down', 'left', 'right']}, amount: {type: 'number'}}, required: ['x', 'y', 'direction']},
        activity: (a) => `Scrolling ${short(a.direction)}`,
    },
    computer_type: {
        description: 'Type text where the cursor is (click a field first). Use "\\n" for a new line. With submit true, Enter is pressed after.',
        parameters: {type: 'object', properties: {text: {type: 'string'}, submit: {type: 'boolean'}}, required: ['text']},
        activity: (a) => `Typing "${short(a.text, 30)}${str(a.text).length > 30 ? '…' : ''}"`,
        timeoutMs: 60_000,
    },
    computer_key: {
        description: 'Press a key or shortcut: "enter", "tab", "escape", "backspace", "delete", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "space", "f5", or combinations like "cmd+l", "cmd+shift+t", "cmd+a", "ctrl+c". Several in a row: "cmd+a backspace".',
        parameters: {type: 'object', properties: {keys: {type: 'string'}}, required: ['keys']},
        activity: (a) => `Pressing ${short(a.keys)}`,
    },
    computer_open: {
        description: 'Open an app by name ("Numbers", "Google Chrome", "Mail"), a web address, or a file path. The app comes to the front.',
        parameters: {type: 'object', properties: {app: {type: 'string'}, url: {type: 'string'}, path: {type: 'string'}}},
        activity: (a) => `Opening ${short(a.app ?? a.url ?? a.path)}`,
        timeoutMs: 60_000,
    },
    computer_focus: {
        description: 'Bring a running app (or one of its windows, by title) to the front.',
        parameters: {type: 'object', properties: {app: {type: 'string'}, window: {type: 'string', description: 'Part of the window title'}}, required: ['app']},
        activity: (a) => `Switching to ${short(a.app)}`,
    },
    computer_apps: {
        description: 'The apps running and their windows (titles and positions), and which is in front.',
        parameters: {type: 'object', properties: {}},
        activity: () => 'Checking what\'s open',
    },
    computer_clipboard: {
        description: 'Read the clipboard, or put text on it (then paste with cmd+v: the fastest way to enter long text).',
        parameters: {type: 'object', properties: {action: {type: 'string', enum: ['read', 'write']}, text: {type: 'string'}}, required: ['action']},
        activity: (a) => (a.action === 'write' ? 'Copying text' : 'Reading the clipboard'),
    },
    computer_wait: {
        description: 'Wait a few seconds (a page loading, an app opening), then see the screen again.',
        parameters: {type: 'object', properties: {seconds: {type: 'number', description: '1 to 15'}}, required: ['seconds']},
        activity: (a) => `Waiting ${Math.min(15, Math.max(1, num(a.seconds)))}s`,
        timeoutMs: 60_000,
    },
};

const REF = {ref: {type: 'string', description: 'An element id from browser_snapshot, like "e12"'}};
const TAB = {tabId: {type: 'number', description: 'From browser_tabs; default: the tab you\'re working in'}};

export const BROWSER: Record<string, Spec> = {
    browser_tabs: {
        description: 'The open Chrome tabs: id, title, address, and which one you\'re working in.',
        parameters: {type: 'object', properties: {}},
        activity: () => 'Checking Chrome tabs',
    },
    browser_open: {
        description: 'Go to a web address in the tab you\'re working in (or a new tab), wait for it to load, and get its snapshot.',
        parameters: {type: 'object', properties: {url: {type: 'string'}, newTab: {type: 'boolean'}}, required: ['url']},
        activity: (a) => `Opening ${short(a.url, 60)}`,
        timeoutMs: 60_000,
    },
    browser_switch: {
        description: 'Work in another open tab.',
        parameters: {type: 'object', properties: {tabId: {type: 'number'}}, required: ['tabId']},
        activity: () => 'Switching tabs',
    },
    browser_snapshot: {
        description: 'The page as text you can act on: its address, headings, and every link, button, field, checkbox and menu with an id like [e12] and its current value. Click and type by those ids. Call it again after the page changes.',
        parameters: {type: 'object', properties: {...TAB, query: {type: 'string', description: 'Only elements whose text contains this'}}},
        activity: () => 'Reading the page',
    },
    browser_read: {
        description: 'The readable text of the page (an article, an email, search results, a document), up to 40,000 characters. For acting on the page use browser_snapshot.',
        parameters: {type: 'object', properties: TAB},
        activity: () => 'Reading the page',
    },
    browser_click: {
        description: 'Click an element by its id from browser_snapshot, or by its visible text when there\'s no id yet.',
        parameters: {type: 'object', properties: {...REF, text: {type: 'string', description: 'Visible text of a link or button, instead of ref'}, ...TAB}},
        activity: (a) => `Clicking ${a.ref ? short(a.ref) : `"${short(a.text)}"`}`,
    },
    browser_type: {
        description: 'Type into a field (by id), replacing what\'s there unless append is true; with submit true, Enter is pressed after. Works in rich editors too (email bodies, chat boxes). Without a ref, types where the cursor is.',
        parameters: {type: 'object', properties: {...REF, text: {type: 'string'}, submit: {type: 'boolean'}, append: {type: 'boolean'}, ...TAB}, required: ['text']},
        activity: (a) => `Typing "${short(a.text, 30)}${str(a.text).length > 30 ? '…' : ''}"`,
        timeoutMs: 60_000,
    },
    browser_press: {
        description: 'Press a key in the page: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", or a combination like "cmd+a", "cmd+Enter", "shift+Tab".',
        parameters: {type: 'object', properties: {key: {type: 'string'}, ...TAB}, required: ['key']},
        activity: (a) => `Pressing ${short(a.key)}`,
    },
    browser_select: {
        description: 'Choose an option in a dropdown (a <select>), by its visible text or value.',
        parameters: {type: 'object', properties: {...REF, value: {type: 'string'}, ...TAB}, required: ['ref', 'value']},
        activity: (a) => `Choosing "${short(a.value)}"`,
    },
    browser_scroll: {
        description: 'Scroll the page (or an element by id) up or down; "bottom" and "top" go all the way.',
        parameters: {type: 'object', properties: {direction: {type: 'string', enum: ['up', 'down', 'top', 'bottom']}, ...REF, ...TAB}, required: ['direction']},
        activity: (a) => `Scrolling ${short(a.direction)}`,
    },
    browser_screenshot: {
        description: 'See the tab as an image (for layouts, charts, images, or when the snapshot isn\'t enough).',
        parameters: {type: 'object', properties: TAB},
        activity: () => 'Looking at the page',
        timeoutMs: 45_000,
    },
    browser_wait: {
        description: 'Wait for the page: a number of seconds, or until some text appears (up to 20s).',
        parameters: {type: 'object', properties: {seconds: {type: 'number'}, text: {type: 'string'}, ...TAB}},
        activity: (a) => (a.text ? `Waiting for "${short(a.text)}"` : `Waiting ${Math.min(20, Math.max(1, num(a.seconds) || 2))}s`),
        timeoutMs: 60_000,
    },
    browser_back: {
        description: 'Go back one page.',
        parameters: {type: 'object', properties: TAB},
        activity: () => 'Going back',
    },
    browser_close: {
        description: 'Close a tab you opened.',
        parameters: {type: 'object', properties: {tabId: {type: 'number'}}, required: ['tabId']},
        activity: () => 'Closing a tab',
    },
};

const DEFAULT_TIMEOUT_MS = 30_000;

function deviceLabel(d: DeviceRow): string {
    return d.kind === 'chrome' ? `${d.name} (Chrome)` : d.name;
}

// The tools for one device. `granted` is shared with the runner for this run:
// once the person says yes (or the device is on autopilot), nothing asks again.
function toolsForDevice(device: DeviceRow, specs: Record<string, Spec>, granted: Set<string>, agentName: string): Tool[] {
    const offered = device.capabilities.length ? new Set(device.capabilities) : new Set(Object.keys(specs));
    return Object.entries(specs).filter(([name]) => offered.has(name)).map(([name, spec]): Tool => ({
        name,
        description: spec.description,
        parameters: spec.parameters,
        external: false,
        available: () => true,
        activity: spec.activity,
        needsApproval: () => !device.autopilot && !granted.has(device.id),
        describe: (args) => ({
            title: `Let ${agentName} use ${deviceLabel(device)} for this task`,
            reason: device.kind === 'chrome' ?
                'It will open and read pages in your Chrome, and click and type in them, until this task is done. Press Esc on the little Captain to stop it. Turn on hands-free in Settings → This Mac to skip this question.' :
                'It will see your screen, and click and type for you, until this task is done. Press Esc on the little Captain to stop it. Turn on hands-free in Settings → This Mac to skip this question.',
            fields: [{label: 'First step', value: spec.activity(args)}],
        }),
        async run(tc: ToolContext, args: Record<string, unknown>) {
            if (!granted.has(device.id)) {
                granted.add(device.id);
                await grantDevice(tc.ctx.sql, tc.run.id, device.id, tc.requester.id).catch(() => undefined);
            }
            const res = await tc.ctx.devices.request({
                device, requester: tc.requester, runId: tc.run.id, stepId: tc.stepId, tool: name, args, signal: tc.signal,
                timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });
            return {content: (res.text ?? '').trim() || (res.images?.length ? 'Here is what the screen shows.' : 'Done.'), images: res.images};
        },
    }));
}

// Built per run, for the person who asked (not for a bot asking a bot).
export async function deviceTools(ctx: Ctx, requester: UserRow, agent: {name: string; tools: string[]}, runId: string): Promise<{tools: Tool[]; devices: DeviceRow[]}> {
    const wantsMac = agent.tools.includes('use_computer');
    const wantsChrome = agent.tools.includes('use_browser');
    if (requester.isBot || (!wantsMac && !wantsChrome)) {
        return {tools: [], devices: []};
    }
    const online = await ctx.devices.online(requester).catch(() => [] as DeviceRow[]);
    const mac = wantsMac ? online.find((d) => d.kind === 'mac') : undefined;
    const chrome = wantsChrome ? online.find((d) => d.kind === 'chrome') : undefined;
    if (!mac && !chrome) {
        return {tools: [], devices: []};
    }
    const granted = await grantedDevices(ctx.sql, runId).catch(() => new Set<string>());
    const tools: Tool[] = [];
    const devices: DeviceRow[] = [];
    if (mac) {
        tools.push(...toolsForDevice(mac, COMPUTER, granted, agent.name));
        devices.push(mac);
    }
    if (chrome) {
        tools.push(...toolsForDevice(chrome, BROWSER, granted, agent.name));
        devices.push(chrome);
    }
    return {tools, devices};
}

export type {DeviceResult};
