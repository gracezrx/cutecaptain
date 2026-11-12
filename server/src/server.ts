// The HTTP and WebSocket server: REST API under /api/v1, the real-time
// socket at /api/v1/websocket, and the web app at /.

import fs from 'node:fs';
import path from 'node:path';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, {type FastifyInstance, LogController} from 'fastify';
import {ZodError} from 'zod';

import type {Orchestrator} from './agents/orchestrator.js';
import {adminRoutes} from './api/admin.js';
import {connectionRoutes} from './api/connections.js';
import {deviceRoutes} from './api/devices.js';
import {donePage} from './app/connections.js';
import {callbackPage, startPage} from './app/mcp.js';
import {authRoutes} from './api/auth.js';
import {chatRoutes} from './api/chat.js';
import {RateLimiter} from './api/ratelimit.js';
import {workspaceRoutes} from './api/workspaces.js';
import {authenticate} from './app/auth.js';
import type {Ctx} from './app/context.js';
import {config} from './config.js';
import type {UserRow} from './store/users.js';
import {AppError, tooMany, unauthorized} from './util/errors.js';
import {log} from './util/log.js';

declare module 'fastify' {
    interface FastifyRequest {
        user: UserRow;
        sessionId: string;
        token: string;
    }
    interface FastifyContextConfig {
        public?: boolean; // no session needed
        auth?: boolean; // sign-in style route: stricter rate limit per IP
        cost?: number; // rate-limit tokens this route uses
    }
}

export type Api = {ctx: Ctx; orchestrator: Orchestrator; version: string};

export function bearer(header: unknown): string {
    const v = typeof header === 'string' ? header : '';
    return v.startsWith('Bearer ') ? v.slice(7).trim() : '';
}

export async function buildServer(api: Api): Promise<FastifyInstance> {
    const {ctx} = api;
    const app = Fastify({
        loggerInstance: log,
        logController: new LogController({disableRequestLogging: !config.production}),
        trustProxy: typeof config.trustProxy === 'number' ? ((_addr: string, hop: number) => hop < (config.trustProxy as number)) : config.trustProxy,
        bodyLimit: 1024 * 1024,
        routerOptions: {maxParamLength: 300},
    });

    await app.register(cors, {
        origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin) || origin === config.publicUrl),
        credentials: false,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        maxAge: 600,
    });
    await app.register(multipart, {limits: {fileSize: config.files.maxBytes + 1, files: 1, fields: 5}});
    // Devices answer over the socket, screenshots included.
    await app.register(websocket, {options: {maxPayload: 12 * 1024 * 1024}});

    // Accept POSTs with a JSON content type and no body (common for action endpoints).
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', {parseAs: 'string'}, (_req, body, done) => {
        const text = String(body ?? '').trim();
        if (!text) {
            done(null, {});
            return;
        }
        try {
            done(null, JSON.parse(text));
        } catch {
            const err = new Error('The request body isn\'t valid JSON.') as Error & {statusCode: number};
            err.statusCode = 400;
            done(err, undefined);
        }
    });

    app.addHook('onSend', async (_req, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
    });

    const limiter = new RateLimiter(config.rateLimit.perMinute);
    const authLimiter = new RateLimiter(config.rateLimit.authPerMinute);

    app.setErrorHandler((err, req, reply) => {
        if (err instanceof AppError) {
            return reply.status(err.status).send({error: err.code, message: err.message, status: err.status});
        }
        if (err instanceof ZodError) {
            const issue = err.issues[0];
            const message = issue?.message && !/^(Invalid|Expected|Required)/.test(issue.message) ? issue.message : `Check ${issue?.path.join('.') || 'the request'}: ${issue?.message ?? 'invalid'}`;
            return reply.status(400).send({error: 'invalid_input', message, status: 400});
        }
        const e = err as {statusCode?: number; code?: string; message: string};
        if (e.code === '23505') {
            return reply.status(409).send({error: 'conflict', message: 'That already exists.', status: 409});
        }
        if (e.statusCode && e.statusCode < 500) {
            return reply.status(e.statusCode).send({error: e.code ?? 'bad_request', message: e.message, status: e.statusCode});
        }
        req.log.error({err}, 'request failed');
        return reply.status(500).send({error: 'internal', message: 'Something went wrong on our side. Try again.', status: 500});
    });

    await app.register(async (v1) => {
        v1.addHook('onRequest', async (req) => {
            const cfg = req.routeOptions.config;
            if (cfg.auth && !authLimiter.take(`ip:${req.ip}`)) {
                throw tooMany('Too many attempts. Wait a minute and try again.');
            }
        });
        v1.addHook('preHandler', async (req) => {
            const cfg = req.routeOptions.config;
            if (cfg.public) {
                if (!limiter.take(`ip:${req.ip}`, cfg.cost ?? 1)) {
                    throw tooMany();
                }
                return;
            }
            const token = bearer(req.headers.authorization);
            const session = token ? await authenticate(ctx.sql, token) : null;
            if (!session) {
                throw unauthorized();
            }
            if (!limiter.take(`user:${session.user.id}`, cfg.cost ?? 1)) {
                throw tooMany();
            }
            req.user = session.user;
            req.sessionId = session.sessionId;
            req.token = token;
        });

        authRoutes(v1, api);
        workspaceRoutes(v1, api);
        chatRoutes(v1, api);
        adminRoutes(v1, api);
        connectionRoutes(v1, api);
        deviceRoutes(v1, api);

        v1.get('/websocket', {websocket: true, config: {public: true}}, (socket) => {
            ctx.hub.accept(socket);
        });
    }, {prefix: '/api/v1'});

    app.get('/healthz', async () => ({ok: true}));
    // Where Composio's Google sign-in comes back to (a plain page; see app/connections.ts).
    app.get('/connections/done', async (req, reply) => reply.type('text/html').header('Cache-Control', 'no-store').send(donePage(req.query as Record<string, unknown>)));
    // An MCP server's sign-in comes back here (the state in the link is the permission).
    app.get('/mcp/oauth/callback', async (req, reply) => reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .send(await callbackPage(ctx, req.query as Record<string, unknown>, req.headers.cookie)));
    app.get('/mcp/oauth/start', async (req, reply) => {
        const r = await startPage(ctx, req.query as Record<string, unknown>);
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        if (r.redirect) {
            return reply.header('Set-Cookie', r.cookie!).redirect(r.redirect, 303);
        }
        return reply.type('text/html').send(r.html);
    });
    app.get('/readyz', async (_req, reply) => {
        try {
            await ctx.sql`select 1`;
            return {ok: true, connections: ctx.hub.connectionCount};
        } catch {
            return reply.status(503).send({ok: false});
        }
    });

    // The web app (the same React app as the Mac app), when it has been built.
    const index = path.join(config.webDist, 'index.html');
    if (fs.existsSync(index)) {
        await app.register(fastifyStatic, {root: config.webDist, prefix: '/', wildcard: true, index: ['index.html']});
        app.setNotFoundHandler((req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api/') && !path.extname(req.url.split('?')[0])) {
                return reply.type('text/html').sendFile('index.html');
            }
            return reply.status(404).send({error: 'not_found', message: 'Not found.', status: 404});
        });
    } else {
        log.warn({webDist: config.webDist}, 'web app not built; serving the API only');
        app.setNotFoundHandler((_req, reply) => reply.status(404).send({error: 'not_found', message: 'Not found.', status: 404}));
    }
    return app as unknown as FastifyInstance;
}
