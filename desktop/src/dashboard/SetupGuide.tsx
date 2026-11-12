// "Get started": everything Captain needs on this Mac, one step at a time,
// each with a way to check it works. Shown after the first sign-in and
// reachable any time from the menu bar icon, Settings → This Mac and Home.

import {BellRing, Check, ChevronDown, Cpu, ExternalLink, Keyboard, MessagesSquare, Mic, MonitorUp, Puzzle, Server, UserRound, Users} from 'lucide-react';
import {type ReactNode, useEffect, useRef, useState} from 'react';

import {ghostBtn, Modal, primaryBtn} from '../components/Modal';
import {ShortcutRow} from '../components/ShortcutRow';
import {getServerUrl} from '../lib/api';
import {getVoiceLang} from '../lib/dictation';
import {
    captureScreen, isTauri, LOCAL_SERVER, localServerStatus, type LocalServerStatus, notify, onVoice, openExternal, RELEASE_PAGE, revealChromeExtension,
    setTalkButtonVisible, shortcutsGet, type ShortcutStatus, speak, talkButtonVisible, voiceCancel, voiceStart, voiceStop,
} from '../lib/native';
import {markSetupSeen} from '../lib/setup';
import {useShortcutLabels} from '../lib/shortcuts';
import {useStore} from '../lib/store';


const DONE_KEY = 'captain.setup.done';

function loadDone(): Record<string, boolean> {
    try {
        return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}') as Record<string, boolean>;
    } catch {
        return {};
    }
}

type StepId = 'server' | 'account' | 'model' | 'shortcuts' | 'voice' | 'notifications' | 'screen' | 'extension' | 'rooms';

