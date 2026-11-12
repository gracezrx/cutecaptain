// Multi-agent orchestration, run as durable jobs so work survives restarts
// and spreads across server instances:
//
//   run.start       Captain plans (or a single agent is set up to answer)
//   run.advance     start every step whose dependencies are done, up to the
//                   parallel limit; skip steps whose dependencies failed
//   step.execute    one agent does one step (runner.ts), posting in the thread
//   approval.resume a person decided; the paused step continues
//   run.finish      Captain combines the results into one answer
//
// Every run has steps, even a single reply (one step), so pausing for
// approval, cancelling and resuming work the same way everywhere.

import type {Ctx} from '../app/context.js';
import {postEdited, toChannel as publishToChannel} from '../app/events.js';
import type {PostAction} from '../app/hooks.js';
import {atLeast} from '../app/permissions.js';
import {agentWorking, savePost} from '../app/posts.js';
import {config} from '../config.js';
import {tx, type Db} from '../db/index.js';
import type {ChatMessage} from '../llm/types.js';
import type {DecisionCard, PlanCard, PlanStepStatus, RunStatus, Tier} from '../shared/types.js';
import {type AgentRow, getAgent, listAgents} from '../store/agents.js';
import {audit} from '../store/audit.js';
import {getChannel} from '../store/channels.js';
import {getPost, mergePostProps} from '../store/posts.js';
import {
    addRunCost, type ApprovalRow, decideApproval, getApproval, getRun, getStep, insertSteps, listSteps, lockRun, type RunRow, type StepRow,
    TERMINAL_RUN, TERMINAL_STEP, updateRun, updateStep,
} from '../store/runs.js';
import {getUser, type UserRow} from '../store/users.js';
import {getMemberRole, getWorkspace} from '../store/workspaces.js';
import {badRequest, conflict, forbidden, notFound} from '../util/errors.js';
import {now} from '../util/ids.js';
import {log} from '../util/log.js';

import {attachmentsFor, conversation, withoutImageData} from './history.js';
import {onOwnAccount} from '../connectors/composio.js';

import {makePlan} from './planner.js';
import {agentSystem, type Setting, stepSystem, synthesisSystem} from './prompts.js';
import {releaseDevices} from '../app/devices.js';

import {CancelledError, friendlyError, runAgent, type RunnerOutcome, type StepState} from './runner.js';
import {chooseTier} from './tiering.js';
import {toolsFor} from './tools/index.js';
import {mentionedHandles} from './triggers.js';

type RunPayload = {runId: string};
type StepPayload = {runId: string; stepId: string};
type ApprovalPayload = {approvalId: string};

export class Orchestrator {
    private readonly ctx: Ctx;

    constructor(ctx: Ctx) {
        this.ctx = ctx;
    }

    register(): void {
        const {jobs, hooks} = this.ctx;
        jobs.register<RunPayload>('run.start', (p) => this.start(p.runId), {maxAttempts: 2, onFailed: (p, e) => this.failRun(p.runId, e)});
        jobs.register<RunPayload>('run.advance', (p) => this.advance(p.runId), {maxAttempts: 5});
        jobs.register<StepPayload>('step.execute', (p, j) => this.executeStep(p.runId, p.stepId, j.attempt, j.signal), {maxAttempts: 2, onFailed: (p, e) => this.stepCrashed(p.runId, p.stepId, e)});
        jobs.register<ApprovalPayload>('approval.resume', (p, j) => this.resume(p.approvalId, j.attempt, j.signal), {maxAttempts: 2, onFailed: async (p, e) => {
            const a = await getApproval(this.ctx.sql, p.approvalId);
            if (a?.runId && a.stepId) {
                await this.stepCrashed(a.runId, a.stepId, e);
            }
        }});
        jobs.register<RunPayload>('run.finish', (p) => this.finish(p.runId), {maxAttempts: 2, onFailed: (p, e) => this.failRun(p.runId, e)});
        hooks.onPostAction('decision', (db, a) => this.decide(db, a));
    }

    // ------------------------------------------------------------ helpers

    private async load(runId: string): Promise<{run: RunRow; captain: AgentRow; channelOk: boolean} | null> {
        const run = await getRun(this.ctx.sql, runId);
        if (!run) {
            return null;
        }
        const captain = await getAgent(this.ctx.sql, run.agentId);
        if (!captain) {
            return null;
        }
        return {run, captain, channelOk: Boolean(await getChannel(this.ctx.sql, run.channelId))};
    }

