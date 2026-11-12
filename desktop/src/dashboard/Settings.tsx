// Workspace settings: your profile, people and invites, agents, models and spend.

import {AlertTriangle, Bot, Check, ChevronDown, Copy, Cpu, ExternalLink, KeyRound, Laptop, Plug, Plus, Users, UserRound} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';

import {Avatar, PORTRAITS, portraitSrc} from '../components/Avatar';
import {FieldLabel, ghostBtn, input, Modal, primaryBtn} from '../components/Modal';
import {ShortcutRow} from '../components/ShortcutRow';
import {api, errorMessage} from '../lib/api';
import {permissions as deskPermissions, type Permissions, testScreenshot} from '../lib/computer';
import {deviceEnabled, onDevices, refreshDevices, setDeviceEnabled, thisDeviceId} from '../lib/device';
import {ACCESSIBILITY_SETTINGS, isTauri, localServerRestart, openExternal, localServerStatus, type LocalServerStatus, SCREEN_RECORDING_SETTINGS, setTalkButtonVisible, shortcutsGet, type ShortcutStatus, talkButtonVisible} from '../lib/native';
import {openSetup} from '../lib/setup';
import {displayName, modelLabel, useStore} from '../lib/store';
import type {Agent, AgentTool, ConnectionApp, Connections, Device, McpConnections, McpServerInfo, ModelInfo, ProviderCheck, ProviderKeyInfo, Tier, UsageSummary, WorkspaceMember, WorkspaceRole} from '../lib/types';

type Tab = 'profile' | 'people' | 'agents' | 'connections' | 'models' | 'mac';

export function Settings({onClose, initial = 'people'}: {onClose: () => void; initial?: Tab}) {
    const ws = useStore((s) => s.workspace)!;
    const admin = ws.role === 'owner' || ws.role === 'admin';
    const [tab, setTab] = useState<Tab>(initial);
    const tabs: [Tab, string, React.ReactNode][] = [
        ['people', 'People', <Users key='p' size={15}/>],
        ['agents', 'Agents', <Bot key='a' size={15}/>],
        ['connections', 'Connections', <Plug key='c' size={15}/>],
        ['models', 'Models & spend', <Cpu key='m' size={15}/>],
        ['profile', 'Your profile', <UserRound key='u' size={15}/>],
        ...(isTauri ? [['mac', 'This Mac', <Laptop key='l' size={15}/>] as [Tab, string, React.ReactNode]] : []),
    ];
    return (
        <Modal title={`${ws.name} settings`} onClose={onClose} width={760}>
            <div className='flex gap-5'>
                <nav className='w-40 shrink-0 space-y-0.5'>
                    {tabs.map(([id, label, icon]) => (
                        <button key={id} type='button' onClick={() => setTab(id)} className={`flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[13px] font-semibold ${tab === id ? 'bg-tint text-ink' : 'text-muted hover:bg-bg-subtle hover:text-ink'}`}>
                            {icon}{label}
                        </button>
                    ))}
                </nav>
                <div className='min-h-[440px] min-w-0 flex-1'>
                    {tab === 'people' && <People admin={admin}/>}
                    {tab === 'agents' && <Agents admin={admin}/>}
                    {tab === 'connections' && <ConnectionsTab/>}
                    {tab === 'models' && <Models admin={admin}/>}
                    {tab === 'profile' && <Profile/>}
                    {tab === 'mac' && <ThisMacSettings/>}
                </div>
            </div>
        </Modal>
    );
}

// ------------------------------------------------------------ people

