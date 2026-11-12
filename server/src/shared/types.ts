// The API contract between the Captain server and its clients (the Mac app
// and the web app). Types only: clients import this file with `import type`.
//
// Conventions (borrowed from Mattermost): 26-character random IDs,
// timestamps in Unix milliseconds, soft deletes via deletedAt.

export type ID = string;
export type Ms = number;

export type Tier = 'easy' | 'balanced' | 'hard';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type ChannelType = 'O' | 'P' | 'D' | 'G'; // open, private, direct, group

export type User = {
    id: ID;
    username: string;
    displayName: string;
    email?: string; // only on your own profile and for admins
    isBot: boolean;
    agentId: ID | null;
    portrait: string | null; // agent portrait name, e.g. "fox"
    createdAt: Ms;
    instanceAdmin?: boolean; // only on your own profile: you run this server (model keys)
};

export type Workspace = {
    id: ID;
    name: string;
    slug: string;
    createdAt: Ms;
    role: WorkspaceRole; // your role
    monthlyBudgetUsd: number | null;
};

export type WorkspaceMember = {userId: ID; role: WorkspaceRole; joinedAt: Ms};

export type Channel = {
    id: ID;
    workspaceId: ID;
    type: ChannelType;
    name: string;
    displayName: string;
    purpose: string;
    createdBy: ID;
    createdAt: Ms;
    lastPostAt: Ms;
    totalMsgCount: number;
    captainJoinsIn: boolean; // Captain may join this group chat on its own when it can help
    memberIds?: ID[]; // filled for direct and group messages
};

export type ChannelMember = {
    channelId: ID;
    userId: ID;
    role: 'admin' | 'member';
    lastViewedAt: Ms;
    msgCount: number; // messages read; unread = channel.totalMsgCount - msgCount
    mentionCount: number;
};

export type FileInfo = {
    id: ID;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    url: string; // signed, usable in <img src> for a limited time
    props: FileProps;
};

// What a file Captain made says about itself, for its card.
export type GoogleApp = 'docs' | 'slides' | 'sheets';
export type FileProps = {
    made?: 'document' | 'presentation' | 'spreadsheet';
    words?: number;
    slides?: number;
    sheets?: number;
    rows?: number;
    google?: {app: GoogleApp; id: string; url: string; folder?: string};
    pdf?: string; // the id of the PDF copy, attached to the same message
    copyOf?: string; // this file is the PDF copy of that one: shown on its card
};

export type ModelAttribution = {id: string; provider: string; tier: Tier; costUsd: number};

export type PlanStepStatus = 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type RunStatus = 'queued' | 'planning' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export type PlanCard = {
    runId: ID;
    status: RunStatus;
    goal: string;
    steps: {id: string; title: string; agentId: ID; status: PlanStepStatus; postId: ID | null; dependsOn: string[]}[];
    coordinating?: ID[]; // the agents the person named; Captain split the work between them
};

export type DecisionCard = {
    approvalId: ID;
    runId: ID | null;
    title: string;
    reason: string;
    fields: {label: string; value: string}[];
    tool: string;
    requestedBy: ID; // the person who asked; they or an admin decide
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    decidedBy: ID | null;
    decidedAt: Ms | null;
    note?: string | null; // "Change it": what the person asked to change
    timedOut?: boolean; // expired because nobody answered in a week
    // 'handover': the agent paused for the person to do something themselves
    // (sign in, enter a code): "Done, carry on" / "Stop" instead of Approve / Decline.
    kind?: 'approval' | 'handover';
    deviceId?: ID | null; // the device to bring forward with "Show me"
};

export type PostType = '' | 'system' | 'plan' | 'decision' | 'agent_step';

export type PostProps = {
    streaming?: boolean; // an agent is still writing this message
    model?: ModelAttribution;
    plan?: PlanCard;
    decision?: DecisionCard;
    step?: {runId: ID; stepId: string; title: string};
    error?: string;
    joinedIn?: boolean; // Captain wrote this without being asked
    joinedInBecause?: string; // what Captain saw it could help with
    [key: string]: unknown;
};

