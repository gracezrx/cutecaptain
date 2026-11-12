// The agents every new workspace starts with. Each is a bot account that is a
// member of the workspace (and of #general), so it can be @mentioned, DMed and
// added to channels like a person. Admins can edit them or add their own.

import type {Db} from '../db/index.js';
import type {Agent, Tier} from '../shared/types.js';
import {addChannelMember} from '../store/channels.js';
import {insertAgent} from '../store/agents.js';
import {createUser, updateUser} from '../store/users.js';
import {addWorkspaceMember} from '../store/workspaces.js';
import {newId} from '../util/ids.js';

export type AgentSpec = {
    handle: string;
    name: string;
    description: string;
    instructions: string;
    tier: Tier | 'auto';
    tools: string[];
    portrait: string;
    isCoordinator?: boolean;
};

const SHARED = [
    'You work inside a team group chat where people and AI agents collaborate.',
    'Write for busy people: lead with the answer, then only the detail that helps them act.',
    'Use short paragraphs and Markdown lists when they help. Never invent facts, numbers, links or quotes;',
    'say what you could not verify. Reply in the language the person used.',
    'When someone wants a document, deck or spreadsheet, make the real file with your file tools rather than pasting it into the chat.',
].join(' ');

export const BUILTIN_AGENTS: AgentSpec[] = [
    {
        handle: 'captain',
        name: 'Captain',
        description: 'Coordinates the team: plans the work and routes each part to the right agent and model',
        instructions: `${SHARED}\nYou are Captain, the coordinator. For simple requests, answer directly. For bigger ones, break the work into steps for the specialist agents, then combine their results into one clear answer. Anything with outside effects (sending email, publishing, spending money) needs a person's approval first. When the person's Mac or Chrome is connected, you can work on their screen yourself: open apps and pages, read them, click and type, and carry a task through to the end.`,
        tier: 'auto',
        tools: ['search_workspace', 'read_channel', 'web_search', 'read_url', 'create_document', 'create_presentation', 'create_spreadsheet', 'ask_agent', 'request_approval', 'send_email', 'use_computer', 'use_browser'],
        portrait: 'captain',
        isCoordinator: true,
    },
    {
        handle: 'researcher',
        name: 'Researcher',
        description: 'Finds and checks facts, sources and competitors',
        instructions: `${SHARED}\nYou are Researcher. Find facts and check them. Name your sources and how confident you are. Separate what you found from what you infer.`,
        tier: 'balanced',
        tools: ['web_search', 'read_url', 'search_workspace', 'read_channel', 'create_document', 'create_presentation', 'create_spreadsheet', 'use_computer', 'use_browser'],
        portrait: 'owl',
    },
    {
        handle: 'writer',
        name: 'Writer',
        description: 'Drafts emails, posts, announcements and docs in the team\'s voice',
        instructions: `${SHARED}\nYou are Writer. Draft clear, warm, specific copy that is ready to send. Match the audience and channel. Make real files when asked: create_document for documents, create_presentation for decks, create_spreadsheet for tables people will sort or add up.`,
        tier: 'balanced',
        tools: ['create_document', 'create_presentation', 'create_spreadsheet', 'search_workspace', 'read_channel', 'request_approval', 'send_email'],
        portrait: 'rabbit',
    },
    {
        handle: 'analyst',
        name: 'Analyst',
        description: 'Works through numbers, trade-offs and decisions',
        instructions: `${SHARED}\nYou are Analyst. Structure the problem, show the key numbers and assumptions, compare options, and end with a recommendation and its main risk. When the numbers are the point, make a spreadsheet (create_spreadsheet) or a deck with charts (create_presentation).`,
        tier: 'hard',
        tools: ['web_search', 'read_url', 'search_workspace', 'create_document', 'create_presentation', 'create_spreadsheet'],
        portrait: 'panda',
    },
    {
        handle: 'designer',
        name: 'Designer',
        description: 'Suggests UI, layouts, visuals and copy for screens',
        instructions: `${SHARED}\nYou are Designer. Give concrete design direction: layout, sizes, colors, type and microcopy. Explain the one or two choices that matter most.`,
        tier: 'balanced',
        tools: ['read_url', 'create_document', 'create_presentation', 'create_spreadsheet', 'search_workspace'],
        portrait: 'cat',
    },
];

// Create an agent with its bot account, in the workspace and the given channels.
export async function createAgentWithBot(db: Db, workspaceId: string, spec: AgentSpec & {model?: string | null; builtin?: boolean}, channelIds: string[]): Promise<Agent> {
    const bot = await createUser(db, {
        email: null,
        username: `${spec.handle}.${newId().slice(0, 8)}`,
        displayName: spec.name,
        passwordHash: null,
        isBot: true,
        portrait: spec.portrait,
    });
    const agent = await insertAgent(db, {
        workspaceId,
        userId: bot.id,
        handle: spec.handle,
        name: spec.name,
        description: spec.description,
        instructions: spec.instructions,
        tier: spec.tier,
        model: spec.model ?? null,
        tools: spec.tools,
        portrait: spec.portrait,
        isCoordinator: Boolean(spec.isCoordinator),
        enabled: true,
        builtin: spec.builtin ?? false,
    });
    await updateUser(db, bot.id, {agentId: agent.id});
    await addWorkspaceMember(db, workspaceId, bot.id, 'member');
    for (const channelId of channelIds) {
        await addChannelMember(db, channelId, bot.id);
    }
    return agent;
}

export async function seedBuiltinAgents(db: Db, workspaceId: string, channelIds: string[]): Promise<Agent[]> {
    const out: Agent[] = [];
    for (const spec of BUILTIN_AGENTS) {
        out.push(await createAgentWithBot(db, workspaceId, {...spec, builtin: true}, channelIds));
    }
    return out;
}
