// The floating Captain: a little Captain that stays on top of everything,
// from the "Captain Lite — floating Captain" canvas.
//
// - Hold it (or hold the talk shortcut) to talk; let go to send. The talk card
//   shows where it's going: the chat and agents you named, or Captain.
// - Or switch the card to "Type into <app>": let go and Captain types what you
//   said where your cursor is.
// - Click it to unfold the card at the top right (what needs you, what's
//   being worked on). Double-click to talk hands-free; click again to send.
// - It shows what it's doing: listening, working (with the agents on it),
//   speaking the answer, done. A gold count says how many things need you.
// - Drag it anywhere; it settles on the nearest edge. Right-click for options.
//
// Listening, speaking and typing go through the app's voice helper; requests
// are posted by the dashboard window (lib/talk.ts), which holds the session.

import {invoke} from '@tauri-apps/api/core';
import {emitTo, listen} from '@tauri-apps/api/event';
import {currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize} from '@tauri-apps/api/window';
import {Check, ChevronDown, Globe, Hash, MousePointerClick, TextCursorInput, VolumeX, X} from 'lucide-react';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {portraitSrc} from '../components/Avatar';
import {getVoiceLang, setVoiceLang, type VoiceLang} from '../lib/dictation';
import {
    ACCESSIBILITY_SETTINGS, type FrontApp, frontApp, isTauri, openExternal, orbEscape, prettyKeys, showPanel,
    shortcutsGet, speak, speakStop, typeInto, type VoiceEvent, voiceCancel, voiceStart, voiceStop,
} from '../lib/native';
import type {DriveActivity} from '../lib/device';
import {type DirectoryAgent, type OrbDirectory, type Route, routeFor} from '../lib/route';
import {dictated, languageOf, spoken} from '../lib/spoken';
import {type OrbState, type ReplyByVoice, type TalkReply, type TalkStep, targetFor} from '../lib/talk';

import {Mascot, type MascotState} from './Mascot';

type Phase = 'idle' | 'listening' | 'working' | 'done' | 'speaking';
type TalkMode = 'chat' | 'type';
type How = 'hold' | 'handsfree' | 'key';
type Task = {id: string; where: string; lead: string; team: string[]; steps: TalkStep[]; channelId: string | null; rootId: string | null; sentAt: number};
type Answer = {by: string; agentId: string | null; text: string; where: string; channelId: string; rootId: string | null; postId: string};
type Notice = {text: string; tone: 'info' | 'error'; action?: {label: string; run: () => void}};

const BASE_W = 100; // the window at its smallest: just the Captain (logical px, see tauri.conf.json)
const BASE_H = 108;
const HOLD_MS = 220; // longer than this is a hold, shorter a click
const DOUBLE_MS = 280; // a second click within this is a double-click
const SENT_CARD_MS = 6000; // how long "Sent to …" stays before folding into the Captain
const ANSWER_CARD_MS = 12_000;

function readPref(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writePref(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // not remembered
    }
}

// A Tauri event, for as long as the component is mounted (the latest handler,
// listening once).
function useTauriEvent<T>(name: string, handler: (payload: T) => void): void {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        let un: (() => void) | undefined;
        let gone = false;
        void listen<T>(name, (e) => ref.current(e.payload)).then((u) => {
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
    }, [name]);
}