export type Post = {
    id: ID;
    channelId: ID;
    workspaceId: ID;
    userId: ID;
    rootId: ID | null;
    type: PostType;
    message: string;
    props: PostProps;
    files: FileInfo[];
    createdAt: Ms;
    updatedAt: Ms;
    editedAt: Ms | null;
    deletedAt: Ms | null;
    replyCount: number;
    lastReplyAt: Ms | null;
    pendingId: string | null; // echoed back so the sender can swap its optimistic copy
    reactions: {emoji: string; userIds: ID[]}[];
};

export type AgentTool = {name: string; description: string; external: boolean; available: boolean};

export type Agent = {
    id: ID;
    workspaceId: ID;
    userId: ID; // the agent's bot account
    handle: string;
    name: string;
    description: string;
    instructions: string;
    tier: Tier | 'auto';
    model: string | null; // pin a model; null lets the router choose
    tools: string[];
    portrait: string;
    isCoordinator: boolean;
    enabled: boolean;
    builtin: boolean;
};

export type ModelInfo = {
    id: string;
    provider: string;
    label: string;
    tiers: Tier[];
    vision: boolean;
    tools: boolean;
    priceInPerM: number;
    priceOutPerM: number;
    configured: boolean; // its provider has a key
    healthy: boolean;
    lastError: string | null;
};

// A model provider as the person running the server sees it (Settings → Models).
export type ProviderKeyInfo = {
    id: string;
    label: string;
    recommended: boolean; // one key that covers every model
    source: 'settings' | 'environment' | null; // where the key in use comes from
    last4: string | null;
    unreadable: boolean; // a saved key that can't be decrypted (APP_SECRET changed)
    needsBaseUrl: boolean; // a custom gateway: needs its address too
    baseUrl: string | null;
    keysUrl: string | null; // where to get a key
    models: number; // models this key can serve
    updatedAt: Ms | null;
};

export type ProviderCheck = {ok: boolean; message: string; modelId?: string; latencyMs?: number};

// The Home dashboard: what agents are working on, what finished, and (for
// admins) how many tokens were burned.
export type ActivityRun = Run & {
    agentId: ID; // who leads it (Captain for a plan or a team)
    requestedBy: ID;
    team: ID[] | null; // agents named in the message, when Captain coordinates them
    triggerPostId: ID | null;
    tokens: number; // tokens in + out so far
};

export type TokenTotals = {tokensIn: number; tokensOut: number; usd: number; calls: number};

export type DashboardUsage = {
    today: TokenTotals; // your local day
    week: TokenTotals; // the past 7 days, today included
    month: TokenTotals; // the budget month (from the 1st, UTC)
    budgetUsd: number | null;
    daily: {day: Ms; tokens: number; usd: number}[]; // past 14 local days, oldest first; day = local midnight
    byAgent: {agentId: ID | null; tokens: number; usd: number}[]; // this month
    byChat: {channelId: ID; name: string; type: ChannelType; tokens: number; usd: number}[]; // this month, top 12
    errorsToday: number; // failed model calls (Captain retries most of them)
};

// One chat's token use (everyone in the chat sees tokens; dollars are for owners and admins).
export type ChannelUsage = {
    channelId: ID;
    today: TokenTotals;
    week: TokenTotals;
    month: TokenTotals;
    byAgent: {agentId: ID | null; tokens: number; usd: number}[]; // this month
    showsUsd: boolean;
};

export type Dashboard = {
    active: ActivityRun[]; // planning, working or waiting for a decision
    recent: ActivityRun[]; // finished in the past 7 days, newest first
    counts: {active: number; waiting: number; doneToday: number; failedToday: number; doneWeek: number};
    usage: DashboardUsage | null; // owners and admins only
};