    private async setting(run: RunRow, requester: UserRow): Promise<Setting> {
        const [ws, channel] = await Promise.all([getWorkspace(this.ctx.sql, run.workspaceId), getChannel(this.ctx.sql, run.channelId)]);
        return {workspaceName: ws?.name ?? 'Captain', channel: channel!, requesterName: requester.displayName, unprompted: run.unprompted};
    }

    // Where step work is posted: the request's thread, or for a plan started at
    // the top of a direct message, the plan card's thread (the DM stays tidy).
    private workRoot(run: RunRow): string | null {
        return run.kind === 'plan' && !run.rootPostId ? run.cardPostId : run.rootPostId;
    }

    async publishRun(run: RunRow): Promise<void> {
        await publishToChannel(this.ctx, this.ctx.sql, run.channelId, {event: 'run_updated', data: {runId: run.id, channelId: run.channelId, status: run.status, triggerPostId: run.triggerPostId}});
        if (TERMINAL_RUN.includes(run.status)) {
            await releaseDevices(this.ctx, run).catch(() => undefined);
        }
        await this.markTrigger(run).catch((err) => log.warn({err: (err as Error).message, runId: run.id}, 'couldn\'t update the working reaction'));
        if (run.cardPostId) {
            const steps = await listSteps(this.ctx.sql, run.id);
            const plan: PlanCard = {
                runId: run.id, status: run.status, goal: run.goal,
                // The agents you named: Captain splits the work between just them.
                ...(run.team?.length ? {coordinating: run.team} : {}),
                steps: steps.map((s) => ({id: s.id, title: s.title, agentId: s.agentId, status: s.status, postId: s.postId, dependsOn: s.dependsOn})),
            };
            const row = await mergePostProps(this.ctx.sql, run.cardPostId, {plan});
            await postEdited(this.ctx, this.ctx.sql, row);
        }
    }

    // The agent's Looking / Done reaction on the message that asked for the
    // work. Not on messages Captain joined in on unasked.
    private async markTrigger(run: RunRow): Promise<void> {
        if (!run.triggerPostId || run.unprompted) {
            return;
        }
        const agent = await getAgent(this.ctx.sql, run.agentId);
        if (!agent) {
            return;
        }
        const state = run.status === 'succeeded' ? 'done' : run.status === 'failed' || run.status === 'cancelled' ? null : 'looking';
        await agentWorking(this.ctx, agent.userId, run.triggerPostId, state, run.id);
    }

    private async say(run: RunRow, agent: AgentRow, message: string, rootId: string | null, props: Record<string, unknown> = {}): Promise<string | null> {
        const [bot, channel] = await Promise.all([getUser(this.ctx.sql, agent.userId), getChannel(this.ctx.sql, run.channelId)]);
        if (!bot || !channel) {
            return null;
        }
        const post = await savePost(this.ctx, bot, channel, {message, rootId, props});
        return post.id;
    }

    async failRun(runId: string, error: string): Promise<void> {
        const loaded = await this.load(runId);
        if (!loaded || TERMINAL_RUN.includes(loaded.run.status)) {
            return;
        }
        const run = await updateRun(this.ctx.sql, runId, {status: 'failed', error: error.slice(0, 1000)});
        await this.ctx.sql`update run_steps set status = 'cancelled', finished_at = ${now()} where run_id = ${runId} and status in ('pending', 'running', 'waiting_approval')`;
        const expired = await this.ctx.sql`update approvals set status = 'expired', decided_at = ${now()} where run_id = ${runId} and status = 'pending' returning id, post_id`;
        await this.markExpired(expired.map((r) => ({id: r.id as string, postId: r.postId as string | null})), false);
        if (loaded.channelOk) {
            await this.say(run, loaded.captain, 'Sorry, I couldn\'t finish this one. Try asking again.', run.rootPostId, {error: error.slice(0, 300)}).catch(() => undefined);
        }
        await this.publishRun(run);
    }

    // Stop the work of a run when it's cancelled (checked across servers via the database).
    private watch(runId: string, ctrl: AbortController): () => void {
        const timer = setInterval(async () => {
            const r = await getRun(this.ctx.sql, runId).catch(() => null);
            if (r?.status === 'cancelled') {
                ctrl.abort();
            }
        }, 1500);
        return () => clearInterval(timer);
    }

    // ------------------------------------------------------------ run.start

