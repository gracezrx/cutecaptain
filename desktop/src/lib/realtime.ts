// Real-time events. The dashboard window owns the one WebSocket, applies each
// event to its store, sends notifications, sets the menu bar badge, and
// relays events to the panel window. In a plain browser each page opens its
// own socket.

import {plain} from '../components/Markup';
import {deviceOffline, deviceOnline, deviceRegistered, handleDeviceEvent, startDeviceLink} from './device';
import {isTauri, notify, onRelayedEvent, relayToPanel, setBadge, windowLabel} from './native';
import {Socket} from './socket';
import {agentForUser, canDecide, channelTitle, decisionOf, displayName, needsYou, useStore} from './store';
import type {Post, ServerEvent} from './types';

let socket: Socket | null = null;

export function startRealtime(): () => void {
    const owner = !isTauri || windowLabel() === 'main';
    const sendsNotifications = windowLabel() === 'main';

    if (!owner) {
        useStore.getState().setConnection('online');
        const stop = onRelayedEvent((e) => {
            const msg = e as ServerEvent | {event: 'resync'};
            if (msg.event === 'resync') {
                void resync();
            } else {
                handleEvent(msg, false);
            }
        });
        return stop;
    }

    socket = new Socket({
        onEvent: (e) => {
            handleEvent(e, sendsNotifications);
            void relayToPanel(e);
        },
        onState: (state) => {
            useStore.getState().setConnection(state);
            // This Mac registers as a device on every new connection.
            if (state === 'online') {
                void deviceOnline();
            } else {
                deviceOffline();
            }
        },
        onResync: () => {
            void resync();
            void relayToPanel({event: 'resync'});
        },
        onReply: (r) => {
            if (r.status === 'OK' && typeof r.data?.deviceId === 'string') {
                void deviceRegistered(r.data.deviceId);
            }
        },
    });
    socket.open();
    const stopDevice = startDeviceLink((m) => socket?.send(m), () => socket?.reconnect());

    let lastBadge = -1;
    const unsubscribe = useStore.subscribe((s) => {
        const count = needsYou(s).length;
        if (count !== lastBadge) {
            lastBadge = count;
            void setBadge(count);
        }
    });

    return () => {
        unsubscribe();
        stopDevice();
        socket?.close();
        socket = null;
    };
}

// Missed too much while offline: reload channels and the open chat.
async function resync(): Promise<void> {
    const s = useStore.getState();
    if (!s.workspace) {
        return;
    }
    const active = s.activeChannelId;
    const thread = s.threadRootId;
    await s.switchWorkspace(s.workspace.id);
    if (active) {
        useStore.setState({activeChannelId: active});
        await useStore.getState().loadPosts(active).catch(() => undefined);
    }
    if (thread) {
        useStore.getState().openThread(thread);
    }
}

export function sendTyping(channelId: string, rootId: string | null): void {
    socket?.typing(channelId, rootId);
}

const streamed = new Set<string>(); // agent replies we saw being written, to announce when done

