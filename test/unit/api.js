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

    // failure scenarios after the pattern of the ioBroker.millheater tests (webbummler, MIT)
    for (const [mode, code] of [
        ['invalid-json', 'PARSE'],
        ['empty', 'PARSE'],
        ['api-error', 'DEVICE'],
        ['http-error', 'HTTP'],
    ]) {
        it(`rejects an answer of the kind "${mode}" with code ${code}`, async () => {
            fake.state.responseMode = mode;
            const c = new MillClient({ host: fake.host });
            await assert.rejects(c.get('control-status'), e => e instanceof MillApiError && e.code === code);
            // the queue keeps working afterwards
            fake.state.responseMode = 'valid';
            assert.strictEqual(typeof (await c.get('control-status')).ambient_temperature, 'number');
        });
    }

    it('times out on a device that never answers, also with the adapter timers', async () => {
        fake.state.responseMode = 'hang';
        const timer = { setTimeout, clearTimeout };
        const c = new MillClient({ host: fake.host, timeoutMs: 300, timer });
        const t0 = Date.now();
        await assert.rejects(c.get('control-status'), e => e.code === 'TIMEOUT');
        assert.ok(Date.now() - t0 < 2000);
    });

    it('a write waits for the running read (one request at a time)', async () => {
        fake.state.delays['control-status'] = 300;
        const c = new MillClient({ host: fake.host });
        const read = c.get('control-status');
        const write = c.post('set-temperature', { type: 'Normal', value: 21 });
        await Promise.all([read, write]);
        assert.strictEqual(fake.state.maxConcurrent, 1);
        const order = fake.state.requests.map(r => `${r.method} ${r.path}`);
        assert.deepStrictEqual(order, ['GET control-status', 'POST set-temperature']);
        assert.strictEqual(fake.state.temps.Normal, 21);
    });

    it('close() aborts the running request and never sends the queued ones', async () => {
        fake.state.delays['control-status'] = 1500;
        const c = new MillClient({ host: fake.host });
        const read = c.get('control-status');
        const write = c.post('set-temperature', { type: 'Normal', value: 23 });
        await new Promise(r => setTimeout(r, 100));
        const t0 = Date.now();
        c.close();
        await assert.rejects(read, e => e.code === 'CANCELLED');
        await assert.rejects(write, e => e.code === 'CANCELLED');
        assert.ok(Date.now() - t0 < 500, 'does not wait for the slow answer');
        assert.ok(!fake.state.requests.some(r => r.method === 'POST'), 'queued write not sent');
        assert.strictEqual(fake.state.temps.Normal, 20);
        await assert.rejects(c.get('status'), e => e.code === 'CANCELLED');
    });
});

