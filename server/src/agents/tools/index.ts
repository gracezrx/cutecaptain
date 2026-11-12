import type {AgentTool} from '../../shared/types.js';
import type {AgentRow} from '../../store/agents.js';
import type {ToolDef} from '../../llm/types.js';

import {requestApproval, sendEmail} from './actions.js';
import {useBrowser, useComputer} from './device.js';
import {createDocument, createPresentation, createSpreadsheet} from './files.js';
import {askAgent} from './handoff.js';
import type {Tool} from './types.js';
import {readUrl, webSearch} from './web.js';
import {readChannel, searchWorkspace} from './workspace.js';

export const TOOLS: Tool[] = [searchWorkspace, readChannel, webSearch, readUrl, createDocument, createPresentation, createSpreadsheet, askAgent, requestApproval, sendEmail, useComputer, useBrowser];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
    return byName.get(name);
}

// The tools an agent may use right now (configured and switched on for it).
export function toolsFor(agent: AgentRow, opts: {exclude?: string[]} = {}): Tool[] {
    return agent.tools.map((n) => byName.get(n)).filter((t): t is Tool => Boolean(t && t.available() && !opts.exclude?.includes(t.name)));
}

export function toolDefs(tools: Tool[]): ToolDef[] {
    return tools.filter((t) => !t.marker).map((t) => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}}));
}

export function toolCatalog(): AgentTool[] {
    return TOOLS.map((t) => ({name: t.name, description: t.description, external: t.external, available: t.available()}));
}