function People({admin}: {admin: boolean}) {
    const ws = useStore((s) => s.workspace)!;
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me)!;
    const [members, setMembers] = useState<WorkspaceMember[]>([]);
    const [role, setRole] = useState<WorkspaceRole>('member');
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState(ws.name);
    const [resetFor, setResetFor] = useState<{userId: string; url: string} | null>(null);

    const load = () => api.members(ws.id).then((r) => {
        setMembers(r.members);
        useStore.setState((s) => ({users: {...s.users, ...Object.fromEntries(r.users.map((u) => [u.id, u]))}}));
    }).catch((e) => setError(errorMessage(e)));
    useEffect(() => {
        void load();
    }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const makeLink = async () => {
        setError(null);
        try {
            const r = await api.createInvite(ws.id, {role, expiresInDays: 14});
            setLink(r.url);
            setCopied(false);
        } catch (e) {
            setError(errorMessage(e));
        }
    };
    const people = members.filter((m) => !users[m.userId]?.isBot);

    return (
        <div className='space-y-5'>
            {admin && (
                <section>
                    <h3 className='mb-2 text-[13px] font-extrabold text-ink'>Workspace</h3>
                    <div className='flex gap-2'>
                        <input className={input} value={name} onChange={(e) => setName(e.target.value)}/>
                        <button
                            type='button'
                            className={ghostBtn}
                            disabled={name.trim() === ws.name || !name.trim()}
                            onClick={() => api.updateWorkspace(ws.id, {name}).then((w) => useStore.setState((s) => ({workspace: w, workspaces: s.workspaces.map((x) => (x.id === w.id ? w : x))}))).catch((e) => setError(errorMessage(e)))}
                        >Rename</button>
                    </div>
                </section>
            )}
            {ws.role !== 'guest' && (
                <section>
                    <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Invite people</h3>
                    <p className='mb-2 text-[12.5px] text-muted'>Anyone with the link can join for 14 days. Guests only see group chats they're added to.</p>
                    <div className='flex gap-2'>
                        <select className={`${input} w-36`} value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
                            <option value='member'>Member</option>
                            <option value='guest'>Guest</option>
                            {admin && <option value='admin'>Admin</option>}
                        </select>
                        <button type='button' className={primaryBtn} onClick={() => void makeLink()}>Create invite link</button>
                    </div>
                    {link && (
                        <div className='mt-2 flex items-center gap-2 rounded-xl bg-tint px-3 py-2'>
                            <code className='min-w-0 flex-1 truncate text-[12px] text-ink'>{link}</code>
                            <button type='button' className='inline-flex items-center gap-1 text-[12px] font-bold text-accent-text' onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
                                {copied ? <><Check size={13}/> Copied</> : <><Copy size={13}/> Copy</>}
                            </button>
                        </div>
                    )}
                </section>
            )}
            <section>
                <h3 className='mb-2 text-[13px] font-extrabold text-ink'>People · {people.length}</h3>
                <div className='divide-y divide-line rounded-2xl ring-1 ring-line'>
                    {people.map((m) => {
                        const u = users[m.userId];
                        return (
                            <div key={m.userId} className='flex items-center gap-3 px-3 py-2'>
                                <Avatar user={u} size={30}/>
                                <span className='min-w-0 flex-1'>
                                    <span className='block truncate text-[13.5px] font-bold text-ink'>{displayName(u)}{m.userId === me.id ? ' (you)' : ''}</span>
                                    <span className='block truncate text-[12px] text-muted'>{u?.email ?? `@${u?.username ?? ''}`}</span>
                                </span>
                                {admin && m.userId !== me.id ? (
                                    <select
                                        className='h-8 rounded-lg bg-bg-subtle px-2 text-[12.5px] ring-1 ring-line'
                                        value={m.role}
                                        onChange={(e) => api.setRole(ws.id, m.userId, e.target.value as WorkspaceRole).then(load).catch((err) => setError(errorMessage(err)))}
                                    >
                                        {(['owner', 'admin', 'member', 'guest'] as const).map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                                    </select>
                                ) : (
                                    <span className='text-[12px] font-semibold text-muted capitalize'>{m.role}</span>
                                )}
                                {admin && m.userId !== me.id && (ws.role === 'owner' || (m.role !== 'owner' && m.role !== 'admin')) && (
                                    <button
                                        type='button'
                                        title='Make a one-time link to set a new password'
                                        className='text-[12px] font-semibold text-muted hover:text-ink'
                                        onClick={() => api.resetLink(ws.id, m.userId).then((r) => setResetFor({userId: m.userId, url: r.url})).catch((err) => setError(errorMessage(err)))}
                                    >Reset password</button>
                                )}
                                {admin && m.userId !== me.id && (
                                    <button
                                        type='button'
                                        className='text-[12px] font-semibold text-muted hover:text-alert'
                                        onClick={() => confirm(`Remove ${displayName(u)} from the workspace?`) && api.removeMember(ws.id, m.userId).then(load).catch((err) => setError(errorMessage(err)))}
                                    >Remove</button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>
            {resetFor && (
                <div className='rounded-2xl bg-tint px-3 py-2.5'>
                    <p className='text-[12.5px] text-ink'>Send this to {displayName(users[resetFor.userId])} privately. It works once, for 24 hours, and signs them out of other devices.</p>
                    <div className='mt-1.5 flex items-center gap-2'>
                        <code className='min-w-0 flex-1 truncate text-[12px] text-ink'>{resetFor.url}</code>
                        <button type='button' className='inline-flex items-center gap-1 text-[12px] font-bold text-accent-text' onClick={() => void navigator.clipboard.writeText(resetFor.url)}><Copy size={13}/> Copy</button>
                    </div>
                </div>
            )}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}

// ------------------------------------------------------------ agents

const TIERS: (Tier | 'auto')[] = ['auto', 'easy', 'balanced', 'hard'];
const TIER_HINT: Record<string, string> = {auto: 'The router decides per request', easy: 'Fast and cheap', balanced: 'Most work', hard: 'Deep reasoning, at a higher price'};

function Agents({admin}: {admin: boolean}) {
    const agents = useStore((s) => s.agents);
    const [editing, setEditing] = useState<Agent | 'new' | null>(null);
    const [tools, setTools] = useState<AgentTool[]>([]);
    const ws = useStore((s) => s.workspace)!;
    useEffect(() => {
        api.agents(ws.id).then((r) => setTools(r.tools)).catch(() => undefined);
    }, [ws.id]);
    const list = Object.values(agents).sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));

    if (editing) {
        return <AgentForm agent={editing === 'new' ? null : editing} tools={tools} onDone={() => setEditing(null)}/>;
    }
    return (
        <div>
            <div className='mb-3 flex items-center'>
                <p className='flex-1 text-[12.5px] text-muted'>Mention an agent with @ in any chat, or message it directly. @captain plans bigger work across the team.</p>
                {admin && <button type='button' className={primaryBtn} onClick={() => setEditing('new')}><Plus size={14}/> New agent</button>}
            </div>
            <div className='space-y-2'>
                {list.map((a) => (
                    <button key={a.id} type='button' disabled={!admin} onClick={() => setEditing(a)} className={`flex w-full items-start gap-3 rounded-2xl p-3 text-left ring-1 ring-line ${admin ? 'hover:bg-bg-subtle' : ''} ${a.enabled ? '' : 'opacity-60'}`}>
                        <img src={portraitSrc(a.portrait, a.handle)} alt='' className='size-10 rounded-xl bg-white ring-1 ring-line'/>
                        <span className='min-w-0 flex-1'>
                            <span className='flex items-baseline gap-2'>
                                <span className='text-[14px] font-bold text-ink'>{a.name}</span>
                                <span className='text-[12px] text-muted'>@{a.handle}</span>
                                {!a.enabled && <span className='text-[11px] font-semibold text-muted'>off</span>}
                            </span>
                            <span className='block text-[12.5px] text-text'>{a.description}</span>
                            <span className='mt-1 block text-[11.5px] text-muted'>{a.model ? `Pinned to ${a.model}` : `Tier: ${a.tier}`} · {a.tools.length} tools</span>
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function AgentForm({agent, tools, onDone}: {agent: Agent | null; tools: AgentTool[]; onDone: () => void}) {
    const ws = useStore((s) => s.workspace)!;
    const models = useStore((s) => s.models);
    const refreshAgents = useStore((s) => s.refreshAgents);
    const [handle, setHandle] = useState(agent?.handle ?? '');
    const [name, setName] = useState(agent?.name ?? '');
    const [description, setDescription] = useState(agent?.description ?? '');
    const [instructions, setInstructions] = useState(agent?.instructions ?? '');
    const [tier, setTier] = useState<Tier | 'auto'>(agent?.tier ?? 'auto');
    const [model, setModel] = useState<string>(agent?.model ?? '');
    const [picked, setPicked] = useState<string[]>(agent?.tools ?? ['search_workspace', 'read_url', 'create_document']);
    const [portrait, setPortrait] = useState(agent?.portrait ?? 'fox');
    const [enabled, setEnabled] = useState(agent?.enabled ?? true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const body = {name, description, instructions, tier, model: model || null, tools: picked, portrait, enabled};
            if (agent) {
                await api.updateAgent(agent.id, body);
            } else {
                await api.createAgent(ws.id, {...body, handle});
            }
            await refreshAgents();
            onDone();
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className='space-y-3'>
            <div className='flex items-center gap-2'>
                <button type='button' className='text-[12.5px] font-semibold text-muted hover:text-ink' onClick={onDone}>← Agents</button>
                <span className='text-[14px] font-extrabold text-ink'>{agent ? agent.name : 'New agent'}</span>
            </div>
            <div className='flex gap-1.5'>
                {(agent?.isCoordinator ? ['captain'] : PORTRAITS).map((p) => (
                    <button key={p} type='button' onClick={() => setPortrait(p)} className={`rounded-xl p-0.5 ring-2 ${portrait === p ? 'ring-accent' : 'ring-transparent'}`}>
                        <img src={portraitSrc(p)} alt={p} className='size-10 rounded-[10px] bg-white'/>
                    </button>
                ))}
            </div>
            <div className='grid grid-cols-2 gap-2'>
                <FieldLabel text='Name'><input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Support'/></FieldLabel>
                <FieldLabel text='Handle'><input className={input} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} disabled={Boolean(agent)} placeholder='support'/></FieldLabel>
            </div>
            <FieldLabel text='One-line description' hint='Captain uses this to decide who does what.'>
                <input className={input} value={description} onChange={(e) => setDescription(e.target.value)}/>
            </FieldLabel>
            <FieldLabel text='Instructions'>
                <textarea className={`${input} h-28 py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder='You answer customer questions kindly and briefly…'/>
            </FieldLabel>
            <div className='grid grid-cols-2 gap-2'>
                <FieldLabel text='Difficulty tier' hint={TIER_HINT[tier]}>
                    <select className={input} value={tier} onChange={(e) => setTier(e.target.value as Tier | 'auto')}>
                        {TIERS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                    </select>
                </FieldLabel>
                <FieldLabel text='Model' hint='Pinning skips the router’s choice; it still falls back if the model fails.'>
                    <select className={input} value={model} onChange={(e) => setModel(e.target.value)}>
                        <option value=''>Let the router choose</option>
                        {models.map((m) => <option key={m.id} value={m.id} disabled={!m.configured}>{m.label}{m.configured ? '' : ' (no key)'}</option>)}
                    </select>
                </FieldLabel>
            </div>
            <div>
                <span className='mb-1 block text-[12px] font-bold text-muted'>Tools</span>
                <div className='grid grid-cols-2 gap-1.5'>
                    {tools.map((t) => (
                        <label key={t.name} className={`flex items-start gap-2 rounded-xl p-2 ring-1 ring-line ${t.available ? '' : 'opacity-50'}`} title={t.description}>
                            <input type='checkbox' className='mt-0.5 accent-[var(--accent)]' checked={picked.includes(t.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.name] : p.filter((x) => x !== t.name)))}/>
                            <span className='min-w-0'>
                                <span className='block text-[12.5px] font-bold text-ink'>{t.name.replace(/_/g, ' ')}{t.external ? ' · asks first' : ''}</span>
                                <span className='line-clamp-2 block text-[11px] text-muted'>{t.available ? t.description : 'Needs a key on the server'}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </div>
            {agent && !agent.isCoordinator && (
                <label className='flex items-center gap-2 text-[13px] text-text'>
                    <input type='checkbox' className='accent-[var(--accent)]' checked={enabled} onChange={(e) => setEnabled(e.target.checked)}/> Agent is on
                </label>
            )}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
            <div className='flex justify-end gap-2'>
                <button type='button' className={ghostBtn} onClick={onDone}>Cancel</button>
                <button type='submit' className={primaryBtn} disabled={busy || !name.trim() || !instructions.trim() || (!agent && !handle.trim())}>{busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}</button>
            </div>
        </form>
    );
}

// ------------------------------------------------------------ models and spend

function Models({admin}: {admin: boolean}) {
    const ws = useStore((s) => s.workspace)!;
    const agents = useStore((s) => s.agents);
    const runsServer = !!useStore((s) => s.me)?.instanceAdmin;
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [demo, setDemo] = useState(false);
    const [usage, setUsage] = useState<UsageSummary | null>(null);
    const [budget, setBudget] = useState(ws.monthlyBudgetUsd === null ? '' : String(ws.monthlyBudgetUsd));
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Also refreshes the app's copy, so chats leave demo mode once a key is saved.
    const loadModels = () => api.models(ws.id).then((r) => {
        setModels(r.models);
        setDemo(r.demoMode);
        useStore.setState({models: r.models, demoMode: r.demoMode});
    }).catch((e) => setError(errorMessage(e)));

    useEffect(() => {
        void loadModels();
        if (admin) {
            api.usage(ws.id).then(setUsage).catch(() => undefined);
        }
    }, [ws.id, admin]);

    const byTier = useMemo(() => (['easy', 'balanced', 'hard'] as Tier[]).map((t) => [t, models.filter((m) => m.tiers.includes(t))] as const), [models]);
    const maxUsd = Math.max(0.0001, ...(usage?.byModel.map((m) => m.usd) ?? [0]));

    const saveBudget = async () => {
        setError(null);
        try {
            const v = budget.trim() === '' ? null : Number(budget);
            const w = await api.updateWorkspace(ws.id, {monthlyBudgetUsd: v});
            useStore.setState((s) => ({workspace: w, workspaces: s.workspaces.map((x) => (x.id === w.id ? w : x))}));
            setSaved(true);
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    return (
        <div className='space-y-5'>
            {demo && !runsServer && (
                <div className='rounded-2xl bg-gold-tint px-4 py-3 text-[12.5px] text-gold-text'>
                    <span className='font-bold'>Demo mode.</span> No model key is set on this server yet, so agents give sample answers. Whoever runs the server can add one here.
                </div>
            )}
            {runsServer && <ModelKeys demo={demo} onChanged={() => void loadModels()}/>}
            {admin && usage && (
                <section>
                    <h3 className='mb-2 text-[13px] font-extrabold text-ink'>This month</h3>
                    <div className='flex items-end gap-6'>
                        <div>
                            <div className='text-[28px] font-extrabold tracking-tight text-ink'>${usage.totalUsd.toFixed(2)}</div>
                            <div className='text-[12px] text-muted'>{usage.calls} model calls{usage.budgetUsd !== null ? ` · budget $${usage.budgetUsd.toFixed(2)}` : ''}</div>
                        </div>
                        <div className='ml-auto flex items-end gap-2'>
                            <FieldLabel text='Monthly budget (USD)'>
                                <input className={`${input} w-32`} value={budget} onChange={(e) => {
                                    setBudget(e.target.value);
                                    setSaved(false);
                                }} placeholder='No limit' inputMode='decimal'/>
                            </FieldLabel>
                            <button type='button' className={ghostBtn} onClick={() => void saveBudget()}>{saved ? 'Saved' : 'Save'}</button>
                        </div>
                    </div>
                    {usage.budgetUsd !== null && (
                        <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-tint'>
                            <div className={`h-full rounded-full ${usage.totalUsd >= usage.budgetUsd ? 'bg-alert' : 'bg-accent'}`} style={{width: `${Math.min(100, (usage.totalUsd / Math.max(0.0001, usage.budgetUsd)) * 100)}%`}}/>
                        </div>
                    )}
                    {usage.byModel.length > 0 && (
                        <div className='mt-3 space-y-1.5'>
                            {usage.byModel.map((m) => (
                                <div key={m.modelId} className='grid grid-cols-[160px_1fr_auto] items-center gap-3 text-[12.5px]'>
                                    <span className='truncate font-semibold text-ink'>{modelLabel(models, m.modelId)}</span>
                                    <span className='h-2 overflow-hidden rounded-full bg-tint'><span className='block h-full rounded-full bg-accent' style={{width: `${(m.usd / maxUsd) * 100}%`}}/></span>
                                    <span className='w-28 text-right text-muted'>${m.usd.toFixed(3)} · {m.calls}×</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {usage.byAgent.length > 0 && (
                        <p className='mt-2 text-[12px] text-muted'>
                            By agent: {usage.byAgent.map((a) => `${a.agentId ? agents[a.agentId]?.name ?? 'removed agent' : 'other'} $${a.usd.toFixed(3)}`).join(' · ')}
                        </p>
                    )}
                    {(usage.recentErrors?.length ?? 0) > 0 && (
                        <details className='mt-3 rounded-xl bg-tint/60 px-3 py-2 ring-1 ring-line'>
                            <summary className='cursor-pointer text-[12.5px] font-bold text-ink'>
                                Recent model errors ({usage.recentErrors.length}) <span className='font-normal text-muted'>· past week; Captain retries and falls back, so most of these didn't reach you</span>
                            </summary>
                            <ul className='mt-2 space-y-1.5'>
                                {usage.recentErrors.map((e, i) => (
                                    <li key={`${e.at}-${i}`} className='text-[12px] leading-snug'>
                                        <span className='font-semibold text-ink'>{modelLabel(models, e.modelId)}</span>
                                        <span className='text-muted'> · {e.provider} · {e.agentId ? agents[e.agentId]?.name ?? 'agent' : e.purpose} · {new Date(e.at).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</span>
                                        <div className='break-words text-text'>{e.error}</div>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </section>
            )}
            <section>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Model routing</h3>
                <p className='mb-2 text-[12.5px] text-muted'>Each request gets a difficulty tier; the router tries that tier's models by priority, skips any that are failing, and falls back to the next. Models light up when their provider has a key on the server.</p>
                <div className='space-y-3'>
                    {byTier.map(([tier, list]) => (
                        <div key={tier}>
                            <div className='mb-1 text-[11.5px] font-bold tracking-wide text-muted uppercase'>{tier}</div>
                            <div className='flex flex-wrap gap-1.5'>
                                {list.map((m) => (
                                    <span
                                        key={m.id}
                                        title={`${m.provider} · $${m.priceInPerM}/$${m.priceOutPerM} per 1M tokens${m.lastError ? ` · last error: ${m.lastError}` : ''}`}
                                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${m.configured ? 'bg-surface text-ink ring-line' : 'bg-bg-subtle text-muted ring-transparent'}`}
                                    >
                                        <span className={`size-1.5 rounded-full ${!m.configured ? 'bg-slate-300' : m.healthy ? 'bg-emerald-500' : 'bg-amber-500'}`}/>
                                        {m.label}
                                        {m.vision && <span className='text-[10px] text-muted'>👁</span>}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}

// ------------------------------------------------------------ model keys (people who run the server)

function ModelKeys({demo, onChanged}: {demo: boolean; onChanged: () => void}) {
    const [providers, setProviders] = useState<ProviderKeyInfo[] | null>(null);
    const [more, setMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Kept here, not in each row: a row moves between lists once its key is saved.
    const [results, setResults] = useState<Record<string, ProviderCheck | null>>({});
    const row = (p: ProviderKeyInfo, open = false) => (
        <ProviderRow key={p.id} p={p} open={open} onChanged={changed} result={results[p.id] ?? null} onResult={(r) => setResults((x) => ({...x, [p.id]: r}))}/>
    );
    const load = () => api.providers().then(setProviders).catch((e) => setError(errorMessage(e)));
    useEffect(() => {
        void load();
    }, []);
    if (!providers) {
        return error ? <p className='text-[12.5px] text-alert'>{error}</p> : null;
    }
    const [main, ...rest] = providers;
    const inUse = rest.filter((p) => p.source || p.unreadable);
    const others = rest.filter((p) => !p.source && !p.unreadable);
    const changed = () => {
        void load();
        onChanged();
    };
    return (
        <section className='rounded-2xl bg-surface p-4 ring-1 ring-line' style={{boxShadow: 'var(--shadow-control)'}}>
            <div className='mb-1 flex items-center gap-2'>
                <KeyRound size={15} className='text-accent-text'/>
                <h3 className='text-[13px] font-extrabold text-ink'>Model keys</h3>
                <span className='ml-auto text-[11.5px] text-muted'>Only people who run this server see this. It applies to every workspace here.</span>
            </div>
            <p className='mb-3 text-[12.5px] text-muted'>
                {demo ? 'Agents are giving sample answers. ' : ''}One OpenRouter key turns on every model below; the router picks among them for each request. Keys are stored encrypted and never shown again.
            </p>
            <div className='space-y-2'>
                {main && row(main, true)}
                {inUse.map((p) => row(p))}
            </div>
            {others.length > 0 && (
                <div className='mt-2'>
                    <button type='button' onClick={() => setMore(!more)} className='inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink'>
                        <ChevronDown size={14} className={more ? 'rotate-180' : ''}/> {more ? 'Fewer providers' : `Other providers (${others.length}): use their keys directly, tried before OpenRouter`}
                    </button>
                    {more && <div className='mt-2 space-y-2'>{others.map((p) => row(p))}</div>}
                </div>
            )}
        </section>
    );
}

type RowProps = {p: ProviderKeyInfo; open?: boolean; onChanged: () => void; result: ProviderCheck | null; onResult: (r: ProviderCheck | null) => void};

function ProviderRow({p, open = false, onChanged, result, onResult: setResult}: RowProps) {
    const [editing, setEditing] = useState(open && !p.source);
    const [key, setKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(p.needsBaseUrl ? p.baseUrl ?? '' : '');
    const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const check = async () => {
        setBusy('check');
        setError(null);
        setResult(null);
        try {
            setResult(await api.checkProvider(p.id));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const save = async () => {
        setBusy('save');
        setError(null);
        setResult(null);
        try {
            // The server tries the key before saving it, and turns down one the provider rejects.
            const res = await api.saveProviderKey(p.id, key.trim(), p.needsBaseUrl ? baseUrl.trim() : undefined);
            setKey('');
            setEditing(false);
            setResult(res.check);
            onChanged();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const remove = async () => {
        setBusy('remove');
        setError(null);
        setResult(null);
        try {
            await api.removeProviderKey(p.id);
            onChanged();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const status = p.unreadable ?
        <span className='inline-flex items-center gap-1 text-alert'><AlertTriangle size={12}/> Saved key can't be read</span> :
        p.source === 'settings' ? <span className='inline-flex items-center gap-1.5 text-ink'><span className='size-1.5 rounded-full bg-emerald-500'/>In use · ends in {p.last4}</span> :
            p.source === 'environment' ? <span className='inline-flex items-center gap-1.5 text-ink'><span className='size-1.5 rounded-full bg-emerald-500'/>From the server's environment · ends in {p.last4}</span> :
                <span className='text-muted'>Not set</span>;

    return (
        <div className='rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]'>
                <span className='text-[13px] font-bold text-ink'>{p.label}</span>
                {p.recommended && <span className='rounded-full bg-tint px-2 py-0.5 text-[10.5px] font-bold text-accent-text'>Recommended</span>}
                <span className='text-muted'>· {p.models} {p.models === 1 ? 'model' : 'models'}</span>
                <span className='ml-auto'>{status}</span>
            </div>
            {p.unreadable && (
                <p className='mt-1 text-[12px] text-muted'>The server's APP_SECRET changed since this key was saved. Paste the key again.</p>
            )}
            {p.source === 'environment' && !editing && (
                <p className='mt-1 text-[12px] text-muted'>A key saved here takes the place of the server's own.</p>
            )}
            {editing ? (
                <form
                    className='mt-2 space-y-2'
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    {p.needsBaseUrl && (
                        <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder='Gateway address, such as https://gateway.example.com/v1' spellCheck={false}/>
                    )}
                    <div className='flex gap-2'>
                        <input
                            className={`${input} font-mono text-[12.5px]`}
                            type='password'
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            placeholder={p.id === 'openrouter' ? 'sk-or-v1-…' : `Paste your ${p.label} key`}
                            autoComplete='off'
                            spellCheck={false}
                            autoFocus={!open}
                            aria-label={`${p.label} key`}
                        />
                        <button type='submit' className={primaryBtn} disabled={!key.trim() || busy !== null}>{busy === 'save' ? 'Trying it…' : 'Save'}</button>
                        {(p.source || p.unreadable) && <button type='button' className={ghostBtn} onClick={() => setEditing(false)}>Cancel</button>}
                    </div>
                    {p.keysUrl && (
                        <a href={p.keysUrl} target='_blank' rel='noreferrer' className='inline-flex items-center gap-1 text-[12px] font-semibold text-accent-text hover:underline'>
                            Get a key from {p.label} <ExternalLink size={11}/>
                        </a>
                    )}
                </form>
            ) : (
                <div className='mt-2 flex flex-wrap gap-2'>
                    <button type='button' className={ghostBtn} onClick={() => setEditing(true)}>{p.source || p.unreadable ? 'Replace key' : 'Add key'}</button>
                    {p.source && <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void check()}>{busy === 'check' ? 'Checking…' : 'Check'}</button>}
                    {(p.source === 'settings' || p.unreadable) && <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>}
                </div>
            )}
            {busy === 'check' && !result && <p className='mt-2 text-[12px] text-muted'>Sending a tiny test request…</p>}
            {result && (
                <p className={`mt-2 inline-flex items-start gap-1.5 text-[12px] ${result.ok ? 'text-ink' : 'text-alert'}`}>
                    {result.ok ? <Check size={13} className='mt-px shrink-0 text-emerald-600'/> : <AlertTriangle size={13} className='mt-px shrink-0'/>}
                    <span>{result.message}{result.ok && result.latencyMs ? ` (${(result.latencyMs / 1000).toFixed(1)}s)` : ''}</span>
                </p>
            )}
            {error && <p className='mt-2 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}

// ------------------------------------------------------------ connections

const APP_ICONS: Record<string, string> = {gmail: '✉️', googledrive: '📁', googledocs: '📄', googlesheets: '📊', googlecalendar: '📅', googleslides: '📽️'};

// Your Google apps, connected through Composio (as in Captain on the web).
function ConnectionsTab() {
    const ws = useStore((s) => s.workspace)!;
    const [data, setData] = useState<Connections | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [waiting, setWaiting] = useState<string | null>(null); // the app whose sign-in page is open

    const load = useMemo(() => () => api.connections(ws.id).then((d) => {
        setData(d);
        return d;
    }).catch((e) => {
        setError(errorMessage(e));
        return null;
    }), [ws.id]);

    useEffect(() => {
        void load();
        // Back from the sign-in page in the browser: check again.
        const onFocus = () => void load();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [load]);

    // While a sign-in page is open, look every few seconds for up to three minutes.
    useEffect(() => {
        if (!waiting) {
            return undefined;
        }
        const until = Date.now() + 180_000;
        const timer = window.setInterval(() => {
            void load().then((d) => {
                const app = d?.apps.find((a) => a.toolkit === waiting);
                if (app?.status === 'connected' || Date.now() > until) {
                    setWaiting(null);
                }
            });
        }, 3000);
        return () => window.clearInterval(timer);
    }, [waiting, load]);

    const connect = async (a: ConnectionApp) => {
        setBusy(a.toolkit);
        setError(null);
        try {
            const {url} = await api.connectApp(ws.id, a.toolkit);
            await openExternal(url);
            setWaiting(a.toolkit);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const disconnect = async (a: ConnectionApp) => {
        setBusy(a.toolkit);
        setError(null);
        try {
            await api.disconnectApp(ws.id, a.toolkit);
            await load();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    if (!data) {
        return error ? <p className='text-[12.5px] text-alert'>{error}</p> : <p className='text-[13px] text-muted'>Loading…</p>;
    }
    return (
        <div className='space-y-6'>
            <section>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Google apps</h3>
                <p className='mb-3 text-[12.5px] text-muted'>Connect your own Google account, app by app. Agents working for you can then read your email, files and calendar without asking; sending an email or adding an event still waits for your OK. Docs, decks and sheets agents make for you also land in your Drive, in a Captain folder for each chat. Only you can use your connections, in this workspace.</p>
                {!data.configured && (
                    <p className='mb-3 rounded-xl bg-gold-tint px-3 py-2 text-[12.5px] text-gold-text'>
                        {data.canSetUp ? 'First add a Composio key below: Captain connects to Google through Composio.' : 'Connections aren\'t set up on this server yet. Ask the person who runs it to add a Composio key.'}
                    </p>
                )}
                {data.error && <p className='mb-3 text-[12.5px] text-alert'>{data.error}</p>}
                <div className='space-y-1.5'>
                    {data.apps.map((a) => (
                        <div key={a.toolkit} className='flex items-center gap-3 rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
                            <span className='grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-[16px] ring-1 ring-line' aria-hidden>{APP_ICONS[a.toolkit] ?? '🔗'}</span>
                            <span className='min-w-0 flex-1'>
                                <span className='block text-[13px] font-bold text-ink'>{a.name}</span>
                                <span className='block text-[12px] text-muted'>
                                    {a.status === 'connected' ? <span className='inline-flex items-center gap-1.5'><span className='size-1.5 rounded-full bg-emerald-500'/>Connected</span> :
                                        waiting === a.toolkit ? 'Finish signing in in your browser…' :
                                            a.status === 'pending' ? 'Sign-in not finished' :
                                                a.status === 'expired' ? <span className='text-alert'>Needs signing in again</span> : 'Not connected'}
                                </span>
                            </span>
                            {a.status === 'connected' ? (
                                <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void disconnect(a)}>{busy === a.toolkit ? 'One moment…' : 'Disconnect'}</button>
                            ) : (
                                <button type='button' className={primaryBtn} disabled={busy !== null || !data.configured} onClick={() => void connect(a)}>
                                    {busy === a.toolkit ? 'Opening…' : a.status === 'expired' || a.status === 'pending' ? 'Sign in again' : 'Connect'}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
            </section>
            <McpServers/>
            {data.canSetUp && <ComposioKey data={data} onChanged={() => void load()}/>}
        </div>
    );
}

// MCP servers: Granola, Notion and Linear in one click, or any remote MCP
// server by its address. Each person connects their own.
function McpServers() {
    const ws = useStore((s) => s.workspace)!;
    const [data, setData] = useState<McpConnections | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [waiting, setWaiting] = useState<string | null>(null); // a server whose sign-in page is open
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({name: '', url: '', token: '', authHeader: ''});
    const [open, setOpen] = useState<string | null>(null); // a server whose tools are shown

    const load = useMemo(() => () => api.mcpServers(ws.id).then((d) => {
        setData(d);
        return d;
    }).catch((e) => {
        setError(errorMessage(e));
        return null;
    }), [ws.id]);
    useEffect(() => {
        void load();
        const onFocus = () => void load();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [load]);
    useEffect(() => {
        if (!waiting) {
            return undefined;
        }
        const until = Date.now() + 180_000;
        const timer = window.setInterval(() => {
            void load().then((d) => {
                const s = d?.servers.find((x) => x.id === waiting);
                if (s?.status === 'connected' || Date.now() > until) {
                    setWaiting(null);
                }
            });
        }, 3000);
        return () => window.clearInterval(timer);
    }, [waiting, load]);

    const run = async (key: string, fn: () => Promise<void>) => {
        setBusy(key);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const add = (body: Parameters<typeof api.addMcp>[1], key: string) => run(key, async () => {
        const res = await api.addMcp(ws.id, body);
        if (res.signInUrl) {
            await openExternal(res.signInUrl);
            setWaiting(res.server.id);
        } else if (res.server.status !== 'connected') {
            setError(`${res.server.name}: ${res.server.lastError ?? 'it didn\'t answer properly.'}`);
        }
        setAdding(false);
        setForm({name: '', url: '', token: '', authHeader: ''});
        await load();
    });
    const signIn = (s: McpServerInfo) => run(s.id, async () => {
        const {url} = await api.signInMcp(ws.id, s.id);
        await openExternal(url);
        setWaiting(s.id);
    });

    if (!data) {
        return error ? <p className='text-[12.5px] text-alert'>{error}</p> : null;
    }
    const added = new Set(data.servers.map((s) => s.preset).filter(Boolean));
    const offered = data.presets.filter((p) => !added.has(p.id));
    return (
        <section>
            <h3 className='mb-1 text-[13px] font-extrabold text-ink'>MCP servers</h3>
            <p className='mb-3 text-[12.5px] text-muted'>Connect apps that speak MCP with your own account. Agents working for you can then look things up there without asking; anything that changes something waits for your OK. Only you can use them, in this workspace.</p>
            <div className='space-y-1.5'>
                {data.servers.map((s) => {
                    const reads = s.tools.filter((t) => t.reads).length;
                    const changes = s.tools.length - reads;
                    return (
                        <div key={s.id} className='rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
                            <div className='flex items-center gap-3'>
                                <span className='grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-[14px] font-extrabold text-accent-text ring-1 ring-line' aria-hidden>{s.name.slice(0, 1).toUpperCase()}</span>
                                <span className='min-w-0 flex-1'>
                                    <span className='block truncate text-[13px] font-bold text-ink'>{s.name} <span className='font-medium text-muted'>· {s.url.replace(/^https?:\/\//, '')}</span></span>
                                    <span className='block text-[12px] text-muted'>
                                        {waiting === s.id ? 'Finish signing in in your browser…' :
                                            s.status === 'connected' ? (
                                                <button type='button' onClick={() => setOpen(open === s.id ? null : s.id)} className='inline-flex items-center gap-1.5 hover:text-ink'>
                                                    <span className={`size-1.5 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-line'}`}/>
                                                    {s.enabled ? 'Connected' : 'Switched off'} · {s.tools.length} tools{changes ? ` (${changes} ask first)` : ''}
                                                </button>
                                            ) :
                                                s.status === 'needs_sign_in' ? <span className='text-gold-text'>Needs you to sign in</span> :
                                                    <span className='text-alert'>{s.lastError ?? 'Not checked yet'}</span>}
                                    </span>
                                </span>
                                {s.status === 'needs_sign_in' ? (
                                    <button type='button' className={primaryBtn} disabled={busy !== null} onClick={() => void signIn(s)}>{busy === s.id ? 'Opening…' : 'Sign in'}</button>
                                ) : s.status === 'connected' ? (
                                    <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void run(s.id, async () => {
                                        await api.setMcpEnabled(ws.id, s.id, !s.enabled);
                                        await load();
                                    })}>{s.enabled ? 'Switch off' : 'Switch on'}</button>
                                ) : (
                                    <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void run(s.id, async () => {
                                        await api.verifyMcp(ws.id, s.id);
                                        await load();
                                    })}>{busy === s.id ? 'Checking…' : 'Check again'}</button>
                                )}
                                <button type='button' className={ghostBtn} disabled={busy !== null} onClick={() => void run(s.id, async () => {
                                    await api.removeMcp(ws.id, s.id);
                                    await load();
                                })}>Remove</button>
                            </div>
                            {open === s.id && s.tools.length > 0 && (
                                <div className='mt-2 flex flex-wrap gap-1 pl-11'>
                                    {s.tools.map((t) => (
                                        <span key={t.name} title={t.reads ? 'Runs without asking' : 'Asks you first'} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${t.reads ? 'bg-tint text-accent-text' : 'bg-gold-tint text-gold-text'}`}>{t.name}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                {offered.map((p) => (
                    <div key={p.id} className='flex items-center gap-3 rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
                        <span className='grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-[14px] font-extrabold text-accent-text ring-1 ring-line' aria-hidden>{p.name.slice(0, 1)}</span>
                        <span className='min-w-0 flex-1'>
                            <span className='block text-[13px] font-bold text-ink'>{p.name}</span>
                            <span className='block text-[12px] text-muted'>{p.description}</span>
                        </span>
                        <button type='button' className={primaryBtn} disabled={busy !== null} onClick={() => void add({preset: p.id}, p.id)}>{busy === p.id ? 'Opening…' : 'Connect'}</button>
                    </div>
                ))}
            </div>
            {adding ? (
                <form className='mt-2 space-y-2 rounded-xl bg-bg-subtle p-3 ring-1 ring-line/70' onSubmit={(e) => {
                    e.preventDefault();
                    void add({url: form.url.trim(), name: form.name.trim() || undefined, token: form.token.trim() || undefined, authHeader: form.authHeader.trim() || undefined}, 'custom');
                }}>
                    <div className='grid grid-cols-[1fr_2fr] gap-2'>
                        <input className={input} value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} placeholder='Name (optional)'/>
                        <input className={input} value={form.url} onChange={(e) => setForm({...form, url: e.target.value})} placeholder='https://example.com/mcp' autoComplete='off' spellCheck={false} required/>
                    </div>
                    <div className='grid grid-cols-[2fr_1fr] gap-2'>
                        <input className={input} type='password' value={form.token} onChange={(e) => setForm({...form, token: e.target.value})} placeholder='Token, if it uses one (leave empty to sign in)' autoComplete='off'/>
                        <input className={input} value={form.authHeader} onChange={(e) => setForm({...form, authHeader: e.target.value})} placeholder='Header (optional)' autoComplete='off' spellCheck={false}/>
                    </div>
                    <p className='text-[11.5px] text-muted'>A token goes as a Bearer token unless you name another header (like X-Api-Key). Servers that use a sign-in open it in your browser.</p>
                    <div className='flex gap-2'>
                        <button type='submit' className={primaryBtn} disabled={busy !== null || !/^https?:\/\/\S+$/i.test(form.url.trim())}>{busy === 'custom' ? 'Connecting…' : 'Connect and check'}</button>
                        <button type='button' className={ghostBtn} onClick={() => setAdding(false)}>Cancel</button>
                    </div>
                </form>
            ) : (
                <button type='button' onClick={() => setAdding(true)} className='mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent-text hover:underline'><Plus size={13}/> Add a server by its address</button>
            )}
            {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
        </section>
    );
}

function ComposioKey({data, onChanged}: {data: Connections; onChanged: () => void}) {
    const [editing, setEditing] = useState(!data.configured);
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.saveConnectorKey(key.trim());
            setKey('');
            setEditing(false);
            onChanged();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.removeConnectorKey();
            setEditing(true);
            onChanged();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const source = data.key?.source;
    return (
        <section>
            <h3 className='mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-ink'><KeyRound size={14}/> Composio key</h3>
            <p className='mb-2 text-[12.5px] text-muted'>Only people who run this server see this. One key from your Composio project (composio.dev → Settings → API keys) lets everyone here connect their own Google apps. It's stored encrypted, like the model keys.</p>
            <div className='rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
                <div className='flex items-center gap-2 text-[12.5px]'>
                    {source ? <span className='inline-flex items-center gap-1.5 text-ink'><span className='size-1.5 rounded-full bg-emerald-500'/>{source === 'settings' ? 'In use' : 'From the server\'s environment'} · ends in {data.key?.last4}</span> : <span className='text-muted'>Not set</span>}
                    {!editing && (
                        <span className='ml-auto flex gap-1.5'>
                            <button type='button' className={ghostBtn} onClick={() => setEditing(true)}>Replace key</button>
                            {source === 'settings' && <button type='button' className={ghostBtn} disabled={busy} onClick={() => void remove()}>Remove</button>}
                        </span>
                    )}
                </div>
                {editing && (
                    <form className='mt-2 flex gap-2' onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}>
                        <input className={input} type='password' value={key} onChange={(e) => setKey(e.target.value)} placeholder='Composio API key' autoComplete='off' spellCheck={false}/>
                        <button type='submit' className={primaryBtn} disabled={busy || key.trim().length < 8}>{busy ? 'Checking…' : 'Save'}</button>
                        {source && <button type='button' className={ghostBtn} onClick={() => setEditing(false)}>Cancel</button>}
                    </form>
                )}
                {error && <p className='mt-2 text-[12.5px] text-alert'>{error}</p>}
            </div>
            <button type='button' onClick={() => void openExternal('https://platform.composio.dev')} className='mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-accent-text hover:underline'>Open Composio <ExternalLink size={12}/></button>
        </section>
    );
}

// ------------------------------------------------------------ this Mac (the app only)

function ThisMacSettings() {
    const [keys, setKeys] = useState<{panel: ShortcutStatus; talk: ShortcutStatus} | null>(null);
    const [button, setButton] = useState<boolean | null>(null);
    const [server, setServer] = useState<LocalServerStatus | null>(null);

    useEffect(() => {
        void shortcutsGet().then(setKeys);
        void talkButtonVisible().then(setButton);
        void localServerStatus().then(setServer);
    }, []);

    return (
        <div className='space-y-6'>
            <section className='flex items-center gap-3 rounded-2xl bg-bg-subtle p-3 ring-1 ring-line/70'>
                <span className='min-w-0 flex-1'>
                    <span className='block text-[13px] font-bold text-ink'>Setup guide</span>
                    <span className='block text-[12px] text-muted'>Server, model key, mic, banners, screen snapshots, shortcuts and the Chrome extension, each with a quick test.</span>
                </span>
                <button type='button' className={primaryBtn} onClick={openSetup}>Open</button>
            </section>
            <section>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Keyboard shortcuts</h3>
                <p className='mb-3 text-[12.5px] text-muted'>They work in any app. If another app already uses the keys (Lock In uses ⌘⇧Space), pick others. macOS 15 and later only allows shortcuts that include ⌘ or ⌃.</p>
                {keys && (
                    <div className='space-y-2'>
                        <ShortcutRow kind='panel' label='Write to a chat' hint='Opens the panel from the menu bar' status={keys.panel} onChange={(st) => setKeys({...keys, panel: st})}/>
                        <ShortcutRow kind='talk' label='Talk to Captain' hint='Hold to talk, or tap to start and tap again to send. Captain answers out loud.' status={keys.talk} onChange={(st) => setKeys({...keys, talk: st})}/>
                    </div>
                )}
            </section>
            <section>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>The little Captain</h3>
                <label className='flex items-center gap-3 text-[13px] text-text'>
                    <input
                        type='checkbox'
                        className='size-4 accent-[var(--accent)]'
                        checked={!!button}
                        disabled={button === null}
                        onChange={(e) => {
                            setButton(e.target.checked);
                            void setTalkButtonVisible(e.target.checked);
                        }}
                    />
                    Show the little Captain on the screen
                </label>
                <p className='mt-1 pl-7 text-[12px] text-muted'>Hold it to talk (it picks the chat from what you say), click it for what needs you, double-click to talk hands-free. Drag it anywhere; it settles on the nearest edge. Right-click for language and spoken answers.</p>
            </section>
            <AgentsOnThisMac/>
            {server?.configured && (
                <section>
                    <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Captain on this Mac</h3>
                    <div className='flex items-center gap-3 text-[13px]'>
                        <span className={`size-2 rounded-full ${server.running ? 'bg-emerald-500' : 'bg-amber-500'}`}/>
                        <span className='text-text'>{server.running ? `Running at ${server.url.replace('http://', '')}` : server.starting ? 'Starting…' : server.error ?? 'Stopped'}</span>
                        <button type='button' className={`${ghostBtn} ml-auto`} onClick={() => void localServerRestart().then(() => window.setTimeout(() => void localServerStatus().then(setServer), 1500))}>Restart</button>
                    </div>
                </section>
            )}
        </div>
    );
}

// Agents using this Mac: on or off, hands-free, permissions, a quick test.
function AgentsOnThisMac() {
    const [enabled, setEnabled] = useState<boolean | null>(null);
    const [devices, setDevices] = useState<Device[]>([]);
    const [perms, setPerms] = useState<Permissions | null>(null);
    const [shot, setShot] = useState<{image: string; front: string} | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const me = devices.find((d) => d.id === thisDeviceId());
    const others = devices.filter((d) => d.id !== thisDeviceId());

    const checkPerms = () => void deskPermissions().then(setPerms).catch(() => setPerms(null));
    useEffect(() => {
        void deviceEnabled().then(setEnabled);
        void refreshDevices();
        checkPerms();
        const stop = onDevices(setDevices);
        // Permissions change in System Settings, outside the app: look again now and then.
        const t = window.setInterval(checkPerms, 4000);
        return () => {
            stop();
            window.clearInterval(t);
        };
    }, []);

    const row = (label: string, ok: boolean | null, link: string, why: string) => (
        <div className='flex items-center gap-3 rounded-xl bg-bg-subtle px-3 py-2 ring-1 ring-line/70'>
            <span className={`size-2 shrink-0 rounded-full ${ok ? 'bg-emerald-500' : ok === null ? 'bg-line' : 'bg-amber-500'}`}/>
            <span className='min-w-0 flex-1'>
                <span className='block text-[13px] font-bold text-ink'>{label}</span>
                <span className='block text-[12px] text-muted'>{why}</span>
            </span>
            {!ok && <button type='button' className={ghostBtn} onClick={() => void openExternal(link)}>Open System Settings</button>}
        </div>
    );

    return (
        <section className='space-y-3'>
            <div>
                <h3 className='mb-1 text-[13px] font-extrabold text-ink'>Agents on this Mac</h3>
                <p className='text-[12.5px] text-muted'>While Captain is open, agents you ask can work on this Mac: see the screen, read apps, click, type, open things, and carry a task through (&ldquo;grab the total from my spreadsheet, run it through ChatGPT, send it from Gmail&rdquo;). The little Captain shows each step; <span className='font-semibold text-ink'>Esc</span> stops it any time.</p>
            </div>
            <label className='flex items-center gap-3 text-[13px] text-text'>
                <input type='checkbox' className='size-4 accent-[var(--accent)]' checked={!!enabled} disabled={enabled === null} onChange={(e) => {
                    setEnabled(e.target.checked);
                    void setDeviceEnabled(e.target.checked);
                }}/>
                Let agents use this Mac
                {me && <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${me.online ? 'bg-emerald-500/15 text-emerald-700' : 'bg-bg-subtle text-muted'}`}>{me.online ? 'Connected' : 'Not connected'}</span>}
            </label>
            {enabled && (
                <label className='flex items-center gap-3 pl-7 text-[13px] text-text'>
                    <input type='checkbox' className='size-4 accent-[var(--accent)]' checked={!!me?.autopilot} disabled={!me} onChange={(e) => {
                        if (me) {
                            void api.updateDevice(me.id, {autopilot: e.target.checked}).then(() => refreshDevices()).catch((err) => setError(errorMessage(err)));
                        }
                    }}/>
                    <span>
                        Hands-free: don&apos;t ask before each task
                        <span className='block text-[12px] text-muted'>Off: the first time a task needs this Mac, a card asks you once. Sending, paying, deleting and posting still ask either way unless you told it to.</span>
                    </span>
                </label>
            )}
            {enabled && (
                <div className='space-y-2'>
                    {row('Accessibility', perms?.accessibility ?? null, ACCESSIBILITY_SETTINGS, 'To click, type and read what apps show.')}
                    {row('Screen Recording', perms?.screen ?? null, SCREEN_RECORDING_SETTINGS, 'To see the screen and window titles.')}
                </div>
            )}
            {enabled && (
                <div className='flex items-center gap-3'>
                    <button type='button' className={ghostBtn} disabled={busy} onClick={() => {
                        setBusy(true);
                        setError(null);
                        void testScreenshot().then(setShot).catch((err) => setError(errorMessage(err))).finally(() => setBusy(false));
                    }}>{busy ? 'Looking…' : 'Test: take a look at the screen'}</button>
                    {shot && <span className='text-[12px] text-muted'>Captain sees {shot.front || 'your screen'}. Its own windows are left out.</span>}
                </div>
            )}
            {shot && <img src={shot.image} alt='What Captain sees' className='w-full max-w-[420px] rounded-xl ring-1 ring-line/70'/>}
            {others.length > 0 && (
                <p className='text-[12px] text-muted'>Also yours: {others.map((d) => `${d.name}${d.online ? '' : ' (offline)'}`).join(', ')}.</p>
            )}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </section>
    );
}

// ------------------------------------------------------------ profile

function Profile() {
    const me = useStore((s) => s.me)!;
    const [name, setName] = useState(me.displayName);
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    return (
        <div className='space-y-5'>
            <section className='space-y-2'>
                <h3 className='text-[13px] font-extrabold text-ink'>Name</h3>
                <div className='flex gap-2'>
                    <input className={input} value={name} onChange={(e) => setName(e.target.value)}/>
                    <button
                        type='button'
                        className={ghostBtn}
                        disabled={!name.trim() || name === me.displayName}
                        onClick={() => api.updateMe(name).then((u) => {
                            useStore.setState((s) => ({me: u, users: {...s.users, [u.id]: u}}));
                            setNote('Saved.');
                        }).catch((e) => setError(errorMessage(e)))}
                    >Save</button>
                </div>
                <p className='text-[12px] text-muted'>{me.email} · @{me.username}</p>
            </section>
            <section className='space-y-2'>
                <h3 className='text-[13px] font-extrabold text-ink'>Password</h3>
                <input className={input} type='password' value={current} onChange={(e) => setCurrent(e.target.value)} placeholder='Current password' autoComplete='current-password'/>
                <input className={input} type='password' value={next} onChange={(e) => setNext(e.target.value)} placeholder='New password (8+ characters)' autoComplete='new-password'/>
                <button
                    type='button'
                    className={ghostBtn}
                    disabled={!current || next.length < 8}
                    onClick={() => api.changePassword(current, next).then(() => {
                        setCurrent('');
                        setNext('');
                        setNote('Password changed. Other devices were signed out.');
                    }).catch((e) => setError(errorMessage(e)))}
                >Change password</button>
            </section>
            {note && <p className='text-[12.5px] text-accent-text'>{note}</p>}
            {error && <p className='text-[12.5px] text-alert'>{error}</p>}
        </div>
    );
}
