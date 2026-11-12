// The extension's background worker: the right-click menu ("Send to
// Captain"), the toolbar badge (approvals and mentions waiting for you), and
// the device link: with "Let agents use Chrome" on (the popup), this Chrome
// registers with the server over a socket, and agents working for you can
// open and read pages, click and type (browser.ts).
// It shares the signed-in session with the popup through chrome.storage.

import {BROWSER_CAPABILITIES, describeBrowser, isBrowserAction, releaseWork, runBrowser, showWorkingTab, workingView} from './browser';

type StoredSession = {serverUrl: string; token: string; userId: string};

const MENUS: chrome.contextMenus.CreateProperties[] = [
    {id: 'page', title: 'Send this page to Captain', contexts: ['page', 'link']},
    {id: 'selection', title: 'Send “%s” to Captain', contexts: ['selection']},
    {id: 'image', title: 'Send this image to Captain', contexts: ['image']},
    {id: 'screenshot', title: 'Send a screenshot of this tab to Captain', contexts: ['page']},
];

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => MENUS.forEach((m) => chrome.contextMenus.create(m)));
    void chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false});
});

chrome.runtime.onStartup.addListener(() => {
    void updateBadge();
    void connectDevice();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.windowId) {
        return;
    }
    // First, while Chrome still counts the click: open the side panel.
    void chrome.sidePanel.open({windowId: tab.windowId});
    void (async () => {
        const pending: Record<string, unknown> = {
            nonce: Date.now(),
            kind: String(info.menuItemId),
            url: info.menuItemId === 'page' && info.linkUrl ? info.linkUrl : info.pageUrl ?? tab.url,
            title: info.menuItemId === 'page' && info.linkUrl ? info.linkUrl : tab.title,
            selection: info.selectionText,
            imageUrl: info.srcUrl,
        };
        if (info.menuItemId === 'screenshot') {
            try {
                pending.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
            } catch {
                pending.kind = 'page'; // couldn't capture this page: send its link
            }
        }
        await chrome.storage.session.set({pending});
    })();
});

// ------------------------------------------------------------ badge

chrome.alarms.create('badge', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'badge') {
        void updateBadge();
        void connectDevice(); // the worker may have been put to sleep: come back
    }
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['captain.session']) {
        void updateBadge();
        void connectDevice(true);
    }
    if (area === 'local' && changes[KEY_AGENTS]) {
        void connectDevice(true);
    }
});

async function session(): Promise<StoredSession | null> {
    const raw = (await chrome.storage.local.get('captain.session'))['captain.session'];
    try {
        return typeof raw === 'string' ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
        return null;
    }
}

async function get<T>(s: StoredSession, path: string): Promise<T> {
    const res = await fetch(`${s.serverUrl}/api/v1${path}`, {headers: {Authorization: `Bearer ${s.token}`}, signal: AbortSignal.timeout(10_000)});
    if (!res.ok) {
        throw new Error(String(res.status));
    }
    return res.json() as Promise<T>;
}

type Member = {channelId: string; mentionCount: number; msgCount: number};
type Channel = {id: string; type: string; totalMsgCount: number};

// Decisions you can make, plus chats that mention you or DMs you haven't read.
async function updateBadge(): Promise<void> {
    const s = await session();
    if (!s) {
        await chrome.action.setBadgeText({text: ''});
        return;
    }
    try {
        let count = 0;
        const workspaces = await get<{id: string}[]>(s, '/workspaces');
        for (const ws of workspaces.slice(0, 5)) {
            const [approvals, chats] = await Promise.all([
                get<unknown[]>(s, `/workspaces/${ws.id}/approvals`).catch(() => []),
                get<{channels: Channel[]; members: Member[]}>(s, `/workspaces/${ws.id}/channels`),
            ]);
            count += approvals.length;
            const byId = new Map(chats.channels.map((c) => [c.id, c]));
            for (const m of chats.members) {
                const c = byId.get(m.channelId);
                if (m.mentionCount > 0 || (c && (c.type === 'D' || c.type === 'G') && c.totalMsgCount > m.msgCount)) {
                    count++;
                }
            }
        }
        await chrome.action.setBadgeBackgroundColor({color: '#c08a1e'});
        await chrome.action.setBadgeText({text: count > 0 ? String(Math.min(count, 99)) : ''});
    } catch {
        // signed out elsewhere or offline: leave the badge as it was
    }
}

// ------------------------------------------------------------ the device link
//
// One socket to the server while "Let agents use Chrome" is on and someone
// is signed in. The worker stays awake while messages flow, so it pings
// every 20 seconds; if Chrome puts it to sleep anyway, the badge alarm
// brings it back and the server sends again what it didn't answer.

const KEY_AGENTS = 'captain.agents';
const KEY_DEVICE = 'captain.device.id';

type DeviceRequest = {id: string; deviceId: string; runId: string | null; stepId: string | null; tool: string; args: Record<string, unknown>; deadline: number};

let ws: WebSocket | null = null;
let wsSession: string | null = null;
let deviceId: string | null = null;
let seq = 1;
let pinger: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let queue: Promise<unknown> = Promise.resolve();

