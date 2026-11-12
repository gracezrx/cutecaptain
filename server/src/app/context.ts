import type {Sql} from '../db/index.js';
import type {Storage} from '../files/storage.js';
import type {JobQueue} from '../jobs/queue.js';
import {Composio} from '../connectors/composio.js';
import type {KeyStore} from '../llm/keys.js';
import type {Router} from '../llm/router.js';
import type {Hub} from '../realtime/hub.js';

import type {Devices} from './devices.js';
import {Hooks} from './hooks.js';

// Everything the app layer needs, passed explicitly (no globals), so tests can
// build an isolated instance against their own database.
export type Ctx = {
    sql: Sql;
    hub: Hub;
    storage: Storage;
    jobs: JobQueue;
    router: Router;
    keys: KeyStore;
    composio: Composio;
    hooks: Hooks;
    devices: Devices; // the Macs and Chromes people connected, for agents to use
};

export function createCtx(parts: Omit<Ctx, 'hooks' | 'composio'>): Ctx {
    return {...parts, composio: new Composio(parts.keys), hooks: new Hooks()};
}
