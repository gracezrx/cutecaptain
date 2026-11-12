import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

import * as devices from '../app/devices.js';
import {forbidden, notFound} from '../util/errors.js';

import type {Api} from '../server.js';

type P = {id: string; rid: string};

const Patch = z.object({name: z.string().trim().min(1).max(80).optional(), autopilot: z.boolean().optional()});
const Result = z.object({ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(2000).optional()});

// Your devices: the Mac app and Chrome extension agents can use (see app/devices.ts).
export function deviceRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;

    app.get('/devices', async (req) => devices.myDevices(ctx, req.user));

    app.patch('/devices/:id', async (req) => devices.changeDevice(ctx, req.user, (req.params as P).id, Patch.parse(req.body)));

    app.delete('/devices/:id', async (req) => {
        await devices.removeDevice(ctx, req.user, (req.params as P).id);
        return {ok: true};
    });

    // A device's answer over HTTP, for when its socket is between reconnects
    // (the socket is the usual way). Screenshots make these big.
    app.post('/devices/:id/requests/:rid', {bodyLimit: 12 * 1024 * 1024, config: {cost: 1}}, async (req) => {
        const p = req.params as P;
        const body = Result.parse(req.body);
        const [device] = await ctx.sql`select user_id, connection_id from devices where id = ${p.id}`;
        if (!device) {
            throw notFound('Device');
        }
        if (device.userId !== req.user.id) {
            throw forbidden('That device is not yours.');
        }
        // The HTTP path answers for the device's current socket.
        await ctx.devices.answered(req.user.id, (device.connectionId as string | null) ?? '', p.rid, body.ok, body.result, body.error);
        return {ok: true};
    });
}
