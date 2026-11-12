// App state: one Zustand store per window, filled from the REST API and kept
// current by real-time events (realtime.ts).

import {create} from 'zustand';

import {api, type StoredSession} from './api';
import type {Agent, Channel, ChannelMember, ClientPost, DecisionCard, ModelInfo, Post, RunStatus, User, Workspace} from './types';

export type NeedsYouItem = {channelId: string; postId?: string; kind: 'decision' | 'mention' | 'dm'; at: number};

type State = {
    session: StoredSession | null;
    me: User | null;
    workspaces: Workspace[];
    workspace: Workspace | null;
    channels: Record<string, Channel>;
    members: Record<string, ChannelMember>;
    users: Record<string, User>;
    agents: Record<string, Agent>; // by agent id
    models: ModelInfo[];
    demoMode: boolean;
    posts: Record<string, ClientPost>;
    postsByChannel: Record<string, string[]>; // oldest first, root posts and replies
    loadedChannels: Record<string, boolean>;
    hasMore: Record<string, boolean>;
    streams: Record<string, string>; // post id -> text an agent is still writing
    runs: Record<string, RunStatus>;
    runByTrigger: Record<string, RunStatus>; // the message that started a run -> its status
    typing: Record<string, {userId: string; until: number}>;
    activeChannelId: string | null;
    threadRootId: string | null; // the thread open beside the chat
    lastUsedChannelId: string | null;
    connection: 'connecting' | 'online' | 'offline';
    ready: boolean;
};

type Actions = {
    bootstrap: (session: StoredSession) => Promise<void>;
    switchWorkspace: (id: string) => Promise<void>;
    refreshAgents: () => Promise<void>;
    reset: () => void;
    loadPosts: (channelId: string) => Promise<void>;
    loadOlder: (channelId: string) => Promise<void>;
    loadThread: (rootId: string) => Promise<void>;
    ensureUsers: (ids: string[]) => Promise<void>;
    ensureChannel: (channelId: string) => Promise<void>;
    receivePost: (post: ClientPost, opts?: {mentionsMe?: boolean}) => void;
    updatePost: (post: ClientPost) => void;
    removePost: (postId: string) => void;
    mergePosts: (posts: Post[]) => void;
    setStream: (postId: string, text: string) => void;
    addChannel: (channel: Channel, member?: ChannelMember) => void;
    dropChannel: (channelId: string) => void;
    setActiveChannel: (channelId: string | null) => void;
    openThread: (rootId: string | null) => void;
    markViewed: (channelId: string) => Promise<void>;
    setTyping: (channelId: string, userId: string) => void;
    clearTyping: (channelId: string, userId: string) => void;
    setConnection: (c: State['connection']) => void;
    rememberChannel: (channelId: string) => void;
};

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // private mode: not remembered, which is fine
    }
}

const initial: State = {
    session: null,
    me: null,
    workspaces: [],
    workspace: null,
    channels: {},
    members: {},
    users: {},
    agents: {},
    models: [],
    demoMode: false,
    posts: {},
    postsByChannel: {},
    loadedChannels: {},
    hasMore: {},
    streams: {},
    runs: {},
    runByTrigger: {},
    typing: {},
    activeChannelId: null,
    threadRootId: null,
    lastUsedChannelId: read('captain.lastChannel'),
    connection: 'connecting',
    ready: false,
};

function sortIds(ids: string[], posts: Record<string, ClientPost>): string[] {
    return [...new Set(ids)].filter((id) => posts[id]).sort((a, b) => posts[a].createdAt - posts[b].createdAt);
}

