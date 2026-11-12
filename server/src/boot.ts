// Assemble the server: database, migrations, model router, storage, job
// workers, real-time hub (and its cluster link), orchestration, HTTP.
// main.ts runs it; the tests build their own instances with it.

import {readFileSync} from 'node:fs';
import path from 'node:path';

import type {FastifyInstance} from 'fastify';

import {Orchestrator} from './agents/orchestrator.js';
import {useOpenRouterSearch} from './agents/tools/web.js';
import {registerTriggers} from './agents/triggers.js';
import {authenticate} from './app/auth.js';
import {type Ctx, createCtx} from './app/context.js';
import {config} from './config.js';
import {connect, type Sql} from './db/index.js';
import {migrate} from './db/migrate.js';
import {LocalStorage} from './files/storage.js';
import {JobQueue} from './jobs/queue.js';
import {Catalog} from './llm/catalog.js';
import {KeyStore} from './llm/keys.js';
import {Router} from './llm/router.js';
import {Devices} from './app/devices.js';
import {Cluster} from './realtime/cluster.js';
import {Hub} from './realtime/hub.js';
import {buildServer} from './server.js';
import {getChannelMember, listChannelMemberIds} from './store/channels.js';
import {deleteExpiredSessions} from './store/sessions.js';
import {log} from './util/log.js';

export type Instance = {app: FastifyInstance; ctx: Ctx; orchestrator: Orchestrator; stop: () => Promise<void>};

export type BootOptions = {databaseUrl?: string; workers?: boolean; filesDir?: string; catalog?: Catalog};

function version(): string {
    try {
        return JSON.parse(readFileSync(path.join(config.serverDir, 'package.json'), 'utf8')).version;
    } catch {
        return 'dev';
    }
}

export async function boot(opts: BootOptions = {}): Promise<Instance> {
    const sql: Sql = connect(opts.databaseUrl ?? config.databaseUrl);
    const applied = await migrate(sql);
    if (applied) {
        log.info({applied}, 'database migrated');
    }

    const catalog = opts.catalog ?? Catalog.load();
    const keys = new KeyStore(sql);
    await keys.load();
    catalog.useKeys(keys);
    const router = new Router(sql, catalog);
    keys.onChange = (ids) => router.resetProviders(ids);
    const storage = new LocalStorage(opts.filesDir ?? config.files.dir);
    const jobs = new JobQueue(sql, {concurrency: config.workers.concurrency, leaseSeconds: config.workers.leaseSeconds});
    const cluster = new Cluster(sql);
    const devices = new Devices(sql, cluster.nodeId);

    // The hub needs the context for typing events; the context needs the hub.
    let ctxRef: Ctx | null = null;
    const hub = new Hub({
        authenticate: async (token) => {
            const s = await authenticate(sql, token);
            return s ? {userId: s.user.id, sessionId: s.sessionId} : null;
        },
        validSessions: async (ids) => new Set((await sql`select id from sessions where id = any(${ids}) and expires_at > ${Date.now()}`).map((r) => r.id as string)),
        onTyping: async (userId, channelId, rootId, connectionId) => {
            if (!ctxRef || !(await getChannelMember(sql, channelId, userId))) {
                return;
            }
            const ids = (await listChannelMemberIds(sql, channelId)).filter((id) => id !== userId);
            ctxRef.hub.publish(ids, {event: 'typing', data: {channelId, rootId, userId}}, {droppable: true, exceptConnectionId: connectionId});
        },
        forward: (userIds, event, o) => cluster.forward(userIds, event, o),
        onDeviceRegister: (userId, connectionId, device) => devices.register(userId, connectionId, device),
        onDeviceResult: (userId, connectionId, requestId, ok, result, error) => devices.answered(userId, connectionId, requestId, ok, result, error),
        onDeviceProgress: (userId, connectionId, requestId, progress) => devices.progress(userId, connectionId, requestId, progress),
        onDeviceClosed: (connectionId) => devices.closed(connectionId),
        onDevicesAlive: (ids) => devices.alive(ids),
    });
    const ctx = createCtx({sql, hub, storage, jobs, router, keys, devices});
    ctxRef = ctx;
    devices.attach(ctx);

    const orchestrator = new Orchestrator(ctx);
    orchestrator.register();
    registerTriggers(ctx);

    const app = await buildServer({ctx, orchestrator, version: version()});

    hub.start();
    await cluster.start(hub);
    await devices.start();
    await keys.start();
    if (opts.workers ?? config.workers.enabled) {
        await jobs.start();
    }
    const housekeeping = setInterval(() => {
        void deleteExpiredSessions(sql).catch(() => undefined);
        void jobs.cleanup().catch(() => undefined);
        void orchestrator.sweepDecisions().catch((err) => log.warn({err: (err as Error).message}, 'decision sweep failed'));
    }, 3_600_000);

    // Web search with the OpenRouter key when there's no search key of its own.
    const searchModel = router.catalog.models.filter((m) => m.tier === 'easy').flatMap((m) => m.routes).find(([p]) => p === 'openrouter')?.[1] ?? 'openai/gpt-4o-mini';
    useOpenRouterSearch(() => {
        const ep = router.catalog.endpoint('openrouter');
        return ep ? {...ep, model: searchModel} : null;
    });

    if (router.demoMode) {
        log.warn('no model key yet: agents answer in demo mode. The first person to sign up can paste an OpenRouter key in Settings → Models & spend, or set OPENROUTER_API_KEY.');
    } else {
        log.info({models: router.catalog.available().map((m) => m.id)}, 'models available');
    }

    return {
        app, ctx, orchestrator,
        stop: async () => {
            clearInterval(housekeeping);
            await app.close();
            hub.stop();
            await jobs.stop();
            await cluster.stop();
            await devices.stop();
            await keys.stop();
            await sql.end({timeout: 5});
        },
    };
}
