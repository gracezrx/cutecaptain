import {Check, Clock, CornerUpLeft, Hand, ShieldCheck, X} from 'lucide-react';
import {useState} from 'react';

import {api, errorMessage} from '../lib/api';
import {timeOfDay} from '../lib/format';
import {canDecide, decisionOf, displayName, ownAccountApp, useStore} from '../lib/store';
import type {DecisionCard as Decision, Post, User, Workspace} from '../lib/types';

const DAY = 86_400_000;
export const DECISION_DAYS = 7; // the server expires a decision nobody answers after a week
const FACTS_SHOWN = 3;

// Who can answer, in a muted line under the buttons.
function whoCanAnswer(d: Decision, me: User | null, workspace: Workspace | null, asker: string, createdAt: number): string {
    const app = ownAccountApp(d.tool);
    const mine = d.requestedBy === me?.id;
    const admin = workspace?.role === 'owner' || workspace?.role === 'admin';
    const who = app ?
        (mine ? `Only you can answer: it uses your ${app}.` : `Only ${asker} can answer: it uses their ${app}.`) :
        mine ? 'You or a workspace admin can answer.' : admin ? `${asker} asked; as an admin you can answer too.` : `${asker} or a workspace admin can answer.`;
    const left = Math.ceil((createdAt + DECISION_DAYS * DAY - Date.now()) / DAY);
    return left > 0 && left < DECISION_DAYS ? `${who} Expires in ${left} ${left === 1 ? 'day' : 'days'}.` : who;
}

