// Google apps (Gmail, Drive, Docs, Sheets, Calendar, Slides) through
// Composio, ported from Captain's main web product
// (backend/services/composio_client.py, context_connector_capabilities.py,
// resource_discovery.py):
// - one Composio project key for the server: pasted in Settings →
//   Connections by a server admin (kept encrypted with the model keys), or
//   COMPOSIO_API_KEY;
// - each person connects their own Google account, app by app, scoped to the
//   workspace: the Composio user id is "<userId>:<workspaceId>", like the main
//   product's entity id;
// - sign-in goes through Composio's hosted page (Connect Link) on a
//   Composio-managed auth config, created the first time an app is connected
//   (the main product's _get_or_create_auth_config);
// - agents get the connected apps' actions as tools, with the input schema
//   Composio publishes for each (connectors/tools.ts).
// Spoken to over Composio's REST API (v3), so there's no SDK to bundle.

import {config} from '../config.js';
import type {KeyStore} from '../llm/keys.js';

export type ConnectorApp = {
    toolkit: string; // Composio's toolkit slug
    name: string;
    read: string[]; // actions that only read: run without asking
    write: string[]; // actions that send or change something: a person approves first
};

// The actions the main product uses for each app, plus the ones that write.
export const GOOGLE_APPS: ConnectorApp[] = [
    {toolkit: 'gmail', name: 'Gmail', read: ['GMAIL_FETCH_EMAILS'], write: ['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_SEND_EMAIL']},
    {toolkit: 'googledrive', name: 'Google Drive', read: ['GOOGLEDRIVE_FIND_FILE', 'GOOGLEDRIVE_LIST_FILES', 'GOOGLEDRIVE_PARSE_FILE'], write: []},
    {toolkit: 'googledocs', name: 'Google Docs', read: ['GOOGLEDOCS_SEARCH_DOCUMENTS', 'GOOGLEDOCS_GET_DOCUMENT_BY_ID'], write: []}, // new docs: create_document
    {toolkit: 'googlesheets', name: 'Google Sheets', read: ['GOOGLESHEETS_SEARCH_SPREADSHEETS', 'GOOGLESHEETS_GET_SPREADSHEET_INFO', 'GOOGLESHEETS_BATCH_GET'], write: []}, // new sheets: create_spreadsheet
    {toolkit: 'googlecalendar', name: 'Google Calendar', read: ['GOOGLECALENDAR_FIND_EVENT', 'GOOGLECALENDAR_EVENTS_LIST'], write: ['GOOGLECALENDAR_CREATE_EVENT']},
    {toolkit: 'googleslides', name: 'Google Slides', read: ['GOOGLESLIDES_PRESENTATIONS_GET'], write: []}, // new decks: create_presentation
];

// An action on someone's own account (sending from their Gmail, changing
// their Notion through MCP…): only they may approve it, not a workspace admin.
export function onOwnAccount(toolName: string): boolean {
    return toolName.startsWith('mcp_') || onOwnDevice(toolName) || GOOGLE_APPS.some((a) => [...a.read, ...a.write].some((s) => s.toLowerCase() === toolName));
}

// Their own Mac or Chrome (agents/tools/device.ts): only they decide, never an admin.
export function onOwnDevice(toolName: string): boolean {
    return toolName.startsWith('computer_') || toolName.startsWith('browser_') || toolName === 'screen_task' || toolName === 'hand_over';
}

export function appFor(toolkit: string): ConnectorApp | undefined {
    return GOOGLE_APPS.find((a) => a.toolkit === toolkit);
}

