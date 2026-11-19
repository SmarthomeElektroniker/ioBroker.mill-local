'use strict';

const assert = require('node:assert');
const { fromMillheater, summary, readMillheaterInstances } = require('../../lib/migration');

/**
 * Dummy adapter with millheater objects and states (millheater is not installed on the test system).
 *
 * @param {Record<string, object>} objects Instance objects by ID
 * @param {Record<string, unknown>} states State values by ID
 */
function dummyAdapter(objects, states) {
    return {
        async getObjectViewAsync(design, search, params) {
            assert.strictEqual(design, 'system');
            assert.strictEqual(search, 'instance');
            const rows = Object.entries(objects)
                .filter(([id]) => id >= params.startkey && id <= params.endkey)
                .map(([id, value]) => ({ id, value }));
            return { rows };
        },
        async getForeignStateAsync(id) {
            return id in states ? { val: states[id], ack: true } : null;
        },
    };
}

const OBJECTS = {
    'system.adapter.millheater.0': {
        common: { enabled: true },
        native: { host: '192.168.1.50', apiTimeout: 5, pollInterval1: 30, pollInterval2: 86400 },
    },
    'system.adapter.millheater.1': {
        common: { enabled: false },
        native: { host: 'http://192.168.1.51/', apiTimeout: 90, pollInterval1: 5, pollInterval2: 20 },
    },
    'system.adapter.millheater.2': { common: { enabled: false }, native: { host: '' } },
    // other adapters must not be read
    'system.adapter.millheaterx.0': { common: {}, native: { host: '10.0.0.1' } },
    'system.adapter.mill-local.0': { common: {}, native: { host: '10.0.0.2' } },
};
const STATES = {
    'millheater.0.status.mac_address': '94:E6:86:00:12:34',
    'millheater.0.status.custom_name': 'Bad',
    'millheater.0.status.name': 'Mill PanelHeaterGen3',
    'millheater.1.status.name': 'Mill OilHeaterGen3',
};

describe('takeover from ioBroker.millheater', () => {
    it('reads only millheater instances with MAC and name from their states', async () => {
        const list = await readMillheaterInstances(dummyAdapter(OBJECTS, STATES));
        assert.deepStrictEqual(
            list.map(i => [i.id, i.mac, i.name, i.enabled]),
            [
                ['system.adapter.millheater.0', '94:E6:86:00:12:34', 'Bad', true],
                ['system.adapter.millheater.1', '', 'Mill OilHeaterGen3', false],
                ['system.adapter.millheater.2', '', '', false],
            ],
        );
    });

    it('fills the device table and takes the intervals over within the limits', async () => {
        const list = await readMillheaterInstances(dummyAdapter(OBJECTS, STATES));
        const r = fromMillheater(list, { devices: [] });
        assert.deepStrictEqual(r.native.devices, [
            { enabled: true, name: 'Bad', ip: '192.168.1.50', mac: '94e686001234', useApiKey: false },
            { enabled: true, name: 'Mill OilHeaterGen3', ip: '192.168.1.51', mac: '', useApiKey: false },
        ]);
        assert.strictEqual(r.native.pollInterval, 30);
        assert.strictEqual(r.native.slowInterval, 86400);
        assert.strictEqual(r.native.timeout, 5);
        assert.strictEqual(r.added, 2);
        assert.deepStrictEqual(r.skipped, ['millheater.2: no host configured']);
        const text = summary(r, list.length);
        assert.match(text, /3 millheater instance\(s\): 2 new, 0 updated/);
        assert.match(text, /stop the millheater instance/);
    });

    it('updates an existing row (same MAC or IP) instead of adding a duplicate', () => {
        const current = {
            devices: [
                { enabled: true, name: 'Mine', ip: '192.168.1.99', mac: '94e686001234', useApiKey: false },
                { enabled: false, name: '', ip: '192.168.1.51', mac: '', useApiKey: false },
            ],
        };
        const r = fromMillheater(
            [
                {
                    id: 'system.adapter.millheater.0',
                    native: { host: '192.168.1.50' },
                    mac: '94-E6-86-00-12-34',
                    name: 'Bad',
                },
                { id: 'system.adapter.millheater.1', native: { host: '192.168.1.51' }, mac: '', name: 'Oil' },
            ],
            current,
        );
        assert.strictEqual(r.added, 0);
        assert.strictEqual(r.updated, 2);
        assert.deepStrictEqual(r.native.devices[0], {
            enabled: true,
            name: 'Mine',
            ip: '192.168.1.50',
            mac: '94e686001234',
            useApiKey: false,
        });
        assert.deepStrictEqual(r.native.devices[1], {
            enabled: false,
            name: 'Oil',
            ip: '192.168.1.51',
            mac: '',
            useApiKey: false,
        });
        assert.strictEqual(current.devices[0].ip, '192.168.1.99', 'input not modified');
        // no intervals configured: nothing taken over
        assert.ok(!('pollInterval' in r.native));
    });

    it('clamps intervals outside the limits of mill-local', () => {
        const r = fromMillheater(
            [
                {
                    id: 'system.adapter.millheater.0',
                    native: { host: 'x', pollInterval1: 5, pollInterval2: 20, apiTimeout: 90 },
                },
            ],
            {},
        );
        assert.deepStrictEqual([r.native.pollInterval, r.native.slowInterval, r.native.timeout], [10, 60, 30]);
    });

    it('reports when there is nothing to take over', async () => {
        const list = await readMillheaterInstances(dummyAdapter({}, {}));
        assert.deepStrictEqual(list, []);
        assert.match(summary(fromMillheater(list, {}), 0), /No ioBroker.millheater instance found/);
    });
});