// "The agent prepares, a person confirms." A gold edge and a shield mark a
// decision; once answered, the card stays and its buttons become a badge.
export function DecisionCard({post, compact = false}: {post: Post; compact?: boolean}) {
    const decision = decisionOf(post);
    const users = useStore((s) => s.users);
    const me = useStore((s) => s.me);
    const workspace = useStore((s) => s.workspace);
    const updatePost = useStore((s) => s.updatePost);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [changing, setChanging] = useState(false);
    const [change, setChange] = useState('');
    const [details, setDetails] = useState(false);
    if (!decision) {
        return null;
    }
    const pending = decision.status === 'pending';
    const allowed = pending && canDecide(decision, me, workspace);
    // A hand-over: the agent paused for the person to do something themselves
    // (sign in, type a code). Done / Stop instead of Approve / Decline.
    const handover = decision.kind === 'handover';

    // "Change it": say what to change. The draft is turned down with that
    // note, and the same agent revises it and asks again.
    const changeIt = async () => {
        const what = change.trim();
        if (!what) {
            return;
        }
        setBusy('change');
        setError(null);
        try {
            updatePost(await api.postAction(post.id, 'reject', {note: what}));
            setChanging(false);
            setChange('');
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const act = async (action: 'approve' | 'reject') => {
        setBusy(action);
        setError(null);
        try {
            updatePost(await api.postAction(post.id, action));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    // Key facts: the first few, the rest (and long values in full) behind Details.
    const long = decision.fields.some((f) => f.value.length > 160);
    const more = decision.fields.length > FACTS_SHOWN || long;
    const facts = details ? decision.fields : decision.fields.slice(0, pending ? FACTS_SHOWN : 0);
    const link = 'text-[12.5px] font-semibold text-muted underline-offset-2 transition-colors hover:text-ink hover:underline disabled:opacity-60';

    return (
        <div
            className={`mt-1.5 max-w-xl rounded-2xl bg-surface ring-1 ring-line ${compact ? 'p-3' : 'p-4'}`}
            style={pending ? {boxShadow: `inset 3px 0 0 ${handover ? 'var(--accent)' : 'var(--gold)'}`} : undefined}
        >
            <div className='flex items-start gap-2'>
                {handover ?
                    <Hand size={compact ? 15 : 16} strokeWidth={2.25} className={`mt-px shrink-0 ${pending ? 'text-accent' : 'text-muted'}`} aria-hidden/> :
                    <ShieldCheck size={compact ? 15 : 16} strokeWidth={2.25} className={`mt-px shrink-0 ${pending ? 'text-gold' : 'text-muted'}`} aria-hidden/>}
                <div className='min-w-0'>
                    <div className={`font-bold leading-snug text-ink ${compact ? 'text-[13px]' : 'text-[14px]'}`}>{decision.title}</div>
                    {decision.reason && <p className={`mt-0.5 leading-relaxed text-text ${compact ? 'text-[12.5px]' : 'text-[13px]'} ${pending ? '' : 'line-clamp-1'}`}>{decision.reason}</p>}
                </div>
            </div>

            {facts.length > 0 && (
                <dl className='mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 pl-6 text-[12.5px]'>
                    {facts.map((f) => (
                        <div key={f.label} className='contents'>
                            <dt className='text-muted'>{f.label}</dt>
                            <dd className={`font-medium whitespace-pre-wrap text-ink ${details ? (compact ? 'scroll-quiet max-h-40 overflow-y-auto' : '') : 'line-clamp-3'}`}>{f.value}</dd>
                        </div>
                    ))}
                </dl>
            )}

            {pending ? (
                <>
                    {allowed ? (
                        <div className='mt-3 flex flex-wrap items-center gap-2 pl-6'>
                            <button
                                type='button'
                                disabled={busy !== null}
                                onClick={() => void act('approve')}
                                className='inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent transition-opacity disabled:opacity-60'
                                style={{boxShadow: 'var(--shadow-send)'}}
                            >
                                <Check size={14} strokeWidth={2.5}/>
                                {handover ? (busy === 'approve' ? 'Carrying on…' : 'Done, carry on') : busy === 'approve' ? 'Approving…' : 'Approve'}
                            </button>
                            {handover ? (
                                decision.deviceId && (
                                    <button
                                        type='button'
                                        disabled={busy !== null}
                                        onClick={() => void api.showDevice(decision.deviceId!).catch((e) => setError(errorMessage(e)))}
                                        className='inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-semibold text-ink ring-1 ring-line transition-colors hover:bg-tint disabled:opacity-60'
                                    >
                                        Show me
                                    </button>
                                )
                            ) : (
                                <button
                                    type='button'
                                    disabled={busy !== null}
                                    onClick={() => setChanging((c) => !c)}
                                    aria-expanded={changing}
                                    className='inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-semibold text-ink ring-1 ring-line transition-colors hover:bg-tint disabled:opacity-60'
                                >
                                    Change it
                                </button>
                            )}
                            <button type='button' disabled={busy !== null} onClick={() => void act('reject')} className={`${link} ml-1`}>
                                {handover ? (busy === 'reject' ? 'Stopping…' : 'Stop') : busy === 'reject' ? 'Declining…' : 'Decline'}
                            </button>
                            {more && (
                                <button type='button' onClick={() => setDetails((d) => !d)} aria-expanded={details} className={link}>
                                    {details ? 'Less' : 'Details'}
                                </button>
                            )}
                        </div>
                    ) : more ? (
                        <div className='mt-2 pl-6'>
                            <button type='button' onClick={() => setDetails((d) => !d)} aria-expanded={details} className={link}>{details ? 'Less' : 'Details'}</button>
                        </div>
                    ) : null}
                    {allowed && changing && (
                        <form
                            className='mt-2 flex items-center gap-2 pl-6'
                            onSubmit={(e) => {
                                e.preventDefault();
                                void changeIt();
                            }}
                        >
                            <label className='sr-only' htmlFor={`change-${post.id}`}>What should change?</label>
                            <input
                                id={`change-${post.id}`}
                                autoFocus
                                value={change}
                                onChange={(e) => setChange(e.target.value)}
                                placeholder='What should change? Like "make it warmer"'
                                className='h-9 min-w-0 flex-1 rounded-full bg-bg-subtle px-3.5 text-[13px] text-ink ring-1 ring-line outline-none focus:ring-2 focus:ring-accent'
                            />
                            <button type='submit' disabled={!change.trim() || busy !== null} className='inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent disabled:opacity-50'>
                                {busy === 'change' ? 'Sending…' : 'Send'}
                            </button>
                        </form>
                    )}
                    <p className='mt-2.5 pl-6 text-[11.5px] text-muted'>{whoCanAnswer(decision, me, workspace, displayName(users[decision.requestedBy]), post.createdAt)}</p>
                </>
            ) : (
                <div className='mt-2.5 flex flex-wrap items-center gap-2 pl-6'>
                    <Outcome decision={decision} by={decision.decidedBy ? displayName(users[decision.decidedBy]) : null} handover={handover}/>
                    {decision.fields.length > 0 && (
                        <button type='button' onClick={() => setDetails((d) => !d)} aria-expanded={details} className={link}>{details ? 'Less' : 'Details'}</button>
                    )}
                </div>
            )}
            {error && <p className='mt-2 pl-6 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}

// The answer, as a badge: green for approved, red for declined, gold for
// sent back with a change, grey when it ran out of time.
function Outcome({decision: d, by, handover = false}: {decision: Decision; by: string | null; handover?: boolean}) {
    const when = d.decidedAt ? ` · ${timeOfDay(d.decidedAt)}` : '';
    const badge = 'inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold';
    if (d.status === 'approved') {
        return <span className={`${badge} bg-success-tint text-success`}><Check size={13} strokeWidth={2.75}/>{handover ? 'Done' : 'Approved'}{by ? ` by ${by}` : ''}{when}</span>;
    }
    if (d.status === 'rejected' && handover) {
        return <span className={`${badge} bg-bg-subtle text-muted ring-1 ring-line`}><X size={13} strokeWidth={2.75}/>Stopped{by ? ` by ${by}` : ''}{when}</span>;
    }
    if (d.status === 'rejected' && d.note) {
        return (
            <span className={`${badge} bg-gold-tint text-gold-text`} title={d.note}>
                <CornerUpLeft size={13} strokeWidth={2.5}/>
                <span className='truncate'>Sent back{by ? ` by ${by}` : ''}: "{d.note}"</span>
            </span>
        );
    }
    if (d.status === 'rejected') {
        return <span className={`${badge} bg-alert/10 text-alert`}><X size={13} strokeWidth={2.75}/>Declined{by ? ` by ${by}` : ''}{when}</span>;
    }
    return (
        <span className={`${badge} bg-bg-subtle text-muted ring-1 ring-line`}>
            <Clock size={13} strokeWidth={2.5}/>
            {d.timedOut ? `Expired · no answer in ${DECISION_DAYS} days` : 'Expired · the work was stopped'}
        </span>
    );
}
