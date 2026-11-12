// Everything that needs macOS goes through here. Inside the Tauri app these
// call the Rust core; in the Chrome extension they use Chrome's APIs; in a
// plain browser they fall back to something reasonable.

import {invoke} from '@tauri-apps/api/core';
import {emitTo, listen, type UnlistenFn} from '@tauri-apps/api/event';
import {getCurrentWindow, LogicalSize} from '@tauri-apps/api/window';

import {captureTab} from '../extension/tab';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// The Chrome extension's pages (popup and side panel).
export const isExtension = !isTauri && typeof chrome !== 'undefined' && !!chrome.runtime?.id && location.protocol === 'chrome-extension:';
export const extensionSurface: 'popup' | 'sidepanel' | null = isExtension ? (location.pathname.includes('popup') ? 'popup' : 'sidepanel') : null;

export type PanelMode = 'compose' | 'inbox' | 'thread';
export type PanelTarget = {mode: PanelMode; channelId?: string; postId?: string};

export function windowLabel(): 'main' | 'panel' {
    if (isTauri) {
        return getCurrentWindow().label === 'panel' ? 'panel' : 'main';
    }
    return location.pathname.endsWith('panel.html') ? 'panel' : 'main';
}

// ------------------------------------------------------------ secrets

const LOCAL_PREFIX = 'captain.';

// In the extension, chrome.storage: shared with its background worker (the badge).
export async function secretGet(key: string): Promise<string | null> {
    if (isExtension) {
        const v = (await chrome.storage.local.get(LOCAL_PREFIX + key))[LOCAL_PREFIX + key];
        return typeof v === 'string' ? v : null;
    }
    if (isTauri) {
        try {
            return await invoke<string | null>('secret_get', {key});
        } catch {
            // fall through to local storage
        }
    }
    return localStorage.getItem(LOCAL_PREFIX + key);
}

export async function secretSet(key: string, value: string): Promise<void> {
    if (isExtension) {
        await chrome.storage.local.set({[LOCAL_PREFIX + key]: value});
        return;
    }
    if (isTauri) {
        try {
            await invoke('secret_set', {key, value});
            return;
        } catch {
            // fall through to local storage
        }
    }
    localStorage.setItem(LOCAL_PREFIX + key, value);
}

export async function secretDelete(key: string): Promise<void> {
    if (isExtension) {
        await chrome.storage.local.remove(LOCAL_PREFIX + key);
        return;
    }
    if (isTauri) {
        await invoke('secret_delete', {key}).catch(() => undefined);
    }
    localStorage.removeItem(LOCAL_PREFIX + key);
}

// ------------------------------------------------------------ notifications and badge

export async function notify(title: string, body: string, target: PanelTarget): Promise<void> {
    if (isTauri) {
        await invoke('notify', {title, body, target}).catch((e) => console.warn('notify failed', e));
        return;
    }
    if (isExtension) {
        return; // the toolbar badge says it instead
    }
    if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, {body});
        n.onclick = () => showPanel(target);
    }
}

export async function setBadge(count: number): Promise<void> {
    if (isTauri) {
        await invoke('set_badge', {count}).catch(() => undefined);
        return;
    }
    if (isExtension) {
        await chrome.action.setBadgeText({text: count > 0 ? String(count) : ''}).catch(() => undefined);
        return;
    }
    document.title = count > 0 ? `(${count}) Captain` : 'Captain';
}

// ------------------------------------------------------------ windows

// In the extension the popup or side panel is the panel: switch its view.
const panelListeners = new Set<(t: PanelTarget) => void>();

export async function showPanel(target: PanelTarget): Promise<void> {
    if (isExtension) {
        panelListeners.forEach((fn) => fn(target));
        return;
    }
    if (isTauri) {
        await invoke('show_panel', {target});
        return;
    }
    const q = new URLSearchParams({mode: target.mode, ...(target.channelId ? {channel: target.channelId} : {}), ...(target.postId ? {post: target.postId} : {})});
    window.open(`/panel.html?${q}`, 'captain-panel', 'width=400,height=600');
}

export async function hidePanel(): Promise<void> {
    if (isTauri) {
        await invoke('hide_panel');
    } else if (extensionSurface === 'popup') {
        window.close();
    }
}

