import type {Ctx} from '../../app/context.js';
import type {AgentRow} from '../../store/agents.js';
import type {ChannelRow} from '../../store/channels.js';
import type {RunRow} from '../../store/runs.js';
import type {UserRow} from '../../store/users.js';

export type ToolContext = {
    ctx: Ctx;
    agent: AgentRow;
    agentUser: UserRow; // the agent's bot account
    requester: UserRow; // the person whose message started the run: tools act with their access
    channel: ChannelRow;
    run: RunRow;
    stepId: string;
    threadRoot: string | null; // where the agent's messages go
    signal: AbortSignal;
    trustedLinks: () => Set<string>; // links people shared or a search returned in this conversation
};

// `images` are data URLs (screenshots) the model is shown after the text.
export type ToolResult = {content: string; fileIds?: string[]; images?: string[]};

export type ApprovalText = {title: string; reason: string; fields: {label: string; value: string}[]};

export type Tool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
    // Actions with outside effects pause for a person's approval first.
    external: boolean;
    // A switch on the agent (use_computer, use_browser), not a tool the model calls.
    marker?: boolean;
    // Some calls need approval depending on their arguments (e.g. a link nobody shared).
    needsApproval?: (tc: ToolContext, args: Record<string, unknown>) => boolean;
    available: () => boolean;
    run: (tc: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
    // How the approval card describes this call.
    describe?: (args: Record<string, unknown>) => ApprovalText;
    // What the agent's message says while it runs ("Looking in Gmail").
    activity?: (args: Record<string, unknown>) => string;
};

export function str(v: unknown, max = 4000): string {
    return typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max);
}
