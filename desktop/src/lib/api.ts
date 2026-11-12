// The Captain API client: REST calls with the session's bearer token.
// The session (server address and token) lives in a file only you can read in
// the app's settings folder on the Mac, and in local storage on the web.

import {isExtension, isTauri, LOCAL_SERVER, secretDelete, secretGet, secretSet} from './native';
import type {Agent, AgentTool, Channel, ChannelMember, ChannelUsage, McpConnections, McpServerInfo, Connections, Dashboard, Device, FileInfo, InvitePreview, ModelInfo, Post, ProviderCheck, ProviderKeyInfo, Run, Session, UsageSummary, User, Workspace, WorkspaceMember, WorkspaceRole} from './types';

export type StoredSession = {serverUrl: string; token: string; userId: string};

// The web app talks to the server it was loaded from. The Mac app and the
// Chrome extension talk to the Mac app's built-in server, or to the address
// they were built for (VITE_CAPTAIN_URL); the person can switch on the
// sign-in screen.
export const DEFAULT_SERVER = !isTauri && !isExtension && !import.meta.env.DEV ?
    location.origin :
    ((import.meta.env.VITE_CAPTAIN_URL as string | undefined) || (isTauri || isExtension ? LOCAL_SERVER : 'http://localhost:8080'));

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

let serverUrl = DEFAULT_SERVER;
let token = '';
let onUnauthorized: (() => void) | null = null;

export function normalizeServer(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
        return DEFAULT_SERVER;
    }
    if (/^https?:\/\//.test(trimmed)) {
        return trimmed;
    }
    // A server on this computer has no certificate: plain http.
    return /^(localhost|127\.0\.0\.1)(:|\/|$)/.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
}

export function getServerUrl(): string {
    return serverUrl;
}

export function getToken(): string {
    return token;
}

export function setUnauthorizedHandler(fn: () => void): void {
    onUnauthorized = fn;
}

// The session ended elsewhere (signed out, password changed): back to sign-in.
export function sessionEnded(): void {
    if (token) {
        onUnauthorized?.();
    }
}

// A file link from the server (signed, so it works in <img src>).
export function fileUrl(f: FileInfo, download = false): string {
    return `${serverUrl}${f.url}${download ? '&download=1' : ''}`;
}

