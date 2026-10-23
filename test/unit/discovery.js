'use strict';

const assert = require('node:assert');
const { expandTargets, scan } = require('../../lib/discovery');
const { createFakeMill } = require('../fakeMill');

describe('discovery', () => {
    it('expands networks, ranges and single addresses', () => {
        assert.strictEqual(expandTargets('192.168.1.0/24').length, 254);
        assert.deepStrictEqual(expandTargets('10.0.0.5-10.0.0.7, 10.0.0.9'), ['10.0.0.5', '10.0.0.6', '10.0.0.7', '10.0.0.9']);
        assert.deepStrictEqual(expandTargets('10.0.0.8/32'), ['10.0.0.8']);
        assert.strictEqual(expandTargets('192.168.1.77/24')[0], '192.168.1.1');
    });

    it('refuses too large or invalid networks', () => {
        assert.throws(() => expandTargets('10.0.0.0/16'));
        assert.throws(() => expandTargets('300.1.1.1'));
        assert.throws(() => expandTargets('10.0.0.9-10.0.0.1'));
    });

    it('finds a Mill device and ignores other HTTP servers', async () => {
        const fake = await createFakeMill({ mac: '94:e6:86:00:00:aa' });
        const http = require('node:http');
        const other = http.createServer((q, r) => r.end('{"name":"other"}'));
        await new Promise(r => other.listen(0, '127.0.0.1', r));
        // scan works on host:port strings as well, which the tests use
        const found = await scan([fake.host, `127.0.0.1:${other.address().port}`, '127.0.0.1:1'], { timeoutMs: 500 });
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].mac, '94e6860000aa');
        await fake.close();
        await new Promise(r => other.close(r));
    });
});