export const useStore = create<State & Actions>((set, get) => ({
    ...initial,

    async bootstrap(session) {
        set({session});
        const [me, workspaces] = await Promise.all([api.me(), api.workspaces()]);
        set({me, users: {...get().users, [me.id]: me}, workspaces});
        const wanted = read('captain.workspace');
        const ws = workspaces.find((w) => w.id === wanted) ?? workspaces[0] ?? null;
        if (ws) {
            await get().switchWorkspace(ws.id);
        } else {
            set({workspace: null, ready: true});
        }
    },

    async switchWorkspace(id) {
        const ws = get().workspaces.find((w) => w.id === id) ?? (await api.workspaces()).find((w) => w.id === id);
        if (!ws) {
            return;
        }
        write('captain.workspace', id);
        const [{channels, members}, {agents}, people, models] = await Promise.all([
            api.channels(id), api.agents(id), api.members(id), api.models(id).catch(() => ({models: [], demoMode: false})),
        ]);
        const me = get().me;
        set({
            workspace: ws,
            channels: Object.fromEntries(channels.map((c) => [c.id, c])),
            members: Object.fromEntries(members.map((m) => [m.channelId, m])),
            agents: Object.fromEntries(agents.map((a) => [a.id, a])),
            users: {...Object.fromEntries(people.users.map((u) => [u.id, u])), ...(me ? {[me.id]: me} : {})},
            models: models.models,
            demoMode: models.demoMode,
            posts: {},
            postsByChannel: {},
            loadedChannels: {},
            hasMore: {},
            streams: {},
            activeChannelId: get().activeChannelId && channels.some((c) => c.id === get().activeChannelId) ? get().activeChannelId : null,
            threadRootId: null,
            ready: true,
        });
        // Decisions waiting in channels we haven't opened yet.
        const approvals = await api.approvals(id).catch(() => []);
        const posts = await Promise.all(approvals.filter((a) => a.postId).map((a) => api.post(a.postId!).catch(() => null)));
        get().mergePosts(posts.filter((p): p is Post => Boolean(p)));
    },

    async refreshAgents() {
        const ws = get().workspace;
        if (!ws) {
            return;
        }
        const [{agents}, people] = await Promise.all([api.agents(ws.id), api.members(ws.id)]);
        set((s) => ({agents: Object.fromEntries(agents.map((a) => [a.id, a])), users: {...s.users, ...Object.fromEntries(people.users.map((u) => [u.id, u]))}}));
    },

    reset() {
        set({...initial, lastUsedChannelId: get().lastUsedChannelId});
    },

    async loadPosts(channelId) {
        const list = await api.posts(channelId);
        get().mergePosts(list);
        set((s) => ({loadedChannels: {...s.loadedChannels, [channelId]: true}, hasMore: {...s.hasMore, [channelId]: list.length >= 60}}));
    },

    async loadOlder(channelId) {
        const s = get();
        const ids = s.postsByChannel[channelId] ?? [];
        const oldest = ids.map((id) => s.posts[id]).find((p) => p && !p.rootId);
        if (!oldest) {
            return;
        }
        const list = await api.posts(channelId, oldest.createdAt);
        get().mergePosts(list);
        set((st) => ({hasMore: {...st.hasMore, [channelId]: list.length >= 60}}));
    },

    async loadThread(rootId) {
        get().mergePosts(await api.thread(rootId));
    },

    async ensureUsers(ids) {
        const missing = [...new Set(ids)].filter((id) => id && !get().users[id]);
        if (!missing.length) {
            return;
        }
        const users = await api.users(missing).catch(() => []);
        set((s) => ({users: {...s.users, ...Object.fromEntries(users.map((u) => [u.id, u]))}}));
    },

    async ensureChannel(channelId) {
        if (get().channels[channelId]) {
            return;
        }
        const ws = get().workspace;
        const channel = await api.channel(channelId).catch(() => null);
        if (!channel || channel.workspaceId !== ws?.id) {
            return;
        }
        const {members} = await api.channels(ws.id);
        get().addChannel(channel, members.find((m) => m.channelId === channelId));
        await get().ensureUsers(channel.memberIds ?? []);
    },

    receivePost(post, opts = {}) {
        const s = get();
        if (post.workspaceId && s.workspace && post.workspaceId !== s.workspace.id) {
            return;
        }
        const known = Boolean(s.posts[post.id]) || Boolean(post.pendingId && s.posts[post.pendingId] && post.pendingId !== post.id && !s.posts[post.pendingId].pending);
        set((st) => {
            const all: Record<string, ClientPost> = {...st.posts, [post.id]: post};
            let ids = st.postsByChannel[post.channelId] ?? [];
            // Swap our optimistic copy for the server's.
            if (post.pendingId && post.pendingId !== post.id && st.posts[post.pendingId]) {
                delete all[post.pendingId];
                ids = ids.filter((id) => id !== post.pendingId);
            }
            const channel = st.channels[post.channelId];
            const fresh = !st.posts[post.id] && !post.pending;
            const channels = channel && fresh ? {...st.channels, [channel.id]: {...channel, lastPostAt: Math.max(channel.lastPostAt, post.createdAt), totalMsgCount: channel.totalMsgCount + 1}} : st.channels;
            let members = st.members;
            const m = st.members[post.channelId];
            if (m && fresh) {
                const viewing = st.activeChannelId === post.channelId && document.hasFocus();
                const mine = post.userId === st.me?.id;
                members = {...st.members, [m.channelId]: {
                    ...m,
                    msgCount: mine || viewing ? m.msgCount + 1 : m.msgCount,
                    mentionCount: !mine && !viewing && opts.mentionsMe ? m.mentionCount + 1 : m.mentionCount,
                }};
            }
            // A reply bumps its thread.
            if (post.rootId && all[post.rootId] && fresh) {
                const root = all[post.rootId];
                all[post.rootId] = {...root, replyCount: root.replyCount + 1, lastReplyAt: post.createdAt};
            }
            return {posts: all, postsByChannel: {...st.postsByChannel, [post.channelId]: sortIds([...ids, post.id], all)}, channels, members};
        });
        if (!known && !s.users[post.userId]) {
            void get().ensureUsers([post.userId]);
        }
        if (!s.channels[post.channelId]) {
            void get().ensureChannel(post.channelId);
        }
    },

    updatePost(post) {
        set((s) => {
            if (!s.posts[post.id]) {
                return {};
            }
            const streams = {...s.streams};
            if (!post.props.streaming) {
                delete streams[post.id];
            }
            return {posts: {...s.posts, [post.id]: {...s.posts[post.id], ...post}}, streams};
        });
    },

    removePost(postId) {
        set((s) => {
            const p = s.posts[postId];
            if (!p) {
                return {};
            }
            const all = {...s.posts};
            delete all[postId];
            if (p.rootId && all[p.rootId]) {
                all[p.rootId] = {...all[p.rootId], replyCount: Math.max(0, all[p.rootId].replyCount - 1)};
            }
            return {
                posts: all,
                postsByChannel: {...s.postsByChannel, [p.channelId]: (s.postsByChannel[p.channelId] ?? []).filter((id) => id !== postId)},
                threadRootId: s.threadRootId === postId ? null : s.threadRootId,
            };
        });
    },

    // Add fetched history without touching unread counts.
    mergePosts(list) {
        if (!list.length) {
            return;
        }
        set((s) => {
            const all = {...s.posts};
            const byChannel = {...s.postsByChannel};
            for (const p of list) {
                all[p.id] = {...all[p.id], ...p};
                byChannel[p.channelId] = [...(byChannel[p.channelId] ?? []), p.id];
            }
            for (const id of new Set(list.map((p) => p.channelId))) {
                byChannel[id] = sortIds(byChannel[id], all);
            }
            return {posts: all, postsByChannel: byChannel};
        });
        void get().ensureUsers(list.map((p) => p.userId));
    },

    setStream(postId, text) {
        set((s) => (s.posts[postId]?.props.streaming === false ? {} : {streams: {...s.streams, [postId]: text}}));
    },

    addChannel(channel, member) {
        set((s) => ({
            channels: {...s.channels, [channel.id]: channel},
            members: member ? {...s.members, [channel.id]: member} : s.members[channel.id] ? s.members : {
                ...s.members,
                [channel.id]: {channelId: channel.id, userId: s.me?.id ?? '', role: 'member', lastViewedAt: Date.now(), msgCount: channel.totalMsgCount, mentionCount: 0},
            },
        }));
    },

    dropChannel(channelId) {
        set((s) => {
            const channels = {...s.channels};
            const members = {...s.members};
            delete channels[channelId];
            delete members[channelId];
            return {channels, members, activeChannelId: s.activeChannelId === channelId ? null : s.activeChannelId};
        });
    },

    setActiveChannel(channelId) {
        set({activeChannelId: channelId, threadRootId: null});
        if (channelId) {
            get().rememberChannel(channelId);
        }
    },

    openThread(rootId) {
        set({threadRootId: rootId});
        if (rootId) {
            void get().loadThread(rootId).catch(() => undefined);
        }
    },

    async markViewed(channelId) {
        const s = get();
        const m = s.members[channelId];
        const c = s.channels[channelId];
        if (!m || !c || (m.msgCount >= c.totalMsgCount && m.mentionCount === 0)) {
            return;
        }
        set((st) => ({members: {...st.members, [channelId]: {...m, msgCount: c.totalMsgCount, mentionCount: 0, lastViewedAt: Date.now()}}}));
        await api.viewChannel(channelId).catch(() => undefined);
    },

    setTyping(channelId, userId) {
        set((s) => ({typing: {...s.typing, [channelId]: {userId, until: Date.now() + 5000}}}));
    },

    clearTyping(channelId, userId) {
        set((s) => {
            if (s.typing[channelId]?.userId !== userId) {
                return {};
            }
            const typing = {...s.typing};
            delete typing[channelId];
            return {typing};
        });
    },

    setConnection(connection) {
        set({connection});
    },

    rememberChannel(channelId) {
        write('captain.lastChannel', channelId);
        set({lastUsedChannelId: channelId});
    },
}));