export type UsageSummary = {
    periodStart: Ms;
    totalUsd: number;
    budgetUsd: number | null;
    calls: number;
    byModel: {modelId: string; usd: number; calls: number; tokensIn: number; tokensOut: number}[];
    byAgent: {agentId: ID | null; usd: number; calls: number}[];
    recentErrors: {at: Ms; modelId: string; provider: string; purpose: string; agentId: ID | null; error: string}[]; // failed model calls, past week
};

export type RunStep = {
    id: string;
    title: string;
    agentId: ID;
    status: PlanStepStatus;
    dependsOn: string[];
    output: string | null;
    error: string | null;
    modelId: string | null;
    costUsd: number;
    startedAt: Ms | null;
    finishedAt: Ms | null;
};

export type Run = {
    id: ID;
    workspaceId: ID;
    channelId: ID;
    rootPostId: ID | null;
    triggerPostId: ID | null; // the message that started it
    cardPostId: ID | null; // a plan's card (in a direct message, its steps go in the card's thread)
    resultPostId: ID | null; // the answer, once there is one
    status: RunStatus;
    kind: 'single' | 'plan';
    goal: string;
    steps: RunStep[];
    costUsd: number;
    error: string | null;
    createdAt: Ms;
    updatedAt: Ms;
};

export type Session = {token: string; user: User};

export type InvitePreview = {workspaceName: string; role: WorkspaceRole; valid: boolean};

// ------------------------------------------------------------ real time

export type ServerEvent =
    | {event: 'hello'; data: {connectionId: string; serverTime: Ms; replayed: boolean}}
    | {event: 'posted'; data: {post: Post; mentions: ID[]; channelType: ChannelType}}
    | {event: 'post_edited'; data: {post: Post}}
    | {event: 'post_deleted'; data: {postId: ID; channelId: ID}}
    | {event: 'post_stream'; data: {postId: ID; channelId: ID; text: string}} // droppable: full text so far
    | {event: 'typing'; data: {channelId: ID; rootId: ID | null; userId: ID}}
    | {event: 'channel_created' | 'channel_updated'; data: {channel: Channel}}
    | {event: 'channel_member_added' | 'channel_member_removed'; data: {channelId: ID; userId: ID}}
    | {event: 'channel_viewed'; data: {channelId: ID}}
    | {event: 'reaction_changed'; data: {postId: ID; channelId: ID; reactions: Post['reactions']}}
    | {event: 'run_updated'; data: {runId: ID; channelId: ID; status: RunStatus; triggerPostId: ID | null}}
    | {event: 'user_updated'; data: {user: User}}
    | {event: 'workspace_member_added'; data: {workspaceId: ID; user: User; role: WorkspaceRole}}
    // An agent asks one of your devices to do something (only that device acts on it).
    | {event: 'device_request'; data: DeviceRequest}
    // A device of yours came online, went offline, or had its settings changed.
    | {event: 'device_updated'; data: {device: Device}}
    // The run that was using a device ended or was stopped: the device can relax.
    | {event: 'device_released'; data: {deviceId: ID; runId: ID}}
    // What a device is doing right now, for the person's other screens (the
    // little Captain shows Chrome work this way). Live only, never stored.
    | {event: 'device_progress'; data: DeviceProgress}
    // "Show me": bring the tab or app an agent is working in to the front.
    | {event: 'device_show'; data: {deviceId: ID}};

export type EventName = ServerEvent['event'];
export type EventEnvelope = ServerEvent & {seq: number};

// Messages the client sends over the socket.
export type ClientMessage =
    | {action: 'auth'; seq: number; token: string; connectionId?: string; lastSeq?: number}
    | {action: 'typing'; seq: number; channelId: ID; rootId?: ID | null}
    | {action: 'ping'; seq: number}
    // This connection is a device agents can use (the Mac app, the Chrome extension).
    | {action: 'device_register'; seq: number; device: DeviceRegistration}
    // The device's answer to a device_request.
    | {action: 'device_result'; seq: number; requestId: ID; ok: boolean; result?: unknown; error?: string}
    // While working: what it's doing and a small picture of it.
    | {action: 'device_progress'; seq: number; requestId: ID; text?: string; site?: string; thumb?: string};

