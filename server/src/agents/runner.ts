// One agent doing one piece of work: call a model through the router, use
// tools, stream its reply into a message, and stop for approval before any
// action with outside effects. Its transcript is returned on a pause so the
// work resumes exactly where it stopped once a person decides.

import type {Ctx} from '../app/context.js';
import {postEdited} from '../app/events.js';
import {savePost} from '../app/posts.js';
import {config} from '../config.js';
import type {Purpose} from '../llm/router.js';
import {type ChatMessage, type ContentPart, LlmError, type ToolCall} from '../llm/types.js';
import type {DecisionCard, ModelAttribution, PostProps, PostType, Tier} from '../shared/types.js';
import type {AgentRow} from '../store/agents.js';
import {type ChannelRow, listChannelMemberIds} from '../store/channels.js';
import {attachFiles} from '../store/files.js';
import {getPost, softDeletePost, updatePost} from '../store/posts.js';
import {type ApprovalRow, claimApprovalExecution, createApproval, getApproval, type RunRow, setApprovalPost, setApprovalResult} from '../store/runs.js';
import type {UserRow} from '../store/users.js';
import {AppError} from '../util/errors.js';
import {log} from '../util/log.js';

import {withoutImageData} from './history.js';
import {mcpTools} from '../connectors/mcp/tools.js';
import {connectorTools} from '../connectors/tools.js';

import {routeGuide} from './playbooks.js';
import {deviceGuide} from './prompts.js';
import {deviceTools, GATE_CAPABILITY, isDeviceTool} from './tools/device.js';
import {getTool, toolDefs, toolsFor} from './tools/index.js';
import {linksIn} from './tools/web.js';
import type {ApprovalText, Tool, ToolContext, ToolResult} from './tools/types.js';

export type StepState = {messages: ChatMessage[]; pending: ToolCall[]; fileIds: string[]};

export type RunnerInput = {
    ctx: Ctx;
    run: RunRow;
    stepId: string;
    agent: AgentRow;
    agentUser: UserRow;
    requester: UserRow;
    channel: ChannelRow;
    threadRoot: string | null;
    purpose: Purpose;
    tier: Tier;
    needVision: boolean;
    postType: PostType;
    postProps: PostProps;
    state: StepState;
    useTools: boolean;
    signal: AbortSignal;
    resume?: ApprovalRow; // continue after this approval was decided
    onPost?: (postId: string) => Promise<void>;
};

export type RunnerOutcome =
    | {kind: 'done'; text: string; postId: string; fileIds: string[]; costUsd: number; modelId: string | null}
    | {kind: 'waiting'; approvalId: string; state: StepState; costUsd: number; modelId: string | null};

export class CancelledError extends Error {
    constructor() {
        super('cancelled');
    }
}

const ACTIVITY: Record<string, (args: Record<string, unknown>) => string> = {
    web_search: (a) => `Searching the web for "${String(a.query ?? '').slice(0, 60)}"`,
    read_url: (a) => `Reading ${String(a.url ?? 'a page').slice(0, 80)}`,
    search_workspace: (a) => `Searching messages for "${String(a.query ?? '').slice(0, 60)}"`,
    read_channel: (a) => `Reading ${String(a.channel ?? 'the chat').replace(/^#/, '')}`,
    ask_agent: (a) => `Asking @${String(a.agent ?? 'a teammate').replace(/^@/, '')}`,
};

// The provider's own words, short: "(OpenRouter said: Rate limit exceeded)".
function providerReason(message: string): string {
    const last = message.replace(/^Every model we tried failed\. Last error: /, '');
    const inner = last.match(/"message"\s*:\s*"([^"]{3,200})"/)?.[1] ?? last.replace(/^provider (answered \d+|error): /, '');
    const short = inner.replace(/\s+/g, ' ').trim().slice(0, 160);
    return short ? ` (The model provider said: ${short})` : '';
}