    async start(runId: string): Promise<void> {
        const loaded = await this.load(runId);
        if (!loaded || TERMINAL_RUN.includes(loaded.run.status) || !loaded.channelOk) {
            return;
        }
        let {run} = loaded;
        const {captain} = loaded;
        if ((await listSteps(this.ctx.sql, runId)).length) {
            await this.ctx.jobs.enqueue(this.ctx.sql, 'run.advance', {runId}, {dedupeKey: `advance:${runId}`}); // a retry: already set up
            return;
        }
        if (!captain.enabled) {
            await this.failRun(runId, `${captain.name} is turned off.`);
            return;
        }
        if (captain.isCoordinator) {
            run = await updateRun(this.ctx.sql, runId, {status: 'planning'});
            await this.publishRun(run);
            const [requester, trigger, channel] = await Promise.all([getUser(this.ctx.sql, run.requestedBy), run.triggerPostId ? getPost(this.ctx.sql, run.triggerPostId) : null, getChannel(this.ctx.sql, run.channelId)]);
            if (!requester || !trigger || !channel) {
                await this.failRun(runId, 'The message that started this is gone.');
                return;
            }
            const ctrl = new AbortController();
            const stop = this.watch(runId, ctrl);
            try {
                const convo = await conversation(this.ctx, channel, trigger, captain.userId);
                // Agents named in the message: Captain coordinates just them.
                const everyone = await listAgents(this.ctx.sql, run.workspaceId);
                const team = run.team?.length ? everyone.filter((a) => run.team!.includes(a.id) && a.enabled) : everyone;
                const named = Boolean(run.team?.length) && mentionedHandles(trigger.message).some((h) => team.some((a) => a.handle.toLowerCase() === h));
                const plan = await makePlan(this.ctx, {
                    captain, team, named, setting: await this.setting(run, requester),
                    conversation: withoutImageData(convo.messages), text: convo.text, workspaceId: run.workspaceId, runId, requesterId: requester.id, signal: ctrl.signal,
                });
                if (ctrl.signal.aborted) {
                    return;
                }
                if (plan.mode === 'plan') {
                    // Stopped while planning? Then nothing starts.
                    const live = await tx(this.ctx.sql, async (t) => {
                        const locked = await lockRun(t, runId);
                        if (!locked || TERMINAL_RUN.includes(locked.status)) {
                            return false;
                        }
                        await insertSteps(t, runId, plan.steps);
                        await updateRun(t, runId, {kind: 'plan', goal: plan.goal, status: 'running'});
                        return true;
                    });
                    if (!live) {
                        return;
                    }
                    const card = await savePost(this.ctx, (await getUser(this.ctx.sql, captain.userId))!, channel, {
                        message: `Plan: ${plan.goal}`, rootId: run.rootPostId, type: 'plan',
                        props: {plan: {runId, status: 'running', goal: plan.goal, ...(run.team?.length ? {coordinating: run.team} : {}), steps: plan.steps.map((s) => ({id: s.id, title: s.title, agentId: s.agentId, status: 'pending' as const, postId: null, dependsOn: s.dependsOn}))}},
                    });
                    run = await updateRun(this.ctx.sql, runId, {cardPostId: card.id});
                    await this.publishRun(run);
                    await this.ctx.jobs.enqueue(this.ctx.sql, 'run.advance', {runId}, {dedupeKey: `advance:${runId}`});
                    return;
                }
            } catch (e) {
                if ((e as {status?: number}).status === 402) {
                    await this.say(run, captain, friendlyError(e), run.rootPostId, {error: 'budget_exceeded'});
                    const failed = await updateRun(this.ctx.sql, runId, {status: 'failed', error: friendlyError(e)});
                    await this.publishRun(failed);
                    return;
                }
                if (!ctrl.signal.aborted) {
                    throw e;
                }
                return;
            } finally {
                stop();
            }
        }
        // A single agent answers.
        await tx(this.ctx.sql, async (t) => {
            const locked = await lockRun(t, runId);
            if (!locked || TERMINAL_RUN.includes(locked.status)) {
                return;
            }
            await insertSteps(t, runId, [{id: 's1', agentId: captain.id, title: 'Reply', instructions: '', dependsOn: []}]);
            await updateRun(t, runId, {kind: 'single', status: 'running'});
            await this.ctx.jobs.enqueue(t, 'run.advance', {runId}, {dedupeKey: `advance:${runId}`});
        });
    }