// ------------------------------------------------------------ derived helpers

export function decisionOf(post: Post | undefined): DecisionCard | null {
    return post?.type === 'decision' ? post.props.decision ?? null : null;
}

export function otherUserId(channel: Channel, meId: string): string {
    if (channel.type !== 'D') {
        return '';
    }
    return channel.memberIds?.find((id) => id !== meId) ?? channel.name.split('__').find((id) => id !== meId) ?? meId;
}

export function displayName(user: User | undefined): string {
    return user ? user.displayName || user.username : 'Someone';
}

export function channelTitle(channel: Channel | undefined, meId: string | undefined, users: Record<string, User>): string {
    if (!channel) {
        return '';
    }
    if (channel.type === 'D' && meId) {
        const other = otherUserId(channel, meId);
        return other === meId ? `${displayName(users[meId])} (you)` : displayName(users[other]);
    }
    if (channel.type === 'G' && meId) {
        return (channel.memberIds ?? []).filter((id) => id !== meId).map((id) => displayName(users[id]).split(' ')[0]).join(', ') || 'Group';
    }
    return channel.displayName || channel.name;
}

export function agentForUser(agents: Record<string, Agent>, userId: string | undefined): Agent | undefined {
    return userId ? Object.values(agents).find((a) => a.userId === userId) : undefined;
}