export function friendlyError(e: unknown): string {
    if (e instanceof AppError) {
        return e.message;
    }
    if (e instanceof LlmError) {
        if ((e.status === 0 && /set up/.test(e.message)) || e.status === 402) {
            return e.message;
        }
        return `The AI models didn't respond properly. Try again in a minute.${providerReason(e.message)}`;
    }
    return 'Something went wrong on our side. Try again.';
}

export async function runAgent(input: RunnerInput): Promise<RunnerOutcome> {
    const {ctx, run, agent, agentUser, channel, requester} = input;
    const state: StepState = {messages: [...input.state.messages], pending: [...input.state.pending], fileIds: [...input.state.fileIds]};
    // Its own tools, plus the Google apps and MCP servers the person it works
    // for connected, plus their Mac and Chrome while those are online.
    const [google, mcp, device] = input.useTools ?
        await Promise.all([connectorTools(ctx, requester, channel.workspaceId), mcpTools(ctx, requester, channel.workspaceId), deviceTools(ctx, requester, agent, run.id)]) :
        [[], [], {tools: [], devices: []}];
    const tools = [...(input.useTools ? toolsFor(agent) : []).filter((t) => !t.marker), ...google, ...mcp, ...device.tools];
    const allowed = new Set(tools.map((t) => t.name));
    const byName = new Map(tools.map((t) => [t.name, t]));
    const lookup = (name: string): Tool | undefined => byName.get(name) ?? getTool(name);
    let costUsd = 0;
    let model: ModelAttribution | null = null;
    // Screenshots make the rest of the step a vision job.
    let needVision = input.needVision;
    // Images that tools returned since the model last looked.
    let freshImages: string[] = [];

    // Working on a screen takes many small steps; plain tool use takes few.
    const rounds = Math.max(1, device.tools.length ? config.agents.maxComputerRounds : config.agents.maxToolRounds);
    if (device.tools.length) {
        const route = {tools: allowed, chrome: device.devices.some((d) => d.kind === 'chrome'), mac: device.devices.some((d) => d.kind === 'mac')};
        addDeviceGuide(state.messages, deviceGuide(device.devices.map((d) => ({kind: d.kind, name: d.name, gated: d.capabilities.includes(GATE_CAPABILITY)})), requester.displayName) + routeGuide(route, requestText(state.messages)));
    }

    // The reply message, created up front so people see the agent working.
    let postId: string | null = null;
    let shown = '';
    let lastSent = 0;
    let timer: NodeJS.Timeout | null = null;

    const ensurePost = async (): Promise<string> => {
        if (!postId) {
            const post = await savePost(ctx, agentUser, channel, {message: '', rootId: input.threadRoot, type: input.postType, props: {...input.postProps, streaming: true}});
            postId = post.id;
            await input.onPost?.(post.id);
        }
        return postId;
    };
    // Partial text goes to the channel's members as droppable events, at most every 120 ms.
    let audience: string[] | null = null;
    const stream = (text: string) => {
        shown = text;
        if (!postId || !audience) {
            return;
        }
        const send = () => {
            timer = null;
            lastSent = Date.now();
            ctx.hub.publish(audience!, {event: 'post_stream', data: {postId: postId!, channelId: channel.id, text: shown}}, {droppable: true});
        };
        const wait = 120 - (Date.now() - lastSent);
        if (wait <= 0) {
            send();
        } else if (!timer) {
            timer = setTimeout(send, wait);
        }
    };

    const finalize = async (text: string, extra: PostProps = {}): Promise<string> => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const id = await ensurePost();
        const current = await getPost(ctx.sql, id);
        const props: PostProps = {...(current?.props ?? {}), ...input.postProps, ...extra, streaming: false};
        if (model) {
            props.model = model;
        }
        const fileIds = [...new Set([...(current?.fileIds ?? []), ...state.fileIds])];
        const row = await updatePost(ctx.sql, id, {message: text, props, fileIds});
        await attachFiles(ctx.sql, state.fileIds, id);
        await postEdited(ctx, ctx.sql, row);
        return id;
    };

    const dropPost = async () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!postId) {
            return;
        }
        const id = postId;
        postId = null;
        await softDeletePost(ctx.sql, id);
        ctx.hub.publish(audience ?? [], {event: 'post_deleted', data: {postId: id, channelId: channel.id}});
    };

    // Links a person shared, or a web search returned, in this conversation.
    const trustedLinks = (): Set<string> => {
        const callNames = new Map<string, string>();
        for (const m of state.messages) {
            if (m.role === 'assistant') {
                for (const c of m.tool_calls ?? []) {
                    callNames.set(c.id, c.function.name);
                }
            }
        }
        const texts: string[] = [];
        for (const m of state.messages) {
            if (m.role === 'user') {
                texts.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
            } else if (m.role === 'tool' && callNames.get(m.tool_call_id) === 'web_search') {
                texts.push(m.content);
            }
        }
        return linksIn(texts.join('\n'));
    };

    const toolContext = (): ToolContext => ({ctx, agent, agentUser, requester, channel, run, stepId: input.stepId, threadRoot: input.threadRoot, signal: input.signal, trustedLinks});

    // Ask a person before an action with outside effects. Returns the approval.
    // `text` comes from a tool that found, while running, that it must ask.
    const askApproval = async (tool: Tool, call: ToolCall, args: Record<string, unknown>, text?: ApprovalText): Promise<ApprovalRow> => {
        const d = text ?? tool.describe?.(args) ?? {title: `Run ${tool.name}`, reason: '', fields: []};
        const approval = await createApproval(ctx.sql, {
            workspaceId: channel.workspaceId, channelId: channel.id, runId: run.id, stepId: input.stepId, agentId: agent.id,
            tool: tool.name, args, toolCallId: call.id, title: d.title, reason: d.reason, fields: d.fields, requestedBy: requester.id,
        });
        const card: DecisionCard = {
            approvalId: approval.id, runId: run.id, title: d.title, reason: d.reason, fields: d.fields, tool: tool.name, requestedBy: requester.id, status: 'pending', decidedBy: null, decidedAt: null,
            ...(d.kind ? {kind: d.kind} : {}), ...(d.deviceId ? {deviceId: d.deviceId} : {}),
        };
        const post = await savePost(ctx, agentUser, channel, {
            message: d.kind === 'handover' ? `@${requester.username}, your turn: ${d.title.replace(/^Your turn:\s*/i, '')}` : `@${requester.username} needs to approve: ${d.title}`,
            rootId: input.threadRoot,
            type: 'decision',
            props: {decision: card},
        });
        await setApprovalPost(ctx.sql, approval.id, post.id);
        return approval;
    };

    // A tool's answer, or (`ask`) its request to have a person approve first.
    const runTool = async (tool: Tool, args: Record<string, unknown>): Promise<{content: string; ask?: ToolResult['ask']}> => {
        try {
            const res = await tool.run(toolContext(), args);
            if (res.ask) {
                return {content: res.content, ask: res.ask};
            }
            state.fileIds.push(...(res.fileIds ?? []));
            if (res.images?.length) {
                freshImages.push(...res.images);
                needVision = true;
            }
            return {content: res.content.slice(0, isDeviceTool(tool.name) ? 60_000 : 20_000)};
        } catch (e) {
            if (input.signal.aborted) {
                throw new CancelledError();
            }
            log.info({tool: tool.name, err: (e as Error).message}, 'tool failed');
            return {content: `The ${tool.name} tool failed: ${(e as Error).message.slice(0, 500)}`};
        }
    };

    // Work through the tool calls of the last model turn. Stops at the first
    // one that needs a person, leaving the rest for after the decision.
    const processPending = async (): Promise<ApprovalRow | null> => {
        while (state.pending.length) {
            const call = state.pending.shift()!;
            const tool = lookup(call.function.name);
            let args: Record<string, unknown> = {};
            try {
                args = modelArgs(call.function.name, JSON.parse(call.function.arguments || '{}'));
            } catch {
                state.messages.push({role: 'tool', tool_call_id: call.id, content: 'The arguments were not valid JSON. Try again.'});
                continue;
            }
            if (!tool || !allowed.has(tool.name)) {
                state.messages.push({role: 'tool', tool_call_id: call.id, content: `There is no tool called ${call.function.name} available to you.`});
                continue;
            }
            if (tool.external || tool.needsApproval?.(toolContext(), args)) {
                return askApproval(tool, call, args);
            }
            stream(`_${(ACTIVITY[tool.name] ?? tool.activity ?? (() => `Using ${tool.name}`))(args)}…_`);
            const r = await runTool(tool, args);
            if (r.ask) {
                return askApproval(tool, call, r.ask.args, r.ask);
            }
            state.messages.push({role: 'tool', tool_call_id: call.id, content: r.content});
        }
        return null;
    };

    const pause = async (approval: ApprovalRow): Promise<RunnerOutcome> => {
        if (postId) {
            if (shown && !shown.startsWith('_')) {
                await finalize(shown);
            } else {
                // Nothing was said before the request: the decision card speaks for itself.
                await dropPost();
            }
        }
        return {kind: 'waiting', approvalId: approval.id, state: {...state, messages: withoutImageData(state.messages)}, costUsd, modelId: model?.id ?? null};
    };

    try {
        audience = await listChannelMemberIds(ctx.sql, channel.id);
        await ensurePost();

        if (input.resume) {
            const a = input.resume;
            const tool = lookup(a.tool);
            const call: ToolCall = {id: a.toolCallId ?? `call_${a.id}`, type: 'function', function: {name: a.tool, arguments: JSON.stringify(a.args)}};
            let content: string;
            if (a.status === 'approved' && !tool) {
                content = `This was approved, but ${a.tool} isn't available now (the device may have gone offline), so it was not done. Tell the person, and what they can do.`;
            } else if (a.status === 'approved' && tool) {
                // At most once, even if this resume is retried after a crash.
                if (await claimApprovalExecution(ctx.sql, a.id)) {
                    stream(`_${a.title}…_`);
                    const r = await runTool(tool, a.args);
                    if (r.ask) {
                        // The device found something else to ask about (the page changed).
                        await setApprovalResult(ctx.sql, a.id, 'Not done: asked again.');
                        return pause(await askApproval(tool, call, r.ask.args, r.ask));
                    }
                    content = r.content;
                    await setApprovalResult(ctx.sql, a.id, content);
                } else {
                    content = (await getApproval(ctx.sql, a.id))?.result ?? 'This approved action was already started earlier; its result is unknown. Don\'t repeat it. Tell the person to check before trying again.';
                }
            } else if (a.note) {
                content = `The person didn't approve this as it was and asked for a change: "${a.note}". It was not done. Make that change and ask for approval again with the revised version.`;
            } else {
                content = tool?.declined ?? 'The person rejected this action, so it was not done. Don\'t try it again; say what you would do instead or ask what they want changed.';
            }
            state.messages.push({role: 'tool', tool_call_id: call.id, content});
            const next = await processPending();
            if (next) {
                return pause(next);
            }
        } else if (state.pending.length) {
            const next = await processPending();
            if (next) {
                return pause(next);
            }
        }

        for (let round = 0; ; round++) {
            if (input.signal.aborted) {
                throw new CancelledError();
            }
            const lastRound = round >= rounds;
            if (freshImages.length) {
                showImages(state.messages, freshImages);
                freshImages = [];
            }
            const res = await ctx.router.complete({
                workspaceId: channel.workspaceId,
                purpose: input.purpose,
                tier: input.tier,
                pinnedModel: agent.model,
                needVision,
                messages: state.messages,
                tools: tools.length && !lastRound ? toolDefs(tools) : undefined,
                signal: input.signal,
                onText: (t) => stream(t),
                attribution: {userId: requester.id, agentId: agent.id, runId: run.id, stepId: input.stepId, channelId: run.channelId},
            });
            costUsd += res.costUsd;
            model = {id: res.modelId, provider: res.provider, tier: res.tier, costUsd};

            if (res.toolCalls.length && !lastRound) {
                state.messages.push({role: 'assistant', content: res.text || null, tool_calls: res.toolCalls});
                state.pending = [...res.toolCalls];
                const next = await processPending();
                if (next) {
                    return pause(next);
                }
                continue;
            }
            const text = res.text.trim() || (state.fileIds.length ? 'Here it is.' : lastRound && device.tools.length ? 'I ran out of steps before finishing. Here is where I got to; tell me to go on and I\'ll pick it up from here.' : '(No answer.)');
            state.messages.push({role: 'assistant', content: text});
            const id = await finalize(text);
            return {kind: 'done', text, postId: id, fileIds: state.fileIds, costUsd, modelId: model.id};
        }
    } catch (e) {
        if (timer) {
            clearTimeout(timer);
        }
        const cancelled = e instanceof CancelledError || input.signal.aborted;
        const message = cancelled ? `${shown && !shown.startsWith('_') ? `${shown}\n\n` : ''}_Stopped._` : `I couldn't finish this: ${friendlyError(e)}`;
        if (postId) {
            await finalize(message, cancelled ? {} : {error: friendlyError(e)}).catch(() => undefined);
        }
        if (cancelled) {
            throw new CancelledError();
        }
        throw e;
    }
}