    // ------------------------------------------------------------ run.advance

    async advance(runId: string): Promise<void> {
        const result = await tx(this.ctx.sql, async (t) => {
            const run = await lockRun(t, runId);
            if (!run || TERMINAL_RUN.includes(run.status)) {
                return null;
            }
            const steps = await listSteps(t, runId);
            const status = new Map(steps.map((s) => [s.id, s.status]));
            // Skip steps that can never run because something they need failed.
            let changed = true;
            while (changed) {
                changed = false;
                for (const s of steps) {
                    if (status.get(s.id) === 'pending' && s.dependsOn.some((d) => ['failed', 'skipped', 'cancelled'].includes(status.get(d) ?? ''))) {
                        status.set(s.id, 'skipped');
                        await updateStep(t, runId, s.id, {status: 'skipped', finishedAt: now(), error: 'A step it depends on did not finish.'});
                        changed = true;
                    }
                }
            }
            const running = steps.filter((s) => status.get(s.id) === 'running').length;
            const ready = steps.filter((s) => status.get(s.id) === 'pending' && s.dependsOn.every((d) => status.get(d) === 'succeeded'));
            const slots = Math.max(0, config.agents.maxParallelSteps - running);
            for (const s of ready.slice(0, slots)) {
                status.set(s.id, 'running');
                await updateStep(t, runId, s.id, {status: 'running', startedAt: now()});
                await this.ctx.jobs.enqueue(t, 'step.execute', {runId, stepId: s.id}, {dedupeKey: `step:${runId}:${s.id}`});
            }
            const all = [...status.values()];
            const finished = all.every((v) => TERMINAL_STEP.includes(v));
            if (finished) {
                await this.ctx.jobs.enqueue(t, 'run.finish', {runId}, {dedupeKey: `finish:${runId}`});
            }
            const next: RunStatus = all.includes('running') ? 'running' : all.includes('waiting_approval') ? 'waiting_approval' : run.status;
            return next !== run.status ? updateRun(t, runId, {status: next}) : run;
        });
        if (result) {
            await this.publishRun(result);
        }
    }

    // ------------------------------------------------------------ steps

    private async stepContext(run: RunRow, step: StepRow): Promise<{agent: AgentRow; agentUser: UserRow; requester: UserRow; setting: Setting} | null> {
        const agent = await getAgent(this.ctx.sql, step.agentId);
        const [agentUser, requester] = await Promise.all([agent ? getUser(this.ctx.sql, agent.userId) : null, getUser(this.ctx.sql, run.requestedBy)]);
        const channel = await getChannel(this.ctx.sql, run.channelId);
        if (!agent || !agentUser || !requester || !channel) {
            return null;
        }
        return {agent, agentUser, requester, setting: await this.setting(run, requester)};
    }

    // The opening messages for a step.
    private async firstMessages(run: RunRow, step: StepRow, agent: AgentRow, setting: Setting): Promise<{messages: ChatMessage[]; text: string; hasImages: boolean}> {
        const trigger = run.triggerPostId ? await getPost(this.ctx.sql, run.triggerPostId) : null;
        if (!trigger) {
            throw new Error('the message that started this run is gone');
        }
        const tools = toolsFor(agent).filter((t) => !t.marker).map((t) => t.name);
        if (run.kind === 'single') {
            const convo = await conversation(this.ctx, setting.channel, trigger, agent.userId);
            return {messages: [{role: 'system', content: agentSystem(agent, setting, tools)}, ...convo.messages], text: convo.text, hasImages: convo.hasImages};
        }
        // A plan step: the original request (with its attachments) plus what its dependencies produced.
        const files = (await attachmentsFor(this.ctx, [trigger], true)).get(trigger.id);
        const steps = await listSteps(this.ctx.sql, run.id);
        const agents = new Map((await listAgents(this.ctx.sql, run.workspaceId)).map((a) => [a.id, a]));
        const inputs = steps.filter((s) => step.dependsOn.includes(s.id)).map((s) => `### ${s.title} (from @${agents.get(s.agentId)?.handle ?? 'teammate'})\n${(s.output ?? '').slice(0, 12_000)}`);
        const text = [
            `${setting.requesterName} asked: ${trigger.message}`,
            ...(files?.texts ?? []),
            inputs.length ? `\nWhat your teammates handed you:\n\n${inputs.join('\n\n')}` : '',
        ].filter(Boolean).join('\n\n');
        const images = files?.images ?? [];
        const user: ChatMessage = images.length ? {role: 'user', content: [{type: 'text', text}, ...images.map((url) => ({type: 'image_url' as const, image_url: {url}}))]} : {role: 'user', content: text};
        return {messages: [{role: 'system', content: stepSystem(agent, setting, tools, run.goal, step)}, user], text: `${step.title}\n${step.instructions}\n${trigger.message}`, hasImages: images.length > 0};
    }