function handleEvent(msg: ServerEvent, sendsNotifications: boolean): void {
    if (handleDeviceEvent(msg)) {
        return;
    }
    const store = useStore.getState();
    const me = store.me;
    switch (msg.event) {
    case 'posted': {
        const {post, mentions, channelType} = msg.data;
        const fromOthers = post.userId !== me?.id;
        const d = decisionOf(post);
        const mentionsMe = fromOthers && (mentions.includes(me?.id ?? '') || channelType === 'D' || channelType === 'G' || Boolean(d && canDecide(d, me, store.workspace)));
        const wasKnown = Boolean(store.posts[post.id]);
        store.receivePost(post, {mentionsMe});
        store.clearTyping(post.channelId, post.userId);
        if (post.props.streaming) {
            streamed.add(post.id);
        } else if (sendsNotifications && mentionsMe && !wasKnown) {
            void notifyAbout(post);
        }
        break;
    }
    case 'post_edited': {
        const {post} = msg.data;
        const before = store.posts[post.id];
        store.updatePost(post);
        // An agent finished a reply: tell the person who asked.
        if (streamed.has(post.id) && !post.props.streaming) {
            streamed.delete(post.id);
            if (sendsNotifications && before && repliesToMe(post)) {
                void notifyAbout(post);
            }
        }
        break;
    }
    case 'post_deleted':
        store.removePost(msg.data.postId);
        break;
    case 'post_stream':
        store.setStream(msg.data.postId, msg.data.text);
        break;
    case 'typing':
        if (msg.data.userId !== me?.id) {
            store.setTyping(msg.data.channelId, msg.data.userId);
        }
        break;
    case 'reaction_changed': {
        const p = store.posts[msg.data.postId];
        if (p) {
            store.updatePost({...p, reactions: msg.data.reactions});
        }
        break;
    }
    case 'channel_created':
    case 'channel_updated':
        if (msg.data.channel.workspaceId === store.workspace?.id) {
            store.addChannel(msg.data.channel);
            void store.ensureUsers(msg.data.channel.memberIds ?? []);
        }
        break;
    case 'channel_member_added':
        if (msg.data.userId === me?.id) {
            void store.ensureChannel(msg.data.channelId);
        }
        break;
    case 'channel_member_removed':
        if (msg.data.userId === me?.id) {
            store.dropChannel(msg.data.channelId);
        }
        break;
    case 'channel_viewed': {
        const c = store.channels[msg.data.channelId];
        const m = store.members[msg.data.channelId];
        if (c && m) {
            useStore.setState((s) => ({members: {...s.members, [c.id]: {...m, msgCount: c.totalMsgCount, mentionCount: 0}}}));
        }
        break;
    }
    case 'run_updated':
        useStore.setState((s) => ({
            runs: {...s.runs, [msg.data.runId]: msg.data.status},
            runByTrigger: msg.data.triggerPostId ? {...s.runByTrigger, [msg.data.triggerPostId]: msg.data.status} : s.runByTrigger,
        }));
        break;
    case 'user_updated':
        useStore.setState((s) => ({users: {...s.users, [msg.data.user.id]: {...s.users[msg.data.user.id], ...msg.data.user}}, me: s.me?.id === msg.data.user.id ? {...s.me, ...msg.data.user} : s.me}));
        break;
    case 'workspace_member_added':
        if (msg.data.workspaceId === store.workspace?.id) {
            useStore.setState((s) => ({users: {...s.users, [msg.data.user.id]: msg.data.user}}));
            if (msg.data.user.isBot) {
                void store.refreshAgents();
            }
        }
        break;
    default:
        break;
    }
}

// An agent's reply in your DM with it, or in a thread you started.
function repliesToMe(post: Post): boolean {
    const s = useStore.getState();
    const author = s.users[post.userId];
    if (!author?.isBot || !s.me) {
        return false;
    }
    const channel = s.channels[post.channelId];
    if (channel?.type === 'D') {
        return true;
    }
    const root = post.rootId ? s.posts[post.rootId] : undefined;
    return root?.userId === s.me.id;
}

async function notifyAbout(post: Post): Promise<void> {
    const s = useStore.getState();
    // Don't interrupt when the dashboard is in front showing that chat.
    if (document.hasFocus() && s.activeChannelId === post.channelId) {
        return;
    }
    await s.ensureUsers([post.userId]);
    const st = useStore.getState();
    const sender = displayName(st.users[post.userId]);
    const channel = st.channels[post.channelId];
    const where = channel && channel.type !== 'D' ? ` in ${channelTitle(channel, st.me?.id, st.users)}` : '';
    const d = decisionOf(post);
    const agent = agentForUser(st.agents, post.userId);
    const title = d ? `${sender} needs your decision${where}` : `${sender}${where}`;
    const body = d ? d.title : (plain(post.message).slice(0, 180) || (agent ? 'Replied' : 'Sent an attachment'));
    await notify(title, body, {mode: 'thread', channelId: post.channelId, postId: post.id});
}