export async function openDashboard(channelId?: string): Promise<void> {
    if (isExtension) {
        // Captain's web app, from the server this extension is signed in to.
        const {getServerUrl} = await import('./api');
        await chrome.tabs.create({url: `${getServerUrl()}/${channelId ? `?channel=${channelId}` : ''}`});
        return;
    }
    if (isTauri) {
        await invoke('open_dashboard');
        if (channelId) {
            await emitTo('main', 'open-channel', channelId);
        }
        return;
    }
    window.open(`/${channelId ? `?channel=${channelId}` : ''}`, 'captain-dashboard');
}

export function onPanelTarget(handler: (t: PanelTarget) => void): () => void {
    if (isExtension) {
        panelListeners.add(handler);
        const q = new URLSearchParams(location.search);
        handler({mode: (q.get('mode') as PanelMode) || 'compose', channelId: q.get('channel') || undefined, postId: q.get('post') || undefined});
        return () => panelListeners.delete(handler);
    }
    if (isTauri) {
        let un: UnlistenFn | undefined;
        listen<PanelTarget>('panel-target', (e) => handler(e.payload)).then((u) => {
            un = u;
        });
        return () => un?.();
    }
    const q = new URLSearchParams(location.search);
    handler({mode: (q.get('mode') as PanelMode) || 'compose', channelId: q.get('channel') || undefined, postId: q.get('post') || undefined});
    return () => undefined;
}

export function onOpenChannel(handler: (channelId: string) => void): () => void {
    if (isTauri) {
        let un: UnlistenFn | undefined;
        listen<string>('open-channel', (e) => handler(e.payload)).then((u) => {
            un = u;
        });
        return () => un?.();
    }
    const c = new URLSearchParams(location.search).get('channel');
    if (c) {
        handler(c);
    }
    return () => undefined;
}

let lastHeight = 0;
export async function setPanelHeight(height: number): Promise<void> {
    const h = Math.max(160, Math.min(680, Math.ceil(height)));
    if (!isTauri || h === lastHeight) {
        return;
    }
    lastHeight = h;
    await getCurrentWindow().setSize(new LogicalSize(400, h)).catch(() => undefined);
}

// ------------------------------------------------------------ events between windows

// The dashboard window owns the one WebSocket and relays each
// event to the panel, so the app keeps a single connection.
export async function relayToPanel(event: unknown): Promise<void> {
    if (isTauri) {
        await emitTo('panel', 'captain-event', event).catch(() => undefined);
    }
}

export function onRelayedEvent(handler: (event: unknown) => void): () => void {
    let un: UnlistenFn | undefined;
    listen('captain-event', (e) => handler(e.payload)).then((u) => {
        un = u;
    });
    return () => un?.();
}

// ------------------------------------------------------------ screen capture

export async function captureScreen(region: boolean): Promise<Blob | null> {
    if (isExtension) {
        return captureTab();
    }
    if (isTauri) {
        const data = await invoke<ArrayBuffer>('capture_screen', {region});
        if (!data || data.byteLength === 0) {
            return null; // cancelled
        }
        return new Blob([data], {type: 'image/png'});
    }
    return browserPreviewCapture();
}

// Without the Mac app there is no screen to capture; draw a labelled
// stand-in so the rest of the flow can be exercised.
async function browserPreviewCapture(): Promise<Blob> {
    const c = document.createElement('canvas');
    c.width = 1440;
    c.height = 900;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 1440, 900);
    grad.addColorStop(0, '#dbe6f7');
    grad.addColorStop(1, '#b8c9e6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1440, 900);
    g.fillStyle = '#ffffff';
    g.fillRect(160, 120, 1120, 660);
    g.fillStyle = '#0b1640';
    g.fillRect(160, 120, 1120, 56);
    g.fillStyle = '#142769';
    g.font = '600 40px sans-serif';
    g.fillText('Screen snapshot (browser preview)', 220, 300);
    g.fillStyle = '#64718a';
    g.font = '28px sans-serif';
    g.fillText('In the Mac app this is a real capture of your screen.', 220, 360);
    return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
}