    async executeStep(runId: string, stepId: string, attempt = 1, jobSignal?: AbortSignal): Promise<void> {
        const run = await getRun(this.ctx.sql, runId);
        const step = await getStep(this.ctx.sql, runId, stepId);
        if (!run || !step || TERMINAL_RUN.includes(run.status) || step.status !== 'running') {
            return;
        }
        if (attempt > 1 && step.postId) {
            // A server stopped mid-step: close the half-written message before starting over.
            const old = await getPost(this.ctx.sql, step.postId);
            if (old?.props.streaming) {
                const row = await mergePostProps(this.ctx.sql, old.id, {streaming: false, error: 'interrupted'});
                await postEdited(this.ctx, this.ctx.sql, row);
            }
        }
        const sc = await this.stepContext(run, step);
        if (!sc) {
            await this.finishStep(run, step, {status: 'failed', error: 'The agent or channel is gone.'});
            return;
        }
        let first: {messages: ChatMessage[]; text: string; hasImages: boolean};
        try {
            first = await this.firstMessages(run, step, sc.agent, sc.setting);
        } catch (e) {
            await this.finishStep(run, step, {status: 'failed', error: (e as Error).message});
            return;
        }
        const tier = await chooseTier(this.ctx, run.workspaceId, sc.agent, first.text, run.kind === 'plan' ? 'step' : 'reply', run.channelId);
        await this.drive(run, step, sc, {messages: first.messages, pending: [], fileIds: []}, {tier, needVision: first.hasImages, jobSignal});
    }

    // Run (or continue) a step and record what happened.
    private async drive(run: RunRow, step: StepRow, sc: {agent: AgentRow; agentUser: UserRow; requester: UserRow; setting: Setting}, state: StepState, opts: {tier: Tier; needVision: boolean; resume?: ApprovalRow; jobSignal?: AbortSignal}): Promise<void> {
        const ctrl = new AbortController();
        const stopWatch = this.watch(run.id, ctrl);
        // This worker lost its job lease (another worker has the job now): stop quietly.
        const onLost = () => ctrl.abort();
        opts.jobSignal?.addEventListener('abort', onLost);
        const stop = () => {
            stopWatch();
            opts.jobSignal?.removeEventListener('abort', onLost);
        };
        const plan = run.kind === 'plan';
        let outcome: RunnerOutcome;
        try {
            outcome = await runAgent({
                ctx: this.ctx, run, stepId: step.id, agent: sc.agent, agentUser: sc.agentUser, requester: sc.requester, channel: sc.setting.channel,
                threadRoot: this.workRoot(run), purpose: plan ? 'step' : 'reply', tier: opts.tier, needVision: opts.needVision,
                postType: plan ? 'agent_step' : '', postProps: plan ? {step: {runId: run.id, stepId: step.id, title: step.title}} : run.unprompted ? {joinedIn: true} : {},
                state, useTools: true, signal: ctrl.signal, resume: opts.resume,
                onPost: async (postId) => {
                    await updateStep(this.ctx.sql, run.id, step.id, {postId});
                    if (plan) {
                        await this.publishRun((await getRun(this.ctx.sql, run.id))!);
                    }
                },
            });
        } catch (e) {
            stop();
            if (e instanceof CancelledError) {
                return; // cancel() already marked everything
            }
            log.warn({run: run.id, step: step.id, err: (e as Error).message}, 'step failed');
            await this.finishStep(run, step, {status: 'failed', error: friendlyError(e)});
            return;
        }
        stop();
        if (outcome.kind === 'waiting') {
            await updateStep(this.ctx.sql, run.id, step.id, {status: 'waiting_approval', waitingApprovalId: outcome.approvalId, transcript: outcome.state, addCost: outcome.costUsd, modelId: outcome.modelId});
            await addRunCost(this.ctx.sql, run.id, outcome.costUsd);
            await this.ctx.jobs.enqueue(this.ctx.sql, 'run.advance', {runId: run.id}, {dedupeKey: `advance:${run.id}`});
            return;
        }
        await this.finishStep(run, step, {status: 'succeeded', output: outcome.text, postId: outcome.postId, costUsd: outcome.costUsd, modelId: outcome.modelId});
    }