export function websocketUrl(): string {
    return `${serverUrl.replace(/^http/, 'ws')}/api/v1/websocket`;
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${serverUrl}/api/v1${path}`, {
            method,
            headers: {
                ...(body !== undefined && !(body instanceof FormData) ? {'Content-Type': 'application/json'} : {}),
                ...(token ? {Authorization: `Bearer ${token}`} : {}),
            },
            body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
            ...init,
        });
    } catch {
        throw new ApiError(0, 'network', 'Can\'t reach the Captain server. Check your connection.');
    }
    const json = await res.json().catch(() => ({})) as {error?: string; message?: string};
    if (!res.ok) {
        if (res.status === 401 && token && !path.startsWith('/auth/')) {
            onUnauthorized?.();
        }
        throw new ApiError(res.status, json.error ?? 'error', json.message ?? `The server answered ${res.status}.`);
    }
    return json as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, body: unknown = {}) => request<T>('POST', p, body);
const patch = <T>(p: string, body: unknown) => request<T>('PATCH', p, body);
const put = <T>(p: string, body: unknown) => request<T>('PUT', p, body);
const del = <T>(p: string) => request<T>('DELETE', p);

// ------------------------------------------------------------ session

export async function loadSession(): Promise<StoredSession | null> {
    const raw = await secretGet('session');
    if (!raw) {
        return null;
    }
    try {
        const s = JSON.parse(raw) as StoredSession;
        serverUrl = s.serverUrl;
        token = s.token;
        return s;
    } catch {
        return null;
    }
}

async function keep(server: string, s: Session): Promise<StoredSession> {
    const stored = {serverUrl: server, token: s.token, userId: s.user.id};
    serverUrl = server;
    token = s.token;
    await secretSet('session', JSON.stringify(stored));
    return stored;
}

export async function signIn(server: string, login: string, password: string): Promise<StoredSession> {
    serverUrl = normalizeServer(server);
    token = '';
    return keep(serverUrl, await post<Session>('/auth/login', {login, password}));
}

export async function signUp(server: string, input: {name: string; email: string; password: string; workspaceName?: string; invite?: string}): Promise<StoredSession> {
    serverUrl = normalizeServer(server);
    token = '';
    return keep(serverUrl, await post<Session>('/auth/signup', input));
}

async function publicPost<T>(server: string, path: string, body: unknown): Promise<T> {
    serverUrl = normalizeServer(server);
    token = '';
    return post<T>(path, body);
}

export async function requestPasswordReset(server: string, email: string): Promise<void> {
    await publicPost(server, '/auth/password-reset', {email});
}

export async function confirmPasswordReset(server: string, resetToken: string, password: string): Promise<StoredSession> {
    const s = await publicPost<Session>(server, '/auth/password-reset/confirm', {token: resetToken, password});
    return keep(serverUrl, s);
}

export async function signOut(): Promise<void> {
    await post('/auth/logout').catch(() => undefined);
    token = '';
    await secretDelete('session');
}

export async function serverConfig(server = serverUrl): Promise<{openSignup: boolean; emailEnabled: boolean; demoMode: boolean; version: string}> {
    const res = await fetch(`${normalizeServer(server)}/api/v1/config`).catch(() => null);
    if (!res?.ok) {
        throw new ApiError(0, 'network', 'Can\'t reach that server.');
    }
    return res.json();
}

export async function invitePreview(server: string, inviteToken: string): Promise<InvitePreview> {
    const res = await fetch(`${normalizeServer(server)}/api/v1/invites/${encodeURIComponent(inviteToken)}`).catch(() => null);
    if (!res?.ok) {
        return {workspaceName: '', role: 'member', valid: false};
    }
    return res.json();
}

// ------------------------------------------------------------ endpoints

export const api = {
    me: () => get<User>('/users/me'),
    updateMe: (displayName: string) => patch<User>('/users/me', {displayName}),
    changePassword: (current: string, next: string) => post('/users/me/password', {current, next}),
    users: (ids: string[]) => get<User[]>(`/users?ids=${ids.map(encodeURIComponent).join(',')}`),

    workspaces: () => get<Workspace[]>('/workspaces'),
    createWorkspace: (name: string) => post<Workspace>('/workspaces', {name}),
    updateWorkspace: (id: string, p: {name?: string; monthlyBudgetUsd?: number | null}) => patch<Workspace>(`/workspaces/${id}`, p),
    members: (id: string) => get<{members: WorkspaceMember[]; users: User[]}>(`/workspaces/${id}/members`),
    setRole: (id: string, userId: string, role: WorkspaceRole) => patch(`/workspaces/${id}/members/${userId}`, {role}),
    removeMember: (id: string, userId: string) => del(`/workspaces/${id}/members/${userId}`),
    resetLink: (id: string, userId: string) => post<{url: string; expiresAt: number}>(`/workspaces/${id}/members/${userId}/reset-link`),
    createInvite: (id: string, p: {role?: WorkspaceRole; maxUses?: number | null; expiresInDays?: number | null}) => post<{url: string; token: string; id: string}>(`/workspaces/${id}/invites`, p),
    acceptInvite: (inviteToken: string) => post<Workspace>(`/invites/${encodeURIComponent(inviteToken)}/accept`),

    channels: (wsId: string) => get<{channels: Channel[]; members: ChannelMember[]}>(`/workspaces/${wsId}/channels`),
    browseChannels: (wsId: string) => get<Channel[]>(`/workspaces/${wsId}/channels/browse`),
    createChannel: (wsId: string, p: {displayName: string; purpose?: string; type?: 'O' | 'P'; memberIds?: string[]}) => post<Channel>(`/workspaces/${wsId}/channels`, p),
    directMessage: (wsId: string, userId: string) => post<Channel>(`/workspaces/${wsId}/dms`, {userId}),
    channel: (id: string) => get<Channel>(`/channels/${id}`),
    updateChannel: (id: string, p: {displayName?: string; purpose?: string; captainJoinsIn?: boolean}) => patch<Channel>(`/channels/${id}`, p),
    archiveChannel: (id: string) => del(`/channels/${id}`),
    joinChannel: (id: string) => post<Channel>(`/channels/${id}/join`),
    leaveChannel: (id: string) => post(`/channels/${id}/leave`),
    channelMembers: (id: string) => get<ChannelMember[]>(`/channels/${id}/members`),
    addChannelMembers: (id: string, userIds: string[]) => post(`/channels/${id}/members`, {userIds}),
    viewChannel: (id: string) => post(`/channels/${id}/view`),
    channelRuns: (id: string) => get<Run[]>(`/channels/${id}/runs`),
    channelUsage: (id: string) => get<ChannelUsage>(`/channels/${id}/usage?tz=${new Date().getTimezoneOffset()}`),

    posts: (channelId: string, before?: number) => get<Post[]>(`/channels/${channelId}/posts?limit=60${before ? `&before=${before}` : ''}`),
    post: (id: string) => get<Post>(`/posts/${id}`),
    thread: (id: string) => get<Post[]>(`/posts/${id}/thread`),
    createPost: (channelId: string, p: {message: string; rootId?: string | null; fileIds?: string[]; pendingId?: string}) => post<Post>(`/channels/${channelId}/posts`, p),
    editPost: (id: string, message: string) => patch<Post>(`/posts/${id}`, {message}),
    deletePost: (id: string) => del(`/posts/${id}`),
    react: (id: string, emoji: string) => post(`/posts/${id}/reactions`, {emoji}),
    unreact: (id: string, emoji: string) => del(`/posts/${id}/reactions/${encodeURIComponent(emoji)}`),
    postAction: (id: string, action: string, body: {note?: string} = {}) => post<Post>(`/posts/${id}/actions/${action}`, body),
    search: (wsId: string, q: string) => get<Post[]>(`/workspaces/${wsId}/search?q=${encodeURIComponent(q)}`),
    upload: (channelId: string, file: Blob, name: string) => {
        const form = new FormData();
        form.append('file', file, name);
        return request<FileInfo>('POST', `/channels/${channelId}/files`, form);
    },

    agents: (wsId: string) => get<{agents: Agent[]; tools: AgentTool[]}>(`/workspaces/${wsId}/agents`),
    createAgent: (wsId: string, p: Partial<Agent> & {handle: string; name: string; instructions: string}) => post<Agent>(`/workspaces/${wsId}/agents`, p),
    updateAgent: (id: string, p: Partial<Agent>) => patch<Agent>(`/agents/${id}`, p),
    models: (wsId: string) => get<{models: ModelInfo[]; demoMode: boolean}>(`/workspaces/${wsId}/models`),
    // Server settings (people who run the server only)
    providers: () => get<ProviderKeyInfo[]>('/admin/providers'),
    saveProviderKey: (id: string, apiKey: string, baseUrl?: string) => put<{provider: ProviderKeyInfo; check: ProviderCheck}>(`/admin/providers/${id}`, {apiKey, ...(baseUrl ? {baseUrl} : {})}),
    removeProviderKey: (id: string) => del(`/admin/providers/${id}`),
    // Google apps through Composio (Settings → Connections).
    connections: (wsId: string) => get<Connections>(`/workspaces/${wsId}/connections`),
    connectApp: (wsId: string, toolkit: string) => post<{url: string}>(`/workspaces/${wsId}/connections/${toolkit}`),
    disconnectApp: (wsId: string, toolkit: string) => del(`/workspaces/${wsId}/connections/${toolkit}`),
    mcpServers: (wsId: string) => get<McpConnections>(`/workspaces/${wsId}/mcp`),
    addMcp: (wsId: string, body: {preset?: string; name?: string; url?: string; token?: string; authHeader?: string}) => post<{server: McpServerInfo; signInUrl: string | null}>(`/workspaces/${wsId}/mcp`, body),
    signInMcp: (wsId: string, id: string) => post<{url: string}>(`/workspaces/${wsId}/mcp/${id}/sign-in`),
    verifyMcp: (wsId: string, id: string) => post<McpServerInfo>(`/workspaces/${wsId}/mcp/${id}/verify`),
    setMcpEnabled: (wsId: string, id: string, enabled: boolean) => patch<McpServerInfo>(`/workspaces/${wsId}/mcp/${id}`, {enabled}),
    removeMcp: (wsId: string, id: string) => del(`/workspaces/${wsId}/mcp/${id}`),
    saveConnectorKey: (apiKey: string) => put('/admin/connector-key', {apiKey}),
    removeConnectorKey: () => del('/admin/connector-key'),
    checkProvider: (id: string) => post<ProviderCheck>(`/admin/providers/${id}/check`),
    usage: (wsId: string) => get<UsageSummary>(`/workspaces/${wsId}/usage`),
    // tz: minutes behind UTC, so "today" and the daily chart follow your clock.
    dashboard: (wsId: string) => get<Dashboard>(`/workspaces/${wsId}/dashboard?tz=${new Date().getTimezoneOffset()}`),
    approvals: (wsId: string) => get<{id: string; channelId: string; postId: string | null; runId: string | null; title: string; requestedBy: string | null; createdAt: number}[]>(`/workspaces/${wsId}/approvals`),
    run: (id: string) => get<Run>(`/runs/${id}`),
    cancelRun: (id: string) => post<Run>(`/runs/${id}/cancel`),
    // Your devices (this Mac, your Chrome) that agents can use.
    devices: () => get<Device[]>('/devices'),
    updateDevice: (id: string, body: {name?: string; autopilot?: boolean}) => patch<Device>(`/devices/${id}`, body),
    removeDevice: (id: string) => del(`/devices/${id}`),
    answerDevice: (id: string, requestId: string, body: {ok: boolean; result?: unknown; error?: string}) => post(`/devices/${id}/requests/${requestId}`, body),
    // "Show me": the device brings the tab or app an agent is working in forward.
    showDevice: (id: string) => post(`/devices/${id}/show`, {}),
};

export function errorMessage(e: unknown): string {
    if (e instanceof ApiError) {
        return e.message;
    }
    if (e && typeof e === 'object' && 'message' in e && typeof (e as {message: unknown}).message === 'string') {
        return (e as {message: string}).message;
    }
    return 'Something went wrong. Check your connection and try again.';
}
