'use strict';

const assert = require('node:assert');
const { MillClient, MillApiError } = require('../../lib/api');
const { createFakeMill } = require('../fakeMill');

describe('MillClient', () => {
    let fake;
    beforeEach(async () => {
        fake = await createFakeMill({ delayMs: 20 });
    });
    afterEach(async () => {
        await fake.close();
    });

    it('reads /status', async () => {
        const st = await new MillClient({ host: fake.host }).get('status');
        assert.strictEqual(st.name, 'Mill HeaterGen3Socket');
        assert.strictEqual(st.status, 'ok');
    });

    it('sends a JSON body with GET (set-temperature)', async () => {
        const r = await new MillClient({ host: fake.host }).get('set-temperature', { type: 'Comfort' });
        assert.strictEqual(r.value, 22);
        assert.strictEqual(fake.state.requests[0].body, '{"type":"Comfort"}');
    });

    it('serialises parallel requests (the device handles one at a time)', async () => {
        const c = new MillClient({ host: fake.host });
        await Promise.all([c.get('status'), c.get('control-status'), c.get('child-lock'), c.get('display-unit')]);
        assert.strictEqual(fake.state.maxConcurrent, 1);
    });

    it('reports 404 with httpStatus', async () => {
        await assert.rejects(new MillClient({ host: fake.host }).get('oil-heater-power'), e => {
            assert.ok(e instanceof MillApiError);
            assert.strictEqual(e.httpStatus, 404);
            return true;
        });
    });

    it('a failed request does not block the queue', async () => {
        const c = new MillClient({ host: fake.host });
        const a = c.get('pid-parameters').catch(e => e);
        const b = c.get('status');
        assert.ok((await a) instanceof MillApiError);
        assert.strictEqual((await b).status, 'ok');
    });

    it('times out', async () => {
        const slow = await createFakeMill({ delayMs: 500 });
        await assert.rejects(new MillClient({ host: slow.host, timeoutMs: 100 }).get('status'), e => e.code === 'TIMEOUT');
        await slow.close();
    });

    it('fails with NETWORK when nothing listens', async () => {
        await assert.rejects(new MillClient({ host: '127.0.0.1:1', timeoutMs: 500 }).get('status'), e => e.code === 'NETWORK');
    });
    it('hard deadline ends a request whose peer trickles data', async () => {
        const http = require('node:http');
        const srv = http.createServer((q, r) => {
            r.writeHead(200);
            const iv = setInterval(() => r.write(' '), 100);
            r.on('close', () => clearInterval(iv));
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const timer = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: t => clearTimeout(t) };
        const t0 = Date.now();
        await assert.rejects(
            new MillClient({ host: `127.0.0.1:${srv.address().port}`, timeoutMs: 300, timer }).get('status'),
            e => e.code === 'TIMEOUT',
        );
        assert.ok(Date.now() - t0 < 3000);
        srv.closeAllConnections();
        await new Promise(r => srv.close(r));
    });
});