async function agentsOn(): Promise<boolean> {
    return (await chrome.storage.local.get(KEY_AGENTS))[KEY_AGENTS] === true;
}

function sendWs(msg: Record<string, unknown>): void {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({...msg, seq: seq++}));
    }
}

function dropWs(): void {
    if (pinger) {
        clearInterval(pinger);
        pinger = null;
    }
    if (retry) {
        clearTimeout(retry);
        retry = null;
    }
    const old = ws;
    ws = null;
    wsSession = null;
    old?.close();
}

// One connection attempt at a time: two overlapping ones (a sign-in and the
// agents switch changing together, the alarm firing during startup) could
// otherwise both open a socket, and every request would be done twice.
let connecting: Promise<void> = Promise.resolve();

function connectDevice(fresh = false): Promise<void> {
    connecting = connecting.catch(() => undefined).then(() => connectOnce(fresh));
    return connecting;
}

async function connectOnce(fresh: boolean): Promise<void> {
    const s = await session();
    const on = await agentsOn();
    const key = s ? `${s.serverUrl}|${s.token}` : null;
    if (!s || !on) {
        dropWs();
        await setTitle(on ? 'Captain · sign in to let agents use Chrome' : 'Captain');
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && wsSession === key && !fresh) {
        return;
    }
    dropWs();
    deviceId = deviceId ?? ((await chrome.storage.local.get(KEY_DEVICE))[KEY_DEVICE] as string | undefined) ?? null;
    const socket = new WebSocket(`${s.serverUrl.replace(/^http/, 'ws')}/api/v1/websocket`);
    ws = socket;
    wsSession = key;
    socket.onopen = () => {
        attempts = 0;
        socket.send(JSON.stringify({action: 'auth', seq: seq++, token: s.token}));
    };
    socket.onmessage = (m) => {
        if (ws !== socket) {
            return; // an old socket on its way out: only the current one acts
        }
        let msg: Record<string, any>;
        try {
            msg = JSON.parse(String(m.data));
        } catch {
            return;
        }
        if (msg.event === 'hello') {
            sendWs({action: 'device_register', device: {id: deviceId, kind: 'chrome', name: 'Chrome', capabilities: BROWSER_CAPABILITIES}});
            pinger = setInterval(() => sendWs({action: 'ping'}), 20_000);
            return;
        }
        if (msg.status === 'OK' && msg.data?.deviceId) {
            if (msg.data.deviceId !== deviceId) {
                deviceId = msg.data.deviceId;
                void chrome.storage.local.set({[KEY_DEVICE]: deviceId});
            }
            void setTitle('Captain · agents can use this Chrome');
            return;
        }
        if (msg.event === 'device_request' && msg.data?.deviceId === deviceId) {
            handle(msg.data as DeviceRequest);
        } else if (msg.event === 'device_show' && msg.data?.deviceId === deviceId) {
            void showWorkingTab();
        } else if (msg.event === 'device_released' && msg.data?.deviceId === deviceId) {
            void releaseWork();
            void setTitle('Captain · agents can use this Chrome');
        }
    };
    socket.onclose = (e) => {
        if (ws !== socket) {
            return;
        }
        ws = null;
        if (pinger) {
            clearInterval(pinger);
            pinger = null;
        }
        if (e.code === 4001) {
            return; // signed out: the storage change reconnects when someone signs in
        }
        retry = setTimeout(() => void connectDevice(), Math.min(30_000, 1000 * 2 ** attempts++));
    };
    socket.onerror = () => undefined;
}

// Requests run one at a time, in order (one mouse, one keyboard).
function handle(req: DeviceRequest): void {
    queue = queue.catch(() => undefined).then(async () => {
        const doing = describeBrowser(req.tool, req.args);
        await setTitle(`Captain · ${doing}`);
        // The little Captain (on the Mac) shows what's happening here.
        sendWs({action: 'device_progress', requestId: req.id, text: doing, ...(await workingView(false).catch(() => ({})))});
        try {
            const result = await runBrowser(req.tool, req.args);
            answer(req, {ok: true, result});
            if (isBrowserAction(req.tool) && !result.needsConfirm && !result.needsPerson) {
                const view = await workingView(true).catch(() => ({}));
                sendWs({action: 'device_progress', requestId: req.id, text: doing, ...view});
            }
        } catch (e) {
            answer(req, {ok: false, error: (e as Error)?.message || 'That didn\'t work in Chrome.'});
        }
    });
}

function answer(req: DeviceRequest, body: {ok: boolean; result?: unknown; error?: string}): void {
    if (ws?.readyState === WebSocket.OPEN) {
        sendWs({action: 'device_result', requestId: req.id, ...body});
        return;
    }
    // The socket dropped meanwhile: the HTTP way.
    void session().then(async (s) => {
        if (s && deviceId) {
            await fetch(`${s.serverUrl}/api/v1/devices/${deviceId}/requests/${req.id}`, {
                method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`}, body: JSON.stringify(body),
            });
        }
    }).catch(() => undefined);
}

async function setTitle(title: string): Promise<void> {
    await chrome.action.setTitle({title}).catch(() => undefined);
}

void connectDevice();