export function SetupGuide({onClose, onModels, onInvite}: {onClose: () => void; onModels: () => void; onInvite: () => void}) {
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const demoMode = useStore((s) => s.demoMode);
    const [done, setDone] = useState<Record<string, boolean>>(loadDone);
    const [server, setServer] = useState<LocalServerStatus | null>(null);
    const [keys, setKeys] = useState<{panel: ShortcutStatus; talk: ShortcutStatus} | null>(null);

    useEffect(() => {
        markSetupSeen();
        void localServerStatus().then(setServer);
        void shortcutsGet().then(setKeys);
    }, []);

    const mark = (id: StepId, value = true) => setDone((d) => {
        const next = {...d, [id]: value};
        try {
            localStorage.setItem(DONE_KEY, JSON.stringify(next));
        } catch {
            // fine
        }
        return next;
    });

    // Wait for the shortcut check, so the first unfinished step is the one that opens.
    const loaded = !isTauri || keys !== null;
    const serverUrl = getServerUrl();
    const onThisMac = serverUrl.replace(/\/$/, '') === LOCAL_SERVER;
    const status: Record<StepId, boolean> = {
        server: true, // you're signed in, so a server answered
        account: true,
        model: !demoMode,
        shortcuts: Boolean(keys?.panel.ok && keys.talk.ok),
        voice: Boolean(done.voice),
        notifications: Boolean(done.notifications),
        screen: Boolean(done.screen),
        extension: Boolean(done.extension),
        rooms: Boolean(done.rooms),
    };
    const steps: StepId[] = isTauri ?
        ['server', 'account', 'model', 'shortcuts', 'voice', 'notifications', 'screen', 'extension', 'rooms'] :
        ['server', 'account', 'model', 'extension', 'rooms'];
    const firstOpen = steps.find((id) => !status[id]) ?? null;
    const count = steps.filter((id) => status[id]).length;

    return (
        <Modal title='Get started with Captain' onClose={onClose} width={620}>
            <p className='text-[13px] text-muted'>
                {count === steps.length ? 'All set. Open this again any time from the menu bar icon (Get started…) or Settings → This Mac.' : `${count} of ${steps.length} done. Each step has a quick test so you know it works.`}
            </p>
            <div className='mt-2 h-1 overflow-hidden rounded-full bg-tint'>
                <div className='h-full rounded-full bg-accent transition-all duration-500' style={{width: `${(count / steps.length) * 100}%`}}/>
            </div>
            {loaded && <ol className='mt-4 space-y-2'>
                {steps.includes('server') && (
                    <Step id='server' n={steps.indexOf('server') + 1} done={status.server} open={firstOpen === 'server'} icon={<Server size={16}/>} title='Where Captain runs'
                        summary={onThisMac ? 'On this Mac' : serverUrl.replace(/^https?:\/\//, '')}>
                        <p>
                            {onThisMac ?
                                'Captain is running on this Mac, using your Supabase database. It starts with the app and stops when you quit. Nothing else needs to be open.' :
                                `You're connected to the Captain server at ${serverUrl}. Anyone you invite signs in to the same address.`}
                        </p>
                        {onThisMac && server && (
                            <p className='mt-1.5 flex items-center gap-2'>
                                <span className={`size-2 rounded-full ${server.running ? 'bg-emerald-500' : 'bg-amber-500'}`}/>
                                {server.running ? `Running at ${server.url.replace('http://', '')}` : server.error ?? 'Starting…'}
                            </p>
                        )}
                        <p className='mt-1.5 text-muted'>To use a server in the cloud instead (Render), sign out and pick &ldquo;A Captain server&rdquo; on the sign-in screen. docs/DEPLOY.md in the repo has the Render steps.</p>
                    </Step>
                )}
                <Step id='account' n={steps.indexOf('account') + 1} done open={false} icon={<UserRound size={16}/>} title='Your account' summary={me ? `${me.displayName} · ${workspace?.name ?? ''}` : ''}>
                    <p>You&apos;re signed in as {me?.email}{workspace ? ` in ${workspace.name}` : ''}. Sign-up is invite-only: people join with a link you make.</p>
                    {workspace?.role !== 'guest' && (
                        <div className='mt-2'><button type='button' className={ghostBtn} onClick={onInvite}><Users size={14}/> Invite people</button></div>
                    )}
                </Step>
                <Step id='model' n={steps.indexOf('model') + 1} done={status.model} open={firstOpen === 'model'} icon={<Cpu size={16}/>} title='A model key' summary={demoMode ? 'Agents are giving sample answers' : 'Agents answer for real'}>
                    {demoMode ? (
                        me?.instanceAdmin ?
                            <p>Paste an OpenRouter key (or another provider&apos;s) in Settings → Models &amp; spend. Every agent starts answering for real.</p> :
                            <p>Whoever runs this server adds the key. Until then, agents give sample answers.</p>
                    ) : (
                        <p>A key is set. Each workspace has a monthly budget ($20 unless an admin changes it), and Settings → Models &amp; spend shows what&apos;s been spent and any recent model errors.</p>
                    )}
                    <p className='mt-1.5 text-muted'>OpenRouter needs credit on the account. If agents say they&apos;re out of credit, top up at openrouter.ai/settings/credits.</p>
                    {me?.instanceAdmin && (
                        <div className='mt-2'><button type='button' className={demoMode ? primaryBtn : ghostBtn} onClick={onModels}>{demoMode ? 'Add a key' : 'Models & spend'}</button></div>
                    )}
                </Step>
                {steps.includes('shortcuts') && (
                    <Step id='shortcuts' n={steps.indexOf('shortcuts') + 1} done={status.shortcuts} open={firstOpen === 'shortcuts'} icon={<Keyboard size={16}/>} title='Keyboard shortcuts'
                        summary={keys ? `${keys.panel.ok ? 'Panel works' : 'Panel shortcut refused'} · ${keys.talk.ok ? 'talk works' : 'talk shortcut refused'}` : ''}>
                        <p className='mb-2'>Both work in any app. Press one now to try it. If another app (Lock In, Raycast, Alfred…) already uses the keys, click Change and press new ones: they need ⌘ or ⌃.</p>
                        {keys && (
                            <div className='space-y-2'>
                                <ShortcutRow kind='panel' label='Write to a chat' hint='Opens the panel from the menu bar' status={keys.panel} onChange={(st) => setKeys({...keys, panel: st})}/>
                                <ShortcutRow kind='talk' label='Talk to Captain' hint='Hold while you talk, or tap, talk, and tap again' status={keys.talk} onChange={(st) => setKeys({...keys, talk: st})}/>
                            </div>
                        )}
                    </Step>
                )}
                {steps.includes('voice') && (
                    <Step id='voice' n={steps.indexOf('voice') + 1} done={status.voice} open={firstOpen === 'voice'} icon={<Mic size={16}/>} title='Microphone and speech' summary={status.voice ? 'Captain can hear you' : 'Needs a quick test'}>
                        <VoiceTest onWorked={() => mark('voice')}/>
                        <TalkButtonToggle/>
                    </Step>
                )}
                {steps.includes('notifications') && (
                    <Step id='notifications' n={steps.indexOf('notifications') + 1} done={status.notifications} open={firstOpen === 'notifications'} icon={<BellRing size={16}/>} title='Banners' summary={status.notifications ? 'On' : 'For approvals and replies'}>
                        <p>When an agent needs your OK, or someone replies to you, Captain shows a banner. Send a test one:</p>
                        <div className='mt-2 flex flex-wrap items-center gap-2'>
                            <button type='button' className={ghostBtn} onClick={() => void notify('Captain', 'Banners work. Approvals will show up like this.', {mode: 'inbox'})}>Send a test banner</button>
                            <button type='button' className={status.notifications ? ghostBtn : primaryBtn} onClick={() => mark('notifications')}><Check size={14}/> I saw it</button>
                        </div>
                        <p className='mt-1.5 text-muted'>No banner? System Settings → Notifications → Captain → Allow notifications.</p>
                    </Step>
                )}
                {steps.includes('screen') && (
                    <Step id='screen' n={steps.indexOf('screen') + 1} done={status.screen} open={firstOpen === 'screen'} icon={<MonitorUp size={16}/>} title='Screen snapshots' summary={status.screen ? 'On' : 'So agents can see your screen'}>
                        <ScreenTest onWorked={() => mark('screen')}/>
                    </Step>
                )}
                <Step id='extension' n={steps.indexOf('extension') + 1} done={status.extension} open={firstOpen === 'extension'} icon={<Puzzle size={16}/>} title='The Chrome extension' summary={status.extension ? 'Added' : 'Send pages to Captain, chat in the side panel'}>
                    <ExtensionSteps onDone={() => mark('extension')} onThisMac={onThisMac} serverUrl={serverUrl}/>
                </Step>
                <Step id='rooms' n={steps.indexOf('rooms') + 1} done={status.rooms} open={firstOpen === 'rooms'} icon={<MessagesSquare size={16}/>} title='How agents work in a chat' summary='One agent, or a team Captain coordinates'>
                    <RoomRules/>
                    <div className='mt-2'><button type='button' className={status.rooms ? ghostBtn : primaryBtn} onClick={() => mark('rooms')}><Check size={14}/> Got it</button></div>
                </Step>
            </ol>}
            <div className='mt-4 flex items-center gap-2'>
                <button type='button' className='inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent-text hover:underline' onClick={() => void openExternal(RELEASE_PAGE)}>
                    Downloads <ExternalLink size={12}/>
                </button>
                <button type='button' className={`${primaryBtn} ml-auto`} onClick={onClose}>Done</button>
            </div>
        </Modal>
    );
}

// How a chat with several agents works. Also used on Home.
export function RoomRules() {
    return (
        <ul className='space-y-1.5'>
            <li><b className='text-ink'>Mention one agent</b> (&ldquo;@researcher find …&rdquo;): that agent answers in the thread.</li>
            <li><b className='text-ink'>Mention two or more</b> (&ldquo;@researcher @writer …&rdquo;): Captain coordinates. It splits the work between just the agents you named, each does its part (one can build on another&apos;s), and Captain posts one combined answer. The plan card shows who&apos;s doing what, live.</li>
            <li><b className='text-ink'>Mention @captain</b> or write in a direct message with Captain: Captain decides who on the team should help. Name agents in that message and Captain works with just them.</li>
            <li><b className='text-ink'>Reply in the thread</b> to keep going with the same agent or team.</li>
            <li>Anything that leaves the workspace (an email, a post) waits for a yes from you or an admin.</li>
        </ul>
    );
}

function Step({id, n, done, open, icon, title, summary, children}: {id: StepId; n: number; done: boolean; open: boolean; icon: ReactNode; title: string; summary: string; children: ReactNode}) {
    const [expanded, setExpanded] = useState(open);
    return (
        <li id={`setup-${id}`} className={`rounded-2xl ring-1 ${expanded ? 'bg-surface ring-line' : 'bg-bg-subtle/60 ring-line/70'}`}>
            <button type='button' className='flex w-full items-center gap-3 px-3.5 py-3 text-left' onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
                {done ? (
                    <span className='grid size-7 shrink-0 place-items-center rounded-full bg-accent text-on-accent'><Check size={14} strokeWidth={3}/></span>
                ) : (
                    <span className='grid size-7 shrink-0 place-items-center rounded-full bg-tint text-[12.5px] font-extrabold text-accent-text'>{n}</span>
                )}
                <span className='grid size-7 shrink-0 place-items-center rounded-lg text-muted'>{icon}</span>
                <span className='min-w-0 flex-1'>
                    <span className='block text-[13.5px] font-bold text-ink'>{title}</span>
                    {summary && <span className='block truncate text-[12px] text-muted'>{summary}</span>}
                </span>
                <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}/>
            </button>
            {expanded && <div className='px-3.5 pb-3.5 pl-[86px] text-[12.5px] leading-relaxed text-text'>{children}</div>}
        </li>
    );
}

// Listen for a few seconds, then say back what it heard: proves the mic,
// speech recognition and spoken answers all work (and asks for permission).
function VoiceTest({onWorked}: {onWorked: () => void}) {
    const [phase, setPhase] = useState<'idle' | 'listening' | 'speaking' | 'worked' | 'failed'>('idle');
    const [heard, setHeard] = useState('');
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    const heardRef = useRef('');
    const listening = useRef(false);
    const worked = useRef(onWorked);
    worked.current = onWorked;
    const keys = useShortcutLabels();

    useEffect(() => onVoice('setup', (e) => {
        if (e.type === 'partial' || e.type === 'final') {
            heardRef.current = e.text;
            setHeard(e.text);
        } else if (e.type === 'error') {
            setError(e.message);
            setPhase('failed');
        } else if (e.type === 'end') {
            listening.current = false;
            if (timer.current) {
                window.clearTimeout(timer.current);
            }
            const text = heardRef.current.trim();
            if (!text) {
                setPhase((p) => (p === 'failed' ? p : 'failed'));
                setError((err) => err ?? 'Captain didn\'t hear anything. Check the microphone, then try again.');
                return;
            }
            setPhase('speaking');
            void speak(`I heard: ${text}`, getVoiceLang()).finally(() => {
                setPhase('worked');
                worked.current();
            });
        }
    }), []);

    // Closing the guide mid-test turns the microphone off.
    useEffect(() => () => {
        if (timer.current) {
            window.clearTimeout(timer.current);
        }
        if (listening.current) {
            void voiceCancel();
        }
    }, []);

    const start = () => {
        setError(null);
        setHeard('');
        heardRef.current = '';
        setPhase('listening');
        listening.current = true;
        voiceStart(getVoiceLang(), 'setup').then(() => {
            timer.current = window.setTimeout(() => void voiceStop(), 5000);
        }).catch((e) => {
            listening.current = false;
            setError(String((e as Error)?.message ?? e));
            setPhase('failed');
        });
    };

    return (
        <div>
            <p>Click Test, then say something like &ldquo;Hi Captain&rdquo;. The first time, macOS asks to let Captain use the microphone and speech recognition: allow both. Captain then says back what it heard.</p>
            <p className='mt-1.5 text-muted'>Typing into other apps by voice (&ldquo;Type into Notes&rdquo; on the talk card) also needs Accessibility: macOS asks the first time you use it.</p>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
                <button type='button' className={phase === 'worked' ? ghostBtn : primaryBtn} disabled={phase === 'listening' || phase === 'speaking'} onClick={start}>
                    <Mic size={14}/> {phase === 'listening' ? 'Listening…' : phase === 'speaking' ? 'Speaking…' : phase === 'worked' ? 'Test again' : 'Test'}
                </button>
                {heard && <span className='min-w-0 truncate italic text-muted'>&ldquo;{heard}&rdquo;</span>}
            </div>
            {phase === 'worked' && <p className='mt-1.5 font-semibold text-accent-text'>Works. Hold {keys.talk}, or hold the little Captain on your screen, to talk.</p>}
            {error && (
                <p className='mt-1.5 text-alert'>
                    {error} If you said no to a permission, turn Captain on in System Settings → Privacy &amp; Security → Microphone, and → Speech Recognition.
                </p>
            )}
        </div>
    );
}

function TalkButtonToggle() {
    const [visible, setVisible] = useState<boolean | null>(null);
    useEffect(() => {
        void talkButtonVisible().then(setVisible);
    }, []);
    return (
        <label className='mt-3 flex items-center gap-2.5'>
            <input
                type='checkbox'
                className='size-4 accent-[var(--accent)]'
                checked={!!visible}
                disabled={visible === null}
                onChange={(e) => {
                    setVisible(e.target.checked);
                    void setTalkButtonVisible(e.target.checked);
                }}
            />
            Show the little Captain on your screen (hold it to talk, click it for what needs you, drag it to an edge)
        </label>
    );
}

// Take a snapshot and show it: other apps' windows in it means screen
// recording is allowed.
function ScreenTest({onWorked}: {onWorked: () => void}) {
    const [shot, setShot] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => () => {
        if (shot) {
            URL.revokeObjectURL(shot);
        }
    }, [shot]);
    return (
        <div>
            <p>The camera button in any message box snaps your screen so agents can see what you see. The first time, macOS asks for Screen Recording: allow it, then quit and reopen Captain.</p>
            <div className='mt-2'>
                <button type='button' className={shot ? ghostBtn : primaryBtn} disabled={busy} onClick={() => {
                    setBusy(true);
                    setError(null);
                    void captureScreen(false).then((blob) => {
                        if (blob) {
                            setShot(URL.createObjectURL(blob));
                        }
                    }).catch((e) => setError(String((e as Error)?.message ?? e))).finally(() => setBusy(false));
                }}>
                    <MonitorUp size={14}/> {busy ? 'Taking it…' : shot ? 'Try again' : 'Take a test snapshot'}
                </button>
            </div>
            {shot && (
                <div className='mt-2'>
                    <img src={shot} alt='Your test snapshot' className='max-h-40 rounded-xl ring-1 ring-line'/>
                    <p className='mt-1.5'>See your other apps&apos; windows in it? Then it works. Only the wallpaper and Captain? Turn Captain on in System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording, then quit and reopen Captain.</p>
                    <div className='mt-2'><button type='button' className={primaryBtn} onClick={onWorked}><Check size={14}/> It shows my screen</button></div>
                </div>
            )}
            {error && <p className='mt-1.5 text-alert'>{error}</p>}
        </div>
    );
}