// ------------------------------------------------------------ devices
//
// A person's Mac app or Chrome extension. While it's online, agents working
// for that person can use it: see the screen, click and type (a Mac), or
// read and drive web pages (Chrome). Each action is a request the device
// answers over its socket.

export type DeviceKind = 'mac' | 'chrome';

export type DeviceRegistration = {
    id: ID | null; // the id this device was given before, so its settings stick
    kind: DeviceKind;
    name: string; // "Grace's MacBook Pro", "Chrome"
    capabilities: string[]; // tool names it answers, e.g. computer_screenshot
};

export type Device = {
    id: ID;
    kind: DeviceKind;
    name: string;
    capabilities: string[];
    online: boolean;
    autopilot: boolean; // agents may use it without asking first each task
    lastSeenAt: Ms;
    createdAt: Ms;
};

export type DeviceRequest = {
    id: ID;
    deviceId: ID;
    runId: ID | null;
    stepId: ID | null;
    tool: string; // computer_click, browser_navigate, …
    args: Record<string, unknown>;
    deadline: Ms; // answer by then, or the agent is told it timed out
};

// What a device sends back for a request. `images` are data URLs the model
// sees (screenshots); `text` is what it reads.
//
// A device stops short of anything that sends, pays, posts or deletes and
// answers `needsConfirm` instead; the server turns that into an approval
// card and, once approved, sends the same request again with
// `args.confirm` set to `target`. `needsPerson` says only a person can go on
// (a password, a code, a CAPTCHA).
export type DeviceResult = {
    text?: string;
    images?: string[];
    needsConfirm?: DeviceConfirm;
    needsPerson?: string;
    thumb?: string; // a small JPEG of where it's working, for the little Captain
};

export type DeviceConfirm = {
    action: string; // 'Click "Send"'
    target: string; // what the device will check again before acting
    site?: string; // 'mail.google.com', 'Mail'
    details?: {label: string; value: string}[]; // To, Subject, the start of the body…
};

export type DeviceProgress = {
    deviceId: ID;
    kind: DeviceKind;
    runId: ID | null;
    text: string; // 'Typing in "Subject"'
    site?: string; // 'Gmail', 'mail.google.com'
    thumb?: string; // data:image/jpeg;base64,… (small)
    background?: boolean; // in a tab you're not looking at
    at: Ms;
};

export type ApiError = {error: string; message: string; status: number};

// Settings → Connections: your Google apps (through Composio), per workspace.
export type ConnectionApp = {
    toolkit: string; // gmail, googledrive, googledocs, googlesheets, googlecalendar, googleslides
    name: string;
    status: 'connected' | 'pending' | 'expired' | 'not_connected';
    writes: boolean; // has actions that send or change something (they ask first)
};

// MCP servers you connected (Settings → Connections).
export type McpServerInfo = {
    id: ID;
    preset: string | null; // granola, notion, linear; null for one added by address
    name: string;
    url: string; // without its query string
    status: 'connected' | 'needs_sign_in' | 'error' | 'unverified';
    lastError: string | null;
    authMode: 'none' | 'token' | 'oauth';
    tools: {name: string; reads: boolean}[];
    enabled: boolean;
    verifiedAt: Ms | null;
};

export type McpConnections = {
    presets: {id: string; name: string; description: string}[];
    servers: McpServerInfo[];
};

export type Connections = {
    configured: boolean; // the server has a Composio key
    canSetUp: boolean; // you run the server, so you can add or change the key
    key: {source: 'settings' | 'environment' | null; last4: string | null} | null; // for server admins
    apps: ConnectionApp[];
    error: string | null; // Composio couldn't be reached just now
};