export function composioUserId(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`;
}

export class ComposioError extends Error {
    constructor(message: string, readonly status = 0) {
        super(message);
    }
}

export type Connection = {id: string; toolkit: string; status: string};
export type ToolSchema = {slug: string; description: string; parameters: Record<string, unknown>};

const SCHEMA_TTL_MS = 3_600_000;
const MISSING_TTL_MS = 600_000;

// Composio's input_parameters: a JSON Schema object, or (as some of its docs
// show) a map of name → {type, description, required}. Either way, a JSON
// Schema object for the model.
export function toJsonSchema(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && 'properties' in raw) {
        const {title: _title, ...rest} = raw as Record<string, unknown>;
        return {type: 'object', ...rest};
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, value] of Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>)) {
        const {required: isRequired, ...rest} = value ?? {};
        properties[name] = rest;
        if (isRequired === true) {
            required.push(name);
        }
    }
    return {type: 'object', properties, ...(required.length ? {required} : {})};
}

function messageOf(json: unknown): string {
    const j = json as {error?: unknown; message?: unknown; detail?: unknown};
    const e = j?.error as {message?: unknown} | string | undefined;
    const text = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : typeof j?.message === 'string' ? j.message : typeof j?.detail === 'string' ? j.detail : '';
    return text.slice(0, 300);
}

export class Composio {
    private authConfigs = new Map<string, string>();
    private schemas = new Map<string, {schema: ToolSchema | null; at: number}>();
    private readonly keys: KeyStore;

    constructor(keys: KeyStore) {
        this.keys = keys;
    }

    apiKey(): string | null {
        return this.keys.get('composio')?.apiKey ?? (config.connectors.composioKey || null);
    }

    keySource(): 'settings' | 'environment' | null {
        return this.keys.get('composio') ? 'settings' : config.connectors.composioKey ? 'environment' : null;
    }

    configured(): boolean {
        return Boolean(this.apiKey());
    }

    // A different key may mean a different Composio project: start over.
    forget(): void {
        this.authConfigs.clear();
        this.schemas.clear();
    }

    private async call<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
        const apiKey = key ?? this.apiKey();
        if (!apiKey) {
            throw new ComposioError('Connections aren\'t set up on this server yet: a server admin adds a Composio key in Settings → Connections.');
        }
        let res: Response;
        try {
            res = await fetch(`${config.connectors.composioBaseUrl}${path}`, {
                method,
                headers: {'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json'},
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (e) {
            throw new ComposioError(`Couldn't reach Composio: ${(e as Error).message}`);
        }
        const text = await res.text();
        let json: unknown = {};
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = {};
        }
        if (!res.ok) {
            throw new ComposioError(messageOf(json) || `Composio answered ${res.status}.`, res.status);
        }
        return json as T;
    }

    // Is this key one Composio accepts?
    async check(key: string): Promise<void> {
        await this.call('GET', '/auth_configs?limit=1', undefined, key);
    }

    // The auth config to sign in to an app with: an enabled one, preferring
    // Composio-managed; created (Composio-managed) the first time.
    async authConfigId(toolkit: string): Promise<string> {
        const cached = this.authConfigs.get(toolkit);
        if (cached) {
            return cached;
        }
        type Item = {id?: string; toolkit?: {slug?: string}; status?: string; is_composio_managed?: boolean};
        const list = await this.call<{items?: Item[]}>('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=50`);
        const usable = (list.items ?? []).filter((i) => i.id && (i.toolkit?.slug ?? toolkit).toLowerCase() === toolkit && (i.status ?? 'ENABLED').toUpperCase() !== 'DISABLED');
        let id = (usable.find((i) => i.is_composio_managed !== false) ?? usable[0])?.id;
        if (!id) {
            const created = await this.call<{auth_config?: {id?: string}}>('POST', '/auth_configs', {
                toolkit: {slug: toolkit},
                auth_config: {type: 'use_composio_managed_auth', credentials: {}, restrict_to_following_tools: []},
            });
            id = created.auth_config?.id;
        }
        if (!id) {
            throw new ComposioError(`Composio has no sign-in for ${appFor(toolkit)?.name ?? toolkit} in this project.`);
        }
        this.authConfigs.set(toolkit, id);
        return id;
    }

    // Composio's hosted sign-in page for an app; it sends the browser to
    // callbackUrl when done.
    async link(toolkit: string, userId: string, callbackUrl: string): Promise<string> {
        const authConfigId = await this.authConfigId(toolkit);
        const res = await this.call<{redirect_url?: string}>('POST', '/connected_accounts/link', {auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl});
        if (!res.redirect_url) {
            throw new ComposioError('Composio didn\'t return a sign-in page.');
        }
        return res.redirect_url;
    }

    async connections(userId: string): Promise<Connection[]> {
        type Item = {id?: string; status?: string; toolkit?: {slug?: string}; user_id?: string};
        const res = await this.call<{items?: Item[]}>('GET', `/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=100`);
        return (res.items ?? []).
            filter((i) => i.id && (!i.user_id || i.user_id === userId)).
            map((i) => ({id: i.id!, toolkit: (i.toolkit?.slug ?? '').toLowerCase(), status: (i.status ?? '').toUpperCase()}));
    }

    async disconnect(connectionId: string): Promise<void> {
        await this.call('DELETE', `/connected_accounts/${encodeURIComponent(connectionId)}`);
    }

    // An action's description and input schema, or null if Composio has no
    // such action (it's then left out).
    async schema(slug: string): Promise<ToolSchema | null> {
        const hit = this.schemas.get(slug);
        if (hit && Date.now() - hit.at < (hit.schema ? SCHEMA_TTL_MS : MISSING_TTL_MS)) {
            return hit.schema;
        }
        try {
            const t = await this.call<{description?: string; input_parameters?: unknown}>('GET', `/tools/${encodeURIComponent(slug)}`);
            const schema = {slug, description: (t.description ?? slug).slice(0, 900), parameters: toJsonSchema(t.input_parameters)};
            this.schemas.set(slug, {schema, at: Date.now()});
            return schema;
        } catch (e) {
            if (e instanceof ComposioError && (e.status === 404 || e.status === 400)) {
                this.schemas.set(slug, {schema: null, at: Date.now()});
                return null;
            }
            throw e;
        }
    }

    async execute(slug: string, userId: string, connectionId: string, args: Record<string, unknown>): Promise<{ok: boolean; data: unknown; error: string | null}> {
        const res = await this.call<{data?: unknown; error?: unknown; successful?: boolean}>('POST', `/tools/execute/${encodeURIComponent(slug)}`, {
            connected_account_id: connectionId, user_id: userId, arguments: args,
        });
        const error = typeof res.error === 'string' ? res.error : res.error ? JSON.stringify(res.error).slice(0, 500) : null;
        return {ok: res.successful !== false && !error, data: res.data ?? null, error};
    }
}