    private async finishStep(run: RunRow, step: StepRow, r: {status: PlanStepStatus; output?: string; error?: string; postId?: string; costUsd?: number; modelId?: string | null}): Promise<void> {
        await updateStep(this.ctx.sql, run.id, step.id, {
            status: r.status, output: r.output ?? null, error: r.error ?? null, postId: r.postId, finishedAt: now(), transcript: null, waitingApprovalId: null,
            addCost: r.costUsd ?? 0, modelId: r.modelId ?? undefined,
        });
        await addRunCost(this.ctx.sql, run.id, r.costUsd ?? 0);
        await this.ctx.jobs.enqueue(this.ctx.sql, 'run.advance', {runId: run.id}, {dedupeKey: `advance:${run.id}`});
    }

    async stepCrashed(runId: string, stepId: string, error: string): Promise<void> {
        const run = await getRun(this.ctx.sql, runId);
        const step = await getStep(this.ctx.sql, runId, stepId);
        if (run && step && !TERMINAL_STEP.includes(step.status)) {
            await this.finishStep(run, step, {status: 'failed', error: error.slice(0, 500)});
        }
    }

    // ------------------------------------------------------------ approvals

    async decide(_db: Db, a: PostAction): Promise<void> {
        const card = a.post.props.decision as DecisionCard | undefined;
        if (!card) {
            throw badRequest('This message has no decision.');
        }
        if (a.action !== 'approve' && a.action !== 'reject') {
            throw badRequest('Choose approve or reject.');
        }
        const approval = await getApproval(this.ctx.sql, card.approvalId);
        if (!approval) {
            throw notFound('Approval');
        }
        if (approval.requestedBy !== a.user.id) {
            if (onOwnAccount(approval.tool)) {
                throw forbidden('Only the person who asked can decide this: it uses their own account.');
            }
            const role = await getMemberRole(this.ctx.sql, approval.workspaceId, a.user.id);
            if (!role || !atLeast(role, 'admin')) {
                throw forbidden('Only the person who asked, or a workspace admin, can decide this.');
            }
        }
        // The decision, the card and the job that resumes the work commit together.
        const {decided, row} = await tx(this.ctx.sql, async (t) => {
            const note = a.action === 'reject' ? a.note ?? null : null;
            const d = await decideApproval(t, approval.id, a.action === 'approve' ? 'approved' : 'rejected', a.user.id, note);
            if (!d) {
                throw conflict(approval.status === 'expired' ? 'This request expired.' : 'Someone already decided this.', 'already_decided');
            }
            const r = await mergePostProps(t, a.post.id, {decision: {...card, status: d.status, decidedBy: a.user.id, decidedAt: d.decidedAt, note: d.note}});
            if (approval.runId) {
                await this.ctx.jobs.enqueue(t, 'approval.resume', {approvalId: approval.id}, {dedupeKey: `resume:${approval.id}`});
            }
            return {decided: d, row: r};
        });
        await postEdited(this.ctx, this.ctx.sql, row);
        audit(this.ctx.sql, {workspaceId: approval.workspaceId, userId: a.user.id, action: `approval_${decided.status}`, target: approval.id, meta: {tool: approval.tool}});
    }

    async resume(approvalId: string, attempt = 1, jobSignal?: AbortSignal): Promise<void> {
        const approval = await getApproval(this.ctx.sql, approvalId);
        if (!approval?.runId || !approval.stepId || (approval.status !== 'approved' && approval.status !== 'rejected')) {
            return;
        }
        const run = await getRun(this.ctx.sql, approval.runId);
        const step = await getStep(this.ctx.sql, approval.runId, approval.stepId);
        if (!run || !step || TERMINAL_RUN.includes(run.status) || step.waitingApprovalId !== approvalId) {
            return; // stopped, or the step has moved on to another decision
        }
        // Claim the step for exactly this approval. A retry after a crash finds it
        // already running for the same approval and carries on.
        const claimed = await this.ctx.sql`
            update run_steps set status = 'running'
            where run_id = ${run.id} and id = ${step.id} and status = 'waiting_approval' and waiting_approval_id = ${approvalId}`;
        const recovering = claimed.count === 0 && attempt > 1 && step.status === 'running';
        if (claimed.count !== 1 && !recovering) {
            return;
        }
        const live = await updateRun(this.ctx.sql, run.id, {status: 'running'});
        await this.publishRun(live);
        const sc = await this.stepContext(run, step);
        if (!sc) {
            await this.finishStep(run, step, {status: 'failed', error: 'The agent or channel is gone.'});
            return;
        }
        const state = (step.transcript ?? {messages: [], pending: [], fileIds: []}) as StepState;
        const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
        const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
        const tier = await chooseTier(this.ctx, run.workspaceId, sc.agent, text, run.kind === 'plan' ? 'step' : 'reply', run.channelId);
        await this.drive(run, step, sc, state, {tier, needVision: false, resume: approval, jobSignal});
    }