// ------------------------------------------------------------ built-in server

// The Mac app can run the Captain server itself (see src-tauri/src/lib.rs).
export const LOCAL_SERVER = 'http://127.0.0.1:8787';

export type LocalServerStatus = {
    configured: boolean; // has a database address
    running: boolean;
    starting: boolean;
    url: string;
    error: string | null;
    log: string | null; // the end of the server's log, when it stopped
};

export async function localServerStatus(): Promise<LocalServerStatus | null> {
    if (!isTauri) {
        return null;
    }
    return invoke<LocalServerStatus>('local_server_status').catch(() => null);
}

// Accepts a database address, or a whole server .env (its DATABASE_URL and APP_SECRET lines).
export function parseServerSettings(text: string): {databaseUrl: string; appSecret: string | null} {
    const t = text.trim();
    const line = (name: string) => t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') ?? null;
    if (/^DATABASE_URL=/m.test(t)) {
        return {databaseUrl: line('DATABASE_URL') ?? '', appSecret: line('APP_SECRET')};
    }
    return {databaseUrl: t, appSecret: null};
}

// The address Supabase shows (Connect → Session pooler) has [YOUR-PASSWORD]
// in it: put the password there (or after the user name, if it has none).
export function withPassword(address: string, password: string): string {
    const a = address.trim();
    if (!password) {
        return a;
    }
    const pw = encodeURIComponent(password);
    if (a.includes('[YOUR-PASSWORD]')) {
        return a.replace('[YOUR-PASSWORD]', () => pw);
    }
    const bare = /^(postgres(?:ql)?:\/\/)([^:@/]+)@/.exec(a);
    return bare ? `${bare[1]}${bare[2]}:${pw}@${a.slice(bare[0].length)}` : a;
}

export async function localServerSetup(text: string, password = ''): Promise<void> {
    const {databaseUrl, appSecret} = parseServerSettings(text);
    await invoke('local_server_setup', {databaseUrl: withPassword(databaseUrl, password), appSecret});
}

// The settings of a Captain server you ran yourself before (its server/.env
// in a cutecaptain or captain-desktop folder). Only which project it is comes back; the
// address and secret stay in the app.
export type FoundServerSettings = {path: string; project: string; keepsKeys: boolean};

export async function localServerFound(): Promise<FoundServerSettings[]> {
    if (!isTauri) {
        return [];
    }
    return invoke<FoundServerSettings[]>('local_server_found').catch(() => []);
}

export async function localServerUseFound(path: string): Promise<void> {
    await invoke('local_server_use_found', {path});
}

export async function localServerRestart(): Promise<void> {
    await invoke('local_server_restart');
}

export async function localServerForget(): Promise<void> {
    await invoke('local_server_forget');
}