function ExtensionSteps({onDone, onThisMac, serverUrl}: {onDone: () => void; onThisMac: boolean; serverUrl: string}) {
    const [folder, setFolder] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    return (
        <div>
            <ol className='list-decimal space-y-1 pl-4'>
                {isTauri ? (
                    <li>
                        <button type='button' className={ghostBtn} onClick={() => void revealChromeExtension().then(setFolder).catch((e) => setError(String((e as Error)?.message ?? e)))}>
                            Show the extension in Finder
                        </button>
                        {folder && <span className='mt-1 block text-muted'>It&apos;s the &ldquo;Chrome extension&rdquo; folder Finder just showed.</span>}
                        {error && <span className='mt-1 block text-alert'>{error}</span>}
                    </li>
                ) : (
                    <li>
                        Download <b>cutecaptain-Chrome-extension.zip</b> from the{' '}
                        <button type='button' className='font-semibold text-accent-text hover:underline' onClick={() => void openExternal(RELEASE_PAGE)}>release page</button> and unzip it.
                    </li>
                )}
                <li>In Chrome, go to <b>chrome://extensions</b> and turn on <b>Developer mode</b> (top right).</li>
                <li>Click <b>Load unpacked</b> and choose that folder. (In the file picker, drag the folder in from Finder to jump straight to it.)</li>
                <li>Pin Captain from Chrome&apos;s puzzle-piece menu, click it, and sign in with the same email. Server: {onThisMac ? <b>This Mac</b> : <b>{serverUrl}</b>}.</li>
            </ol>
            <p className='mt-1.5 text-muted'>Then: right-click any page to send it to Captain, or open the side panel to chat while you browse. Agents read a page only when you click &ldquo;Let agents read it&rdquo;.</p>
            <div className='mt-2'><button type='button' className={primaryBtn} onClick={onDone}><Check size={14}/> It&apos;s in Chrome</button></div>
        </div>
    );
}