    // ------------------------------------------------------------ run.finish

    async finish(runId: string): Promise<void> {
        const loaded = await this.load(runId);
        if (!loaded || TERMINAL_RUN.includes(loaded.run.status)) {
            return;
        }
        const {run, captain} = loaded;
        const steps = await listSteps(this.ctx.sql, runId);
        if (run.kind === 'single' || !loaded.channelOk) {
            const s = steps[0];
            const status: RunStatus = s?.status === 'succeeded' ? 'succeeded' : s?.status === 'cancelled' ? 'cancelled' : 'failed';
            const done = await updateRun(this.ctx.sql, runId, {status, resultPostId: s?.postId ?? undefined, error: s?.error ?? null});
            await this.publishRun(done);
            return;
        }
        const succeeded = steps.filter((s) => s.status === 'succeeded');
        if (!succeeded.length) {
            await this.say(run, captain, 'None of the steps finished, so I have nothing to combine. Check the errors in the plan above and try again.', run.rootPostId);
            const failed = await updateRun(this.ctx.sql, runId, {status: 'failed', error: 'every step failed'});
            await this.publishRun(failed);
            return;
        }
        const requester = await getUser(this.ctx.sql, run.requestedBy);
        const captainUser = await getUser(this.ctx.sql, captain.userId);
        if (!requester || !captainUser) {
            await this.failRun(runId, 'The requester or Captain is gone.');
            return;
        }
        const setting = await this.setting(run, requester);
        const agents = new Map((await listAgents(this.ctx.sql, run.workspaceId)).map((a) => [a.id, a]));
        const trigger = run.triggerPostId ? await getPost(this.ctx.sql, run.triggerPostId) : null;
        const results = steps.map((s) => ({title: s.title, handle: agents.get(s.agentId)?.handle ?? 'teammate', output: s.output ?? s.error ?? '', failed: s.status !== 'succeeded'}));
        const ctrl = new AbortController();
        const stop = this.watch(runId, ctrl);
        try {
            const out = await runAgent({
                ctx: this.ctx, run, stepId: 'synthesis', agent: captain, agentUser: captainUser, requester, channel: setting.channel,
                threadRoot: run.rootPostId, purpose: 'synthesis', tier: await chooseTier(this.ctx, run.workspaceId, captain, run.goal, 'synthesis', run.channelId), needVision: false,
                postType: '', postProps: {result: {runId}, ...(run.unprompted ? {joinedIn: true} : {})},
                state: {messages: [{role: 'system', content: synthesisSystem(captain, setting, run.goal, results)}, {role: 'user', content: `${requester.displayName}: ${trigger?.message ?? run.goal}`}], pending: [], fileIds: []},
                useTools: false, signal: ctrl.signal,
            });
            await addRunCost(this.ctx.sql, runId, out.costUsd);
            const done = await updateRun(this.ctx.sql, runId, {status: 'succeeded', resultPostId: out.kind === 'done' ? out.postId : undefined, error: succeeded.length < steps.length ? 'some steps did not finish' : null});
            await this.publishRun(done);
        } catch (e) {
            if (e instanceof CancelledError) {
                return;
            }
            const failed = await updateRun(this.ctx.sql, runId, {status: 'failed', error: friendlyError(e)});
            await this.publishRun(failed);
        } finally {
            stop();
        }
    }

    // ------------------------------------------------------------ cancel