// Wait until a server answers its readiness check.
export async function waitForServer(url: string, timeoutMs = 30_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const res = await fetch(`${url}/readyz`, {signal: AbortSignal.timeout(2000)});
            if (res.ok) {
                return true;
            }
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

// ------------------------------------------------------------ voice (Mac app)

// Apple's speech recognition and voices, through the app's captain-voice
// helper. Events are tagged with who started listening, since every window
// hears them.
export type VoiceEvent =
    | {type: 'ready'; owner: string}
    | {type: 'level'; value: number; owner: string}
    | {type: 'partial' | 'final'; text: string; owner: string}
    | {type: 'error'; message: string; owner: string}
    | {type: 'end'; owner: string};

export const nativeVoice = isTauri;

export async function voiceStart(lang: string, owner: string): Promise<void> {
    await invoke('voice_start', {lang, owner});
}

export async function voiceStop(): Promise<void> {
    await invoke('voice_stop').catch(() => undefined);
}

export async function voiceCancel(): Promise<void> {
    await invoke('voice_cancel').catch(() => undefined);
}

export function onVoice(owner: string, handler: (e: VoiceEvent) => void): () => void {
    let un: UnlistenFn | undefined;
    let gone = false;
    listen<VoiceEvent>('voice', (e) => {
        if (e.payload.owner === owner) {
            handler(e.payload);
        }
    }).then((u) => {
        if (gone) {
            u();
        } else {
            un = u;
        }
    });
    return () => {
        gone = true;
        un?.();
    };
}

// Say something out loud (answers from Captain). Resolves when it's done.
export async function speak(text: string, lang: string): Promise<void> {
    if (!isTauri) {
        if ('speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = lang;
            await new Promise<void>((resolve) => {
                u.onend = () => resolve();
                u.onerror = () => resolve();
                speechSynthesis.speak(u);
            });
        }
        return;
    }
    let un: UnlistenFn | undefined;
    const done = new Promise<void>((resolve) => {
        listen('speech', () => resolve()).then((u) => {
            un = u;
        });
    });
    try {
        await invoke('speak', {text, lang});
        await done;
    } finally {
        un?.();
    }
}

export async function speakStop(): Promise<void> {
    if (isTauri) {
        await invoke('speak_stop').catch(() => undefined);
    } else if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
}

// ------------------------------------------------------------ shortcuts (Mac app)

export type ShortcutStatus = {keys: string; ok: boolean; error: string | null};

export async function shortcutsGet(): Promise<{panel: ShortcutStatus; talk: ShortcutStatus} | null> {
    return isTauri ? invoke('shortcuts_get') : null;
}

export async function shortcutSet(kind: 'panel' | 'talk', keys: string): Promise<ShortcutStatus> {
    return invoke('shortcut_set', {kind, keys});
}

// "Control+Shift+KeyC" → "⌃⇧C"
export function prettyKeys(keys: string): string {
    const symbols: Record<string, string> = {command: '⌘', cmd: '⌘', super: '⌘', commandorcontrol: '⌘', control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧'};
    const order = ['⌃', '⌥', '⇧', '⌘'];
    const parts = keys.split('+').map((p) => p.trim());
    const mods = parts.slice(0, -1).map((p) => symbols[p.toLowerCase()] ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = (parts.at(-1) ?? '').replace(/^Key/, '').replace(/^Digit/, '');
    return mods.join('') + key;
}

export async function talkButtonVisible(): Promise<boolean> {
    return isTauri ? invoke<boolean>('orb_get_visible') : false;
}

export async function setTalkButtonVisible(visible: boolean): Promise<void> {
    await invoke('orb_set_visible', {visible});
}

// ------------------------------------------------------------ links and the extension

// The Mac app's web views don't open links in a new window on their own, so
// web links go to the default browser.
export async function openExternal(url: string): Promise<void> {
    if (isTauri) {
        await invoke('open_url', {url});
    } else {
        window.open(url, '_blank', 'noopener');
    }
}

export function openLinksInBrowser(): void {
    if (!isTauri) {
        return;
    }
    document.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || e.defaultPrevented) {
            return;
        }
        const url = new URL(a.href, location.href);
        const external = /^(https?|mailto):$/.test(url.protocol) && (a.target === '_blank' || url.origin !== location.origin);
        if (external) {
            e.preventDefault();
            void openExternal(url.toString()).catch((err) => console.warn('open link failed', err));
        }
    });
}

// Copies the Chrome extension the app carries to a folder Chrome can load and
// shows it in Finder. Returns the folder.
export async function revealChromeExtension(): Promise<string> {
    return invoke<string>('chrome_extension_reveal');
}

export const RELEASE_PAGE = 'https://github.com/gracezrx/cutecaptain/releases/tag/app-latest';

// ------------------------------------------------------------ voice typing (Mac app)

// The app in front of Captain (where voice typing goes), or null.
export type FrontApp = {name: string; pid: number};

export async function frontApp(): Promise<FrontApp | null> {
    return isTauri ? invoke<FrontApp | null>('front_app').catch(() => null) : null;
}

// Paste text where the cursor is in that app. Needs Accessibility permission;
// the error says how to turn it on.
export async function typeInto(pid: number, text: string): Promise<void> {
    await invoke('type_text', {pid, text});
}

export const ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const SCREEN_RECORDING_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// Esc cancels while Captain listens or speaks, whichever app is in front.
export async function orbEscape(active: boolean): Promise<void> {
    if (isTauri) {
        await invoke('orb_escape', {active}).catch(() => undefined);
    }
}