function joinNames(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function Orb() {
    const [phase, setPhase] = useState<Phase>('idle');
    const phaseRef = useRef<Phase>('idle');
    phaseRef.current = phase;
    const [how, setHow] = useState<How>('hold');
    const howRef = useRef<How>('hold');
    const [mode, setModeState] = useState<TalkMode>(() => (readPref('captain.orb.mode') === 'type' ? 'type' : 'chat'));
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const [front, setFront] = useState<FrontApp | null>(null);
    const frontRef = useRef<FrontApp | null>(null);
    frontRef.current = front;
    const [heard, setHeard] = useState('');
    const heardRef = useRef('');
    const [levels, setLevels] = useState<number[]>([]);
    const [level, setLevel] = useState(0);
    const [pick, setPick] = useState<Route | null>(null); // a chat chosen on the card
    const pickRef = useRef<Route | null>(null);
    pickRef.current = pick;
    const [menu, setMenu] = useState(false);
    const [task, setTask] = useState<Task | null>(null);
    const taskRef = useRef<Task | null>(null);
    taskRef.current = task;
    const [answer, setAnswer] = useState<Answer | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    // An agent at work on this Mac (clicking, typing), from the dashboard window.
    const [drive, setDrive] = useState<DriveActivity | null>(null);
    const [hover, setHover] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [orb, setOrb] = useState<OrbState>({signedIn: false, needsYou: 0, directory: {channels: [], agents: []}});
    const dirRef = useRef<OrbDirectory>(orb.directory);
    dirRef.current = orb.directory;
    const [muted, setMuted] = useState(() => readPref('captain.orb.muted') === '1');
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const [lang, setLang] = useState<VoiceLang>(getVoiceLang());
    const [keys, setKeys] = useState({talk: '⌃⇧Space', panel: '⌃⇧C'});
    const [side, setSide] = useState<'right' | 'left'>('right');
    const cancelled = useRef(false);
    const timers = useRef<{answer?: number; notice?: number; hover?: number; single?: number; done?: number}>({});

    const setMode = (m: TalkMode) => {
        setModeState(m);
        writePref('captain.orb.mode', m);
    };

    const showNotice = useCallback((n: Notice | null, forMs?: number) => {
        window.clearTimeout(timers.current.notice);
        setNotice(n);
        if (n && forMs) {
            timers.current.notice = window.setTimeout(() => setNotice(null), forMs);
        }
    }, []);

    // ---------------------------------------------------------------- the workspace, via the dashboard window

    useTauriEvent<OrbState>('orb-state', setOrb);
    useEffect(() => {
        void emitTo('main', 'orb-hello', {}).catch(() => undefined);
        void shortcutsGet().then((s) => s && setKeys({talk: prettyKeys(s.talk.keys), panel: prettyKeys(s.panel.keys)})).catch(() => undefined);
    }, []);

    // A clock for "Sent" folding away.
    useEffect(() => {
        if (!task) {
            return undefined;
        }
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, [task]);

    // ---------------------------------------------------------------- listening
    //
    // Each listen gets its own id, so a late event from an earlier one (or a
    // cancelled one) never touches this one. Letting go before the microphone
    // has started still sends.

    const session = useRef('');
    const starting = useRef(false);
    const micOn = useRef(false); // the helper is listening for this session
    const stopWanted = useRef(false); // let go (or Esc) before it started

    const startListening = useCallback(async (started: How): Promise<boolean> => {
        if (phaseRef.current === 'listening' || starting.current) {
            return false;
        }
        starting.current = true;
        const owner = `orb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        session.current = owner;
        micOn.current = false;
        stopWanted.current = false;
        cancelled.current = false;
        howRef.current = started;
        setHow(started);
        heardRef.current = '';
        setHeard('');
        setLevels([]);
        setPick(null);
        setMenu(false);
        showNotice(null);
        setAnswer(null);
        setPhase('listening');
        void frontApp().then((app) => {
            setFront(app);
            if (!app && modeRef.current === 'type') {
                setModeState('chat');
            }
        });
        try {
            await speakStop();
            try {
                await voiceStart(getVoiceLang(), owner);
            } catch (e) {
                // A listen left running (say, by a crash): stop it and try once more.
                if (!/already listening/i.test(String(e))) {
                    throw e;
                }
                await voiceCancel();
                await voiceStart(getVoiceLang(), owner);
            }
            micOn.current = true;
            if (cancelled.current) {
                void voiceCancel();
            } else if (stopWanted.current) {
                void voiceStop();
            }
            return true;
        } catch (e) {
            await voiceCancel();
            setPhase('idle');
            showNotice({text: typeof e === 'string' ? e : 'Voice isn\'t available.', tone: 'error'}, 6000);
            return false;
        } finally {
            starting.current = false;
        }
    }, [showNotice]);

    const finishListening = useCallback(() => {
        if (micOn.current) {
            void voiceStop();
        } else {
            stopWanted.current = true;
        }
    }, []);

    const cancelListening = useCallback(() => {
        cancelled.current = true;
        session.current = '';
        if (micOn.current) {
            void voiceCancel();
        }
        micOn.current = false;
        setPhase('idle');
    }, []);

    const sendToChat = useCallback(async (text: string) => {
        const route = pickRef.current ?? routeFor(text, dirRef.current);
        const id = crypto.randomUUID();
        const where = route.channel ? route.channel.name : route.dmWith?.name ?? 'Captain';
        setTask({id, where, lead: route.dmWith?.name ?? (route.agents.length === 1 ? route.agents[0].name : 'Captain'), team: route.agents.length > 1 ? route.agents.map((a) => a.handle) : [], steps: [], channelId: null, rootId: null, sentAt: Date.now()});
        setPhase('working');
        try {
            await emitTo('main', 'talk-ask', {id, text, target: targetFor(route)});
        } catch {
            setTask(null);
            setPhase('idle');
            showNotice({text: 'Open Captain first: the dashboard sends what you say.', tone: 'error'}, 6000);
        }
    }, [showNotice]);

    const typeIt = useCallback(async (text: string) => {
        // The app you're in now (you may have clicked into another one since you started).
        const app = (await frontApp()) ?? frontRef.current;
        if (!app) {
            await sendToChat(text);
            return;
        }
        try {
            await typeInto(app.pid, dictated(text));
            setPhase('done');
            showNotice({text: `Typed into ${app.name}`, tone: 'info'}, 2200);
            window.clearTimeout(timers.current.done);
            timers.current.done = window.setTimeout(() => setPhase((p) => (p === 'done' ? 'idle' : p)), 1400);
        } catch (e) {
            setPhase('idle');
            const message = typeof e === 'string' ? e : (e as Error)?.message ?? 'Couldn\'t type it.';
            const needsAccess = /accessibility/i.test(message);
            showNotice({
                text: message,
                tone: 'error',
                action: needsAccess ? {label: 'Open Accessibility settings', run: () => void openExternal(ACCESSIBILITY_SETTINGS)} : undefined,
            });
        }
    }, [sendToChat, showNotice]);

    // What the microphone hears (this session only).
    useTauriEvent<VoiceEvent>('voice', (e) => {
        if (!session.current || e.owner !== session.current) {
            return;
        }
        if (e.type === 'level') {
            setLevel(e.value);
            setLevels((l) => [...l.slice(-23), e.value]);
        } else if (e.type === 'partial' || e.type === 'final') {
            heardRef.current = e.text.trim();
            setHeard(e.text);
        } else if (e.type === 'error') {
            session.current = '';
            micOn.current = false;
            setPhase('idle');
            showNotice({text: e.message, tone: 'error'}, 8000);
        } else if (e.type === 'end') {
            session.current = '';
            micOn.current = false;
            setLevel(0);
            if (phaseRef.current !== 'listening' || cancelled.current) {
                setPhase((p) => (p === 'listening' ? 'idle' : p));
                return;
            }
            const text = heardRef.current;
            if (!text) {
                setPhase('idle');
                showNotice({text: 'I didn\'t catch that.', tone: 'info'}, 2500);
            } else if (modeRef.current === 'type' && !pickRef.current?.reply) {
                void typeIt(text);
            } else {
                void sendToChat(text);
            }
        }
    });

    // ---------------------------------------------------------------- what came back

    const sayAnswer = useCallback(async (text: string) => {
        setPhase('speaking');
        await speak(spoken(text), languageOf(text)).catch(() => undefined);
        if (phaseRef.current === 'speaking') {
            setPhase('idle');
        }
    }, []);

    // Requests waiting on your decision: their answer still comes, later.
    const followUps = useRef(new Set<string>());

    const landAnswer = useCallback((r: Extract<TalkReply, {type: 'answer'}>, where: string) => {
        setAnswer({by: r.by, agentId: r.agentId, text: r.text, where, channelId: r.channelId, rootId: r.rootId, postId: r.postId});
        window.clearTimeout(timers.current.answer);
        timers.current.answer = window.setTimeout(() => setAnswer(null), ANSWER_CARD_MS + Math.min(40_000, r.text.length * 60));
        if (phaseRef.current === 'listening') {
            return; // you're talking: it waits on the card
        }
        setPhase('done');
        window.clearTimeout(timers.current.done);
        timers.current.done = window.setTimeout(() => {
            if (phaseRef.current !== 'done') {
                return;
            }
            if (mutedRef.current || !r.text) {
                setPhase('idle');
            } else {
                void sayAnswer(r.text);
            }
        }, 1300);
    }, [sayAnswer]);

    useTauriEvent<TalkReply>('talk-reply', (r) => {
        const t = taskRef.current;
        const mine = Boolean(t && r.id === t.id);
        const later = followUps.current.has(r.id);
        if (!mine && !later) {
            return;
        }
        const update = (patch: Partial<Task>) => setTask((cur) => (cur && cur.id === r.id ? {...cur, ...patch} : cur));
        if (r.type === 'sent') {
            update({where: r.where, lead: r.lead, team: r.team, channelId: r.channelId, rootId: r.rootId});
        } else if (r.type === 'progress') {
            update({steps: r.steps});
        } else if (r.type === 'replied') {
            setTask(null);
            setPhase('done');
            showNotice({text: `Replied in ${r.where}`, tone: 'info'}, 2500);
            window.clearTimeout(timers.current.done);
            timers.current.done = window.setTimeout(() => setPhase((p) => (p === 'done' ? 'idle' : p)), 1400);
        } else if (r.type === 'answer') {
            followUps.current.delete(r.id);
            if (mine) {
                setTask(null);
            }
            landAnswer(r, t && mine ? t.where : r.channelId);
        } else if (r.type === 'decision') {
            if (mine) {
                setTask(null);
                setPhase((p) => (p === 'working' ? 'idle' : p));
            }
            followUps.current.add(r.id);
            // A hand-over ("Your turn: sign in to Gmail") reads as itself.
            const yourTurn = /^your turn:/i.test(r.text);
            showNotice({text: yourTurn ? r.text : `Needs your OK: ${r.text}`, tone: 'info', action: {label: yourTurn ? 'Open' : 'Decide', run: () => void showPanel({mode: 'thread', channelId: r.channelId, postId: r.postId})}});
        } else if (r.type === 'error') {
            followUps.current.delete(r.id);
            if (mine) {
                setTask(null);
                setPhase((p) => (p === 'working' ? 'idle' : p));
            }
            showNotice({text: r.text, tone: 'error', action: r.channelId ? {label: 'Open', run: () => void showPanel({mode: 'thread', channelId: r.channelId!})} : undefined}, 9000);
        }
    });

    // Nothing back from the dashboard at all: say so rather than spin.
    useEffect(() => {
        if (!task || task.channelId) {
            return undefined;
        }
        const t = window.setTimeout(() => {
            if (taskRef.current?.id === task.id && !taskRef.current.channelId) {
                setTask(null);
                setPhase((p) => (p === 'working' ? 'idle' : p));
                showNotice({text: 'Captain didn\'t pick that up. Is the dashboard signed in? Open Captain and try again.', tone: 'error'}, 9000);
            }
        }, 25_000);
        return () => window.clearTimeout(t);
    }, [task, showNotice]);

    // An agent working on this Mac: show each step; Esc or Stop ends it.
    useTauriEvent<DriveActivity>('device-activity', (a) => {
        if (a.phase === 'working') {
            // Keep the last picture until a new one comes (not every step has one).
            setDrive((prev) => ({...a, thumb: a.thumb ?? (prev && prev.where === a.where && prev.runId === a.runId ? prev.thumb : undefined)}));
            return;
        }
        setDrive(null);
        const where = a.where === 'chrome' ? 'in Chrome' : 'on this Mac';
        if (a.phase === 'stopped') {
            showNotice({text: a.text === 'Done' ? `Done ${where}.` : `Stopped working ${where}.`, tone: 'info'}, 2500);
        } else if (a.phase === 'error') {
            showNotice({text: a.text, tone: 'error'}, 8000);
        }
    });

    // "Reply by voice" on the card at the top right.
    useTauriEvent<ReplyByVoice>('orb-reply', (r) => {
        const target: Route = {channel: {id: r.channelId, name: r.where}, agents: [], dmWith: null, reply: {rootId: r.rootId}};
        setModeState('chat');
        if (phaseRef.current === 'listening') {
            setPick(target);
            return;
        }
        void startListening('handsfree').then((ok) => ok && setPick(target));
    });

    // The microphone on the card at the top right: talk hands-free.
    useTauriEvent('orb-talk', () => {
        if (phaseRef.current !== 'listening') {
            void startListening('handsfree');
        }
    });

    // ---------------------------------------------------------------- keys

    // The talk shortcut: hold to talk, or tap to start and tap again to send.
    const keyDownAt = useRef(0);
    useTauriEvent<boolean>('talk-key', (pressed) => {
        if (pressed) {
            keyDownAt.current = Date.now();
            if (phaseRef.current === 'listening') {
                finishListening();
                keyDownAt.current = 0;
            } else {
                void startListening('key');
            }
        } else if (keyDownAt.current) {
            const held = Date.now() - keyDownAt.current > 350;
            keyDownAt.current = 0;
            if (held) {
                finishListening();
            } else {
                howRef.current = 'handsfree';
                setHow('handsfree');
            }
        }
    });

    // Esc cancels listening or stops speaking, in any app (while it matters).
    useEffect(() => {
        void orbEscape(phase === 'listening' || phase === 'speaking');
    }, [phase]);
    useEffect(() => () => void orbEscape(false), []);
    const onEscape = () => {
        if (phaseRef.current === 'listening') {
            cancelListening();
        } else if (phaseRef.current === 'speaking') {
            void speakStop();
            setPhase('idle');
        }
    };
    useTauriEvent('orb-escape', onEscape);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onEscape();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // Right-click options.
    useTauriEvent<string>('orb-menu', (id) => {
        if (id === 'orb-mute') {
            setMuted((m) => {
                writePref('captain.orb.muted', m ? '0' : '1');
                return !m;
            });
        } else if (id === 'orb-lang') {
            setLang((l) => {
                const next: VoiceLang = l === 'zh-CN' ? 'en-US' : 'zh-CN';
                setVoiceLang(next);
                showNotice({text: next === 'zh-CN' ? '我会听中文' : 'Listening in English', tone: 'info'}, 2000);
                return next;
            });
        }
    });

    // ---------------------------------------------------------------- the window
    //
    // The window grows and shrinks with the cards, around a fixed corner: the
    // bottom right (or bottom left, on the left edge) stays where the Captain
    // is. One resize at a time; the latest size wins.

    const selfMoveUntil = useRef(0);
    const wrap = useRef<HTMLDivElement>(null);
    const anchor = useRef<{x: number; bottom: number} | null>(null); // physical px: the corner's x, and the bottom
    const sideRef = useRef(side);
    sideRef.current = side;
    const fitting = useRef(false);
    const fitAgain = useRef(false);

    const readAnchor = useCallback(async () => {
        const win = getCurrentWindow();
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        anchor.current = {x: sideRef.current === 'right' ? pos.x + size.width : pos.x, bottom: pos.y + size.height};
    }, []);

    const fit = useCallback(async () => {
        const el = wrap.current;
        if (!el || !isTauri) {
            return;
        }
        if (fitting.current) {
            fitAgain.current = true;
            return;
        }
        fitting.current = true;
        try {
            do {
                fitAgain.current = false;
                if (!anchor.current) {
                    await readAnchor();
                }
                const win = getCurrentWindow();
                const scale = await win.scaleFactor();
                const r = el.getBoundingClientRect();
                const w = Math.ceil(r.width * scale);
                const h = Math.ceil(r.height * scale);
                const a = anchor.current!;
                const x = sideRef.current === 'right' ? a.x - w : a.x;
                selfMoveUntil.current = Date.now() + 800;
                await win.setSize(new PhysicalSize(w, h));
                await win.setPosition(new PhysicalPosition(x, a.bottom - h));
            } while (fitAgain.current);
        } finally {
            fitting.current = false;
        }
    }, [readAnchor]);

    useLayoutEffect(() => {
        const el = wrap.current;
        if (!el || !isTauri) {
            return undefined;
        }
        const ro = new ResizeObserver(() => void fit());
        ro.observe(el);
        void fit();
        return () => ro.disconnect();
    }, [fit, side]);

    // After a drag: settle on the nearest side edge, on screen, and remember
    // where the Captain sits.
    const settle = useCallback(async () => {
        if (!isTauri) {
            return;
        }
        const win = getCurrentWindow();
        const mon = await currentMonitor();
        if (!mon) {
            return;
        }
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        const margin = Math.round(4 * mon.scaleFactor);
        const left = mon.position.x;
        const right = mon.position.x + mon.size.width;
        const toLeft = pos.x + size.width / 2 < left + mon.size.width / 2;
        const x = toLeft ? left + margin : right - size.width - margin;
        const top = mon.position.y + Math.round(30 * mon.scaleFactor);
        const y = Math.min(Math.max(pos.y, top), mon.position.y + mon.size.height - size.height);
        if (x !== pos.x || y !== pos.y) {
            selfMoveUntil.current = Date.now() + 800;
            await win.setPosition(new PhysicalPosition(x, y));
        }
        sideRef.current = toLeft ? 'left' : 'right';
        setSide(sideRef.current);
        anchor.current = {x: toLeft ? x : x + size.width, bottom: y + size.height};
        // Saved as where the window sits at its smallest (what it opens at).
        const scale = mon.scaleFactor;
        const baseW = Math.round(BASE_W * scale);
        const baseH = Math.round(BASE_H * scale);
        void invoke('orb_moved', {x: toLeft ? x : x + size.width - baseW, y: y + size.height - baseH}).catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!isTauri) {
            return undefined;
        }
        void settle();
        let timer: number | undefined;
        let un: (() => void) | undefined;
        let gone = false;
        void getCurrentWindow().onMoved(() => {
            if (Date.now() < selfMoveUntil.current) {
                return;
            }
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void settle(), 450);
        }).then((u) => {
            if (gone) {
                u();
            } else {
                un = u;
            }
        });
        return () => {
            gone = true;
            window.clearTimeout(timer);
            un?.();
        };
    }, [settle]);

    // ---------------------------------------------------------------- the Captain: hold, click, double-click, drag

    const press = useRef<{x: number; y: number; timer: number; dragging: boolean; started: boolean} | null>(null);
    const lastClick = useRef(0);

    const openCard = () => void showPanel({mode: 'inbox'});

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) {
            return;
        }
        const p = {x: e.screenX, y: e.screenY, timer: 0, dragging: false, started: false};
        // Keep getting this press's events while the window grows around it.
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // fine without
        }
        if (phaseRef.current !== 'listening') {
            p.timer = window.setTimeout(() => {
                p.started = true;
                window.clearTimeout(timers.current.single);
                void startListening('hold');
            }, HOLD_MS);
        }
        press.current = p;
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const p = press.current;
        if (!p || p.dragging || p.started || !(e.buttons & 1)) {
            return;
        }
        if (Math.hypot(e.screenX - p.x, e.screenY - p.y) > 5) {
            window.clearTimeout(p.timer);
            p.dragging = true;
            try {
                e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
                // not captured
            }
            if (isTauri) {
                void getCurrentWindow().startDragging();
            }
        }
    };

    const onPointerUp = () => {
        const p = press.current;
        press.current = null;
        if (!p || p.dragging) {
            return;
        }
        window.clearTimeout(p.timer);
        if (p.started) {
            finishListening(); // let go: send
            return;
        }
        // A click.
        if (phaseRef.current === 'listening') {
            finishListening(); // hands-free: click again to send
            return;
        }
        if (phaseRef.current === 'speaking') {
            void speakStop();
            setPhase('idle');
            return;
        }
        const at = Date.now();
        if (at - lastClick.current < DOUBLE_MS) {
            lastClick.current = 0;
            window.clearTimeout(timers.current.single);
            void startListening('handsfree');
            return;
        }
        lastClick.current = at;
        window.clearTimeout(timers.current.single);
        timers.current.single = window.setTimeout(openCard, DOUBLE_MS);
    };

    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if (isTauri) {
            void invoke('orb_menu', {muted, lang});
        }
    };

    // Hovering: the hint at rest, or what's being worked on.
    const onEnter = () => {
        window.clearTimeout(timers.current.hover);
        timers.current.hover = window.setTimeout(() => setHover(true), 380);
    };
    const onLeave = () => {
        window.clearTimeout(timers.current.hover);
        timers.current.hover = window.setTimeout(() => setHover(false), 250);
    };

    // ---------------------------------------------------------------- what shows

    const live = useMemo(() => pick ?? routeFor(heard, orb.directory), [pick, heard, orb.directory]);
    const agentById = (id: string | null | undefined): DirectoryAgent | undefined => orb.directory.agents.find((a) => a.id === id);
    const agentByName = (name: string): DirectoryAgent | undefined => orb.directory.agents.find((a) => a.name === name);
    const captain = orb.directory.agents.find((a) => a.isCoordinator);

    const mascot: MascotState = phase === 'listening' ? 'listening' : phase === 'speaking' ? 'speaking' : phase === 'done' ? 'done' : task || drive ? 'working' : orb.needsYou > 0 ? 'needs' : 'idle';
    const sentFresh = task ? now - task.sentAt < SENT_CARD_MS : false;
    const card: 'talk' | 'notice' | 'answer' | 'drive' | 'sent' | 'hint' | null =
        phase === 'listening' ? 'talk' :
            notice ? 'notice' :
                answer ? 'answer' :
                    drive ? 'drive' :
                        task && (sentFresh || hover) ? 'sent' :
                            hover && phase === 'idle' ? 'hint' : null;
    // While it works, the agents on it peek out beside the Captain.
    const teamFaces = (task && card !== 'sent' ? (task.team.length ? task.team.map((h) => orb.directory.agents.find((a) => a.handle === h)) : [agentByName(task.lead)]) : []).
        filter((a): a is DirectoryAgent => Boolean(a && !a.isCoordinator)).slice(0, 3);
    const label = phase === 'listening' ? 'Captain is listening. Let go to send.' : drive ? (drive.where === 'chrome' ? `Captain is working in ${drive.site ?? 'Chrome'}, in a background tab: ${drive.text}.` : `Captain is working on this Mac: ${drive.text}. Press Esc to stop.`) : task ? 'Captain is working. Hover to see how it\'s going.' : `Captain: hold to talk, click to open.${orb.needsYou ? ` ${orb.needsYou} need you.` : ''}`;
    const sendWord = mode === 'type' ? 'type it' : 'send';
    const sendHint = how === 'hold' ? `Let go to ${sendWord}` : how === 'key' ? `Let go to ${sendWord}` : `Click again to ${sendWord}`;

    return (
        <div className='fc-stage'>
            <div ref={wrap} className={`fc-wrap ${side === 'left' ? 'fc-left' : ''}`} onPointerEnter={onEnter} onPointerLeave={onLeave}>
                {card === 'hint' && (
                    <div className='fc-pill'>
                        <span>Hold to talk</span>
                        <span className='fc-kbd'>{keys.talk}</span>
                        <span className='fc-dot' aria-hidden/>
                        <span>Click to open</span>
                        <span className='fc-kbd'>{keys.panel}</span>
                        {orb.needsYou > 0 && <><span className='fc-dot' aria-hidden/><span>{orb.needsYou} need{orb.needsYou === 1 ? 's' : ''} you</span></>}
                    </div>
                )}

                {card === 'talk' && (
                    <div className='fc-card' style={{width: 520}}>
                        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}}>
                            <div className='fc-seg' role='group' aria-label='Where it goes'>
                                <button type='button' aria-pressed={mode === 'chat'} onPointerDown={(e) => e.stopPropagation()} onClick={() => setMode('chat')}>To a chat</button>
                                <button type='button' aria-pressed={mode === 'type'} disabled={!front} onPointerDown={(e) => e.stopPropagation()} onClick={() => setMode('type')}>
                                    {front ? `Type into ${front.name}` : 'Type into an app'}
                                </button>
                            </div>
                            <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, color: '#4f5c78'}}>
                                <span className='fc-live' aria-hidden/>
                                <span>Listening</span>
                                <span className='fc-kbd'>{lang === 'zh-CN' ? '中文' : 'EN'}</span>
                            </div>
                        </div>
                        {mode === 'chat' ? (
                            <div style={{display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 13.5, fontWeight: 700}}>
                                {pick?.reply ? (
                                    <>
                                        <span style={{color: '#4f5c78'}}>Reply in</span>
                                        <span className='fc-chip'>{pick.channel?.name}</span>
                                    </>
                                ) : <>
                                <span style={{color: '#4f5c78'}}>To</span>
                                <button type='button' className='fc-chip' onPointerDown={(e) => e.stopPropagation()} onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
                                    {live.channel ? (
                                        <><Hash size={14} color='#3a6fd8' strokeWidth={2.4}/>{live.channel.name}</>
                                    ) : (
                                        <><img src={portraitSrc(live.dmWith?.portrait ?? captain?.portrait, live.dmWith?.handle ?? 'captain')} alt=''/>{live.dmWith?.name ?? 'Captain'}</>
                                    )}
                                    <ChevronDown size={14} color='#4f5c78'/>
                                </button>
                                {live.agents.length > 0 && (live.channel || live.agents.length > 1) && (
                                    <>
                                        <span style={{color: '#4f5c78'}}>with</span>
                                        {live.agents.map((a) => (
                                            <span key={a.id} className='fc-chip'><img src={portraitSrc(a.portrait, a.handle)} alt=''/>{a.name}</span>
                                        ))}
                                    </>
                                )}
                                <span style={{fontSize: 12.5, fontWeight: 600, color: '#5d6a85'}}>
                                    {pick ? 'your pick' : live.channel || live.agents.length ? 'picked from what you said' : 'name a chat or an agent to send it there'}
                                </span>
                                </>}
                            </div>
                        ) : (
                            <div style={{display: 'flex', alignItems: 'flex-start', gap: 12}}>
                                <span className='fc-icon-tile'><TextCursorInput size={18}/></span>
                                <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
                                    <span style={{fontSize: 15.5, fontWeight: 800}}>Typing where your cursor is</span>
                                    <span style={{fontSize: 13, lineHeight: '19px', fontWeight: 600, color: '#4f5c78'}}>
                                        When you let go, Captain types it into {front?.name ?? 'the app in front'}. Say &ldquo;new line&rdquo; for a new line, or &ldquo;scratch that&rdquo; to drop the last sentence.
                                    </span>
                                </div>
                            </div>
                        )}
                        {menu && mode === 'chat' && (
                            <div role='listbox' aria-label='Send to' style={{display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, borderRadius: 14, background: 'rgba(20, 39, 105, 0.04)'}}>
                                <button type='button' className='fc-chip' onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                                    setPick({channel: null, agents: live.agents, dmWith: captain ?? null});
                                    setMenu(false);
                                }}>
                                    <img src={portraitSrc(captain?.portrait, 'captain')} alt=''/>Captain
                                </button>
                                {orb.directory.channels.slice(0, 10).map((c) => (
                                    <button key={c.id} type='button' className='fc-chip' onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                                        setPick({channel: c, agents: live.agents, dmWith: null});
                                        setMenu(false);
                                    }}>
                                        <Hash size={14} color='#3a6fd8' strokeWidth={2.4}/>{c.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className='fc-said'>
                            {heard ? heard : <span className='fc-soft'>{lang === 'zh-CN' ? '请说…' : 'Say what you need…'}</span>}
                            <span className='fc-caret' aria-hidden/>
                        </p>
                        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16}}>
                            <div className='fc-bars' aria-hidden>
                                {Array.from({length: 24}, (_, i) => {
                                    const v = levels[levels.length - 24 + i] ?? 0;
                                    const fade = i > 20 ? 0.35 + (23 - i) * 0.2 : 1;
                                    return <span key={i} style={{height: 4 + v * 22, opacity: levels.length ? fade : 0.3}}/>;
                                })}
                            </div>
                            <div style={{display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap'}} className='fc-muted-text'>
                                <span>{sendHint}</span>
                                <span className='fc-dot' aria-hidden/>
                                <span className='fc-kbd'>esc</span>
                                <span>to cancel</span>
                            </div>
                        </div>
                    </div>
                )}

                {card === 'sent' && task && <SentCard task={task} directory={orb.directory}/>}

                {card === 'answer' && answer && (
                    <div className='fc-card' style={{width: 380}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                            <img src={portraitSrc(agentById(answer.agentId)?.portrait, agentById(answer.agentId)?.handle ?? 'captain')} alt='' style={{width: 30, height: 30, borderRadius: 9999, background: '#fff', boxShadow: '0 0 0 1px rgba(20,39,105,0.08)'}}/>
                            <div style={{display: 'flex', flexDirection: 'column', minWidth: 0}}>
                                <span style={{fontSize: 14, fontWeight: 800}}>{answer.by}</span>
                                <span style={{fontSize: 12, fontWeight: 600, color: '#4f5c78'}}>{orb.directory.channels.some((c) => c.id === answer.channelId) ? `in ${orb.directory.channels.find((c) => c.id === answer.channelId)!.name}` : 'in your direct message'}</span>
                            </div>
                            <button type='button' className='fc-x' aria-label='Dismiss' onPointerDown={(e) => e.stopPropagation()} onClick={() => setAnswer(null)}><X size={15}/></button>
                        </div>
                        <p className='fc-answer'>{answer.text}</p>
                        <div style={{display: 'flex', gap: 8}}>
                            <button type='button' className='fc-btn fc-btn-primary' onPointerDown={(e) => e.stopPropagation()} onClick={() => void showPanel({mode: 'thread', channelId: answer.channelId, postId: answer.rootId ?? answer.postId})}>Open</button>
                            {phase === 'speaking' ? (
                                <button type='button' className='fc-btn fc-btn-ghost' onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                                    void speakStop();
                                    setPhase('idle');
                                }}>Stop reading</button>
                            ) : (
                                <button type='button' className='fc-btn fc-btn-ghost' onPointerDown={(e) => e.stopPropagation()} onClick={() => void sayAnswer(answer.text)}>Read it to me</button>
                            )}
                        </div>
                    </div>
                )}

                {card === 'drive' && drive && (
                    <div className='fc-card fc-drive' style={{width: 360, gap: 8}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                            <span className='fc-icon-tile' style={{width: 30, height: 30}}>{drive.where === 'chrome' ? <Globe size={16}/> : <MousePointerClick size={16}/>}</span>
                            <div style={{display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1}}>
                                <span style={{fontSize: 14.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{drive.where === 'chrome' ? `Working in ${drive.site ?? 'Chrome'}` : 'Working on this Mac'}</span>
                                <span style={{fontSize: 12.5, fontWeight: 600, color: '#4f5c78', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{drive.text}</span>
                            </div>
                            {drive.where === 'chrome' && drive.deviceId && (
                                <button type='button' className='fc-btn fc-btn-ghost' onPointerDown={(e) => e.stopPropagation()} onClick={() => void emitTo('main', 'orb-show-device', {deviceId: drive.deviceId})}>Show me</button>
                            )}
                            <button type='button' className='fc-btn fc-btn-ghost' onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                                void emitTo('main', 'orb-stop-drive', {});
                                setDrive(null);
                            }}>Stop</button>
                        </div>
                        {drive.thumb && (
                            <div className='fc-drive-view' aria-label={`What Captain sees in ${drive.site ?? 'the tab'}`}>
                                <img src={drive.thumb} alt='' draggable={false}/>
                            </div>
                        )}
                        <div className='fc-foot'>
                            {drive.where === 'chrome' ?
                                <>In Captain&apos;s own tab, in the background: keep using your browser. Anything it sends waits for your OK.</> :
                                <>Hands off the mouse and keyboard while it works. <span className='fc-kbd'>Esc</span> stops it any time.</>}
                        </div>
                    </div>
                )}

                {card === 'notice' && notice && (
                    <div className='fc-card' style={{width: 340, gap: 10}}>
                        <div style={{display: 'flex', alignItems: 'flex-start', gap: 10}}>
                            {notice.tone === 'info' && phase === 'done' && <span className='fc-check' style={{width: 24, height: 24}}><Check size={14} strokeWidth={3}/></span>}
                            <span className={notice.tone === 'error' ? 'fc-error' : ''} style={{fontSize: 13.5, lineHeight: '19px', fontWeight: 700, flex: 1}}>{notice.text}</span>
                            <button type='button' className='fc-x' aria-label='Dismiss' onPointerDown={(e) => e.stopPropagation()} onClick={() => showNotice(null)}><X size={15}/></button>
                        </div>
                        {notice.action && (
                            <div>
                                <button type='button' className='fc-btn fc-btn-primary' onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                                    notice.action!.run();
                                    showNotice(null);
                                }}>{notice.action.label}</button>
                            </div>
                        )}
                    </div>
                )}

                <button
                    type='button'
                    aria-label={label}
                    title={label}
                    className='fc-captain'
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onContextMenu={onContextMenu}
                >
                    <span className='fc-body'><Mascot state={mascot} level={level}/></span>
                    {teamFaces.map((a, i) => (
                        <img key={a.id} className='fc-team' src={portraitSrc(a.portrait, a.handle)} alt='' style={side === 'right' ? {left: -8 + i * 4, top: 8 + i * 30} : {right: -8 + i * 4, top: 8 + i * 30}}/>
                    ))}
                    {orb.needsYou > 0 && phase !== 'listening' && <span className='fc-badge'>{orb.needsYou > 9 ? '9+' : orb.needsYou}</span>}
                    {muted && <span className='fc-muted' title='Spoken answers are off'><VolumeX size={12}/></span>}
                </button>
            </div>
        </div>
    );
}

const STEP_STATUS: Record<string, {label: string; color: string}> = {
    succeeded: {label: 'Done', color: '#2a56b8'},
    running: {label: 'Working', color: '#4f5c78'},
    waiting_approval: {label: 'Needs your OK', color: '#9a6a1f'},
    failed: {label: 'Didn\'t finish', color: '#b02a45'},
    pending: {label: 'Up next', color: '#7d89a3'},
    skipped: {label: 'Skipped', color: '#7d89a3'},
    cancelled: {label: 'Stopped', color: '#7d89a3'},
};

function SentCard({task, directory}: {task: Task; directory: OrbDirectory}) {
    const agent = (id: string) => directory.agents.find((a) => a.id === id);
    const done = task.steps.filter((s) => s.status === 'succeeded').length;
    const lead = directory.agents.find((a) => a.name === task.lead);
    const subtitle = task.team.length > 1 ?
        `Captain is coordinating ${joinNames(task.team.map((h) => `@${h}`))}` :
        task.lead === 'Captain' ? (task.steps.length > 1 ? `Captain split it into ${task.steps.length} steps` : task.steps.length ? 'Captain is on it' : 'Captain is working out who helps') : `${task.lead} is on it`;
    return (
        <div className='fc-card' style={{width: 420}}>
            <div style={{display: 'flex', alignItems: 'flex-start', gap: 12}}>
                <span className='fc-check'><Check size={16} strokeWidth={2.6}/></span>
                <div style={{display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0}}>
                    <span style={{fontSize: 15.5, fontWeight: 800}}>Sent to {task.where}</span>
                    <span style={{fontSize: 13, fontWeight: 600, color: '#4f5c78'}}>{subtitle}</span>
                </div>
            </div>
            {task.steps.length > 0 && <div className='fc-progress'><div style={{width: `${Math.max(6, (done / task.steps.length) * 100)}%`}}/></div>}
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {task.steps.length > 0 ? task.steps.slice(0, 5).map((s, i) => {
                    const a = agent(s.agentId);
                    const st = STEP_STATUS[s.status] ?? STEP_STATUS.pending;
                    return (
                        <div key={i} className='fc-step'>
                            <img src={portraitSrc(a?.portrait, a?.handle)} alt={a?.name ?? ''}/>
                            <span className='fc-step-title'>{s.title}</span>
                            <span style={{display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: st.color}}>
                                {s.status === 'succeeded' && <Check size={14} strokeWidth={2.6}/>}
                                {st.label}
                                {s.status === 'running' && <span className='fc-typing' aria-hidden><span/><span style={{animationDelay: '0.2s'}}/><span style={{animationDelay: '0.4s'}}/></span>}
                            </span>
                        </div>
                    );
                }) : (
                    <div className='fc-step'>
                        <img src={portraitSrc(lead?.portrait, lead?.handle ?? 'captain')} alt=''/>
                        <span className='fc-step-title'>{task.lead === 'Captain' && task.team.length > 1 ? 'Planning who does what' : `${task.lead} is writing`}</span>
                        <span className='fc-typing' aria-hidden><span/><span style={{animationDelay: '0.2s'}}/><span style={{animationDelay: '0.4s'}}/></span>
                    </div>
                )}
            </div>
            <div className='fc-foot'>Keep working. Captain taps you when it&apos;s ready.</div>
        </div>
    );
}