// ------------------------------------------------------------ screens in the conversation

const GUIDE_MARK = '\n## Using ';
const KEEP_IMAGES = 3;
const SCREEN_NOTE = '[The screen after your last actions, latest last. Coordinates you give are pixels in the latest image.]';
const OLD_SCREEN = '[an earlier screenshot, no longer shown]';

// What was asked, to pick the app recipes worth including: what people wrote
// (recent first) and, for a plan step, the goal and the step's instructions.
// Not the rest of the system prompt: an agent's own description ("sending
// email needs approval") would match every time.
function requestText(messages: ChatMessage[]): string {
    const text = (m: ChatMessage) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' '));
    const said = messages.filter((m) => m.role === 'user').map(text).reverse();
    const system = messages[0]?.role === 'system' ? text(messages[0]) : '';
    const step = /The overall goal: [\s\S]*?(?=\nHand back only your part)/.exec(system)?.[0] ?? '';
    return [step, ...said].join('\n').slice(0, 8000);
}

// The system prompt gets the device guide once (a resumed transcript already has it).
function addDeviceGuide(messages: ChatMessage[], guide: string): void {
    const first = messages[0];
    if (first?.role === 'system' && !first.content.includes(GUIDE_MARK)) {
        first.content += guide;
    }
}

// Tool results can only be text, so screenshots go in a user turn right after
// them. Only the last few stay in the conversation: screens are big, and old
// ones mislead.
function showImages(messages: ChatMessage[], images: string[]): void {
    let kept = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user' || !Array.isArray(m.content)) {
            continue;
        }
        m.content = m.content.map((p) => {
            if (p.type !== 'image_url') {
                return p;
            }
            kept++;
            return kept + images.length > KEEP_IMAGES ? {type: 'text', text: OLD_SCREEN} : p;
        });
    }
    messages.push({role: 'user', content: [{type: 'text', text: SCREEN_NOTE}, ...images.slice(-KEEP_IMAGES).map((url): ContentPart => ({type: 'image_url', image_url: {url}}))]});
}

// ------------------------------------------------------------ arguments from the model

// Keys only the server may set: a confirmation comes from a person's approval
// (tools/device.ts adds it when an approved call runs again), never from the
// model. Anything starting with "__" is internal.
export function modelArgs(tool: string, raw: unknown): Record<string, unknown> {
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? {...(raw as Record<string, unknown>)} : {};
    for (const k of Object.keys(args)) {
        if (k.startsWith('__') || (isDeviceTool(tool) && k === 'confirm')) {
            delete args[k];
        }
    }
    return args;
}