    // `timeout`: nobody answered its decision in a week (see sweepDecisions).
    async cancel(runId: string, userId: string | null, reason: 'cancelled' | 'timeout' = 'cancelled'): Promise<RunRow> {
        const result = await tx(this.ctx.sql, async (t) => {
            const run = await lockRun(t, runId);
            if (!run) {
                throw notFound('Run');
            }
            if (TERMINAL_RUN.includes(run.status)) {
                return {run, expired: [] as {id: string; postId: string | null}[], ended: true};
            }
            const t0 = now();
            await t`update run_steps set status = 'cancelled', finished_at = ${t0} where run_id = ${runId} and status in ('pending', 'running', 'waiting_approval')`;
            const expired = await t`update approvals set status = 'expired', decided_at = ${t0} where run_id = ${runId} and status = 'pending' returning id, post_id`;
            const updated = await updateRun(t, runId, {status: 'cancelled'});
            return {run: updated, expired: expired.map((r) => ({id: r.id as string, postId: r.postId as string | null})), ended: false};
        });
        if (result.ended) {
            return result.run;
        }
        await this.markExpired(result.expired, reason === 'timeout');
        audit(this.ctx.sql, {workspaceId: result.run.workspaceId, userId, action: reason === 'timeout' ? 'run_expired' : 'run_cancelled', target: runId});
        await this.publishRun(result.run);
        return result.run;
    }

    // ------------------------------------------------------------ unanswered decisions

    // A decision nobody answered gets one reminder after a day: Captain
    // mentions the person who can answer, in the decision's thread. After a
    // week it expires and the work waiting on it stops.
    async sweepDecisions(at = now()): Promise<void> {
        const DAY = 86_400_000;
        const due = await this.ctx.sql`
            update approvals a set reminded_at = ${at}
            where a.status = 'pending' and a.reminded_at is null and a.created_at < ${at - DAY} and a.created_at >= ${at - DECISION_DAYS * DAY}
              and exists (select 1 from runs r where r.id = a.run_id and r.status = 'waiting_approval')
            returning a.id, a.run_id, a.post_id, a.requested_by, a.title, a.created_at`;
        for (const a of due) {
            try {
                const [loaded, person, post] = await Promise.all([
                    a.runId ? this.load(a.runId as string) : null,
                    a.requestedBy ? getUser(this.ctx.sql, a.requestedBy as string) : null,
                    a.postId ? getPost(this.ctx.sql, a.postId as string) : null,
                ]);
                if (!loaded?.channelOk || !person || !post) {
                    continue;
                }
                const left = Math.max(1, Math.ceil((Number(a.createdAt) + DECISION_DAYS * DAY - at) / DAY));
                await this.say(loaded.run, loaded.captain, `@${person.username} still waiting on your answer: **${a.title}**. It expires in ${left} ${left === 1 ? 'day' : 'days'}.`, post.rootId ?? post.id, {reminder: a.id});
            } catch (err) {
                log.warn({err: (err as Error).message, approvalId: a.id}, 'couldn\'t send a decision reminder');
            }
        }
        const cutoff = at - DECISION_DAYS * DAY;
        // Work still waiting on an old decision stops, and the decision expires with it.
        const waiting = await this.ctx.sql`
            select distinct a.run_id from approvals a join runs r on r.id = a.run_id
            where a.status = 'pending' and a.created_at < ${cutoff} and r.status not in ('succeeded', 'failed', 'cancelled')`;
        for (const r of waiting) {
            await this.cancel(r.runId as string, null, 'timeout').catch((err) => log.warn({err: (err as Error).message}, 'couldn\'t expire a decision'));
        }
        // Old decisions whose work already ended just expire.
        const orphans = await this.ctx.sql`
            update approvals a set status = 'expired', decided_at = ${at}
            where a.status = 'pending' and a.created_at < ${cutoff}
              and not exists (select 1 from runs r where r.id = a.run_id and r.status not in ('succeeded', 'failed', 'cancelled'))
            returning a.id, a.post_id`;
        await this.markExpired(orphans.map((r) => ({id: r.id as string, postId: r.postId as string | null})), true);
    }

    // Show expired decisions as expired on their cards.
    private async markExpired(list: {id: string; postId: string | null}[], timedOut: boolean): Promise<void> {
        for (const e of list) {
            if (!e.postId) {
                continue;
            }
            const post = await getPost(this.ctx.sql, e.postId);
            const card = post?.props.decision;
            if (card) {
                const row = await mergePostProps(this.ctx.sql, e.postId, {decision: {...card, status: 'expired', ...(timedOut ? {timedOut: true} : {})}});
                await postEdited(this.ctx, this.ctx.sql, row);
            }
        }
    }
}

export const DECISION_DAYS = 7;