export function isAgentChannel(channel: Channel, meId: string, users: Record<string, User>): boolean {
    return channel.type === 'D' && Boolean(users[otherUserId(channel, meId)]?.isBot);
}

export function unreadCount(channel: Channel, member: ChannelMember | undefined): number {
    return member ? Math.max(0, channel.totalMsgCount - member.msgCount) : 0;
}

// Actions on someone's own Google account (gmail_send_email…) are theirs alone to decide.
const OWN_ACCOUNT = /^(gmail|googledrive|googledocs|googlesheets|googlecalendar|googleslides)_/;
const APP_NAMES: Record<string, string> = {gmail: 'Gmail', googledrive: 'Google Drive', googledocs: 'Google Docs', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googleslides: 'Google Slides'};

// The app on the asker's own account a decision would act in, if any.
export function ownAccountApp(tool: string | undefined): string | null {
    const m = (tool ?? '').match(OWN_ACCOUNT);
    if (m) {
        return APP_NAMES[m[1]];
    }
    // Their own Mac or Chrome, which an agent is working in.
    if (/^(computer_|screen_task$)/.test(tool ?? '')) {
        return 'Mac';
    }
    if ((tool ?? '').startsWith('browser_')) {
        return 'Chrome';
    }
    if (tool === 'hand_over') {
        return 'computer';
    }
    const mcp = (tool ?? '').match(/^mcp_([a-z0-9_]+?)_/);
    return mcp ? `${mcp[1].charAt(0).toUpperCase()}${mcp[1].slice(1)} connection` : null;
}

export function canDecide(card: DecisionCard, me: User | null, workspace: Workspace | null): boolean {
    if (!me) {
        return false;
    }
    if (card.requestedBy === me.id) {
        return true;
    }
    return !ownAccountApp(card.tool) && (workspace?.role === 'owner' || workspace?.role === 'admin');
}

// What needs you: decisions you can make, mentions and unread DMs, newest first.
export function needsYou(state: Pick<State, 'channels' | 'members' | 'posts' | 'postsByChannel' | 'me' | 'workspace'>): NeedsYouItem[] {
    const items: NeedsYouItem[] = [];
    const seen = new Set<string>();
    for (const post of Object.values(state.posts)) {
        const d = decisionOf(post);
        if (d?.status === 'pending' && state.channels[post.channelId] && canDecide(d, state.me, state.workspace)) {
            items.push({channelId: post.channelId, postId: post.id, kind: 'decision', at: post.createdAt});
            seen.add(post.channelId);
        }
    }
    for (const channel of Object.values(state.channels)) {
        const m = state.members[channel.id];
        if (!m || seen.has(channel.id)) {
            continue;
        }
        const isDm = channel.type === 'D' || channel.type === 'G';
        if (m.mentionCount > 0 || (isDm && unreadCount(channel, m) > 0)) {
            const ids = state.postsByChannel[channel.id] ?? [];
            const latest = [...ids].reverse().find((id) => state.posts[id]?.userId !== state.me?.id);
            items.push({channelId: channel.id, postId: latest, kind: isDm ? 'dm' : 'mention', at: channel.lastPostAt});
        }
    }
    return items.sort((a, b) => b.at - a.at);
}

export function modelLabel(models: ModelInfo[], id: string): string {
    if (id === 'demo') {
        return 'Demo model';
    }
    return models.find((m) => m.id === id)?.label ?? id;
}
