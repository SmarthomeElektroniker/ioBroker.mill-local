'use strict';

const assert = require('node:assert');
const m = require('../../lib/model');

describe('model', () => {
    it('detects the device kind from the model name', () => {
        assert.strictEqual(m.kindFromName('Mill HeaterGen3Socket'), 'socket');
        assert.strictEqual(m.kindFromName('panel heater gen. 3'), 'panel');
        assert.strictEqual(m.kindFromName('Mill OilHeaterGen3'), 'oil');
        assert.strictEqual(m.kindFromName('Mill ConvectionHeaterGen3'), 'convection');
        assert.strictEqual(m.kindFromName('Mill something'), 'unknown');
    });

    it('refines an unknown kind from the probed endpoints', () => {
        assert.strictEqual(m.refineKind('unknown', { oilPower: true }), 'oil');
        assert.strictEqual(m.refineKind('unknown', { socketMode: true }), 'socket');
        assert.strictEqual(m.refineKind('unknown', { limitedPower: true }), 'panel');
        assert.strictEqual(m.refineKind('socket', { oilPower: true }), 'socket');
    });

    it('normalises the off mode', () => {
        assert.strictEqual(m.normaliseMode('OFF'), 'Off');
        assert.strictEqual(m.normaliseMode('Off'), 'Off');
        assert.strictEqual(m.normaliseMode('Weekly program'), 'Weekly program');
        assert.ok(!m.OPERATION_MODES.Quatsch);
    });

    it('parses the open window text', () => {
        assert.deepStrictEqual(m.parseOpenWindow('Disabled not active now'), { enabled: false, active: false });
        assert.deepStrictEqual(m.parseOpenWindow('Enabled not active now'), { enabled: true, active: false });
        assert.deepStrictEqual(m.parseOpenWindow('Enabled active now'), { enabled: true, active: true });
    });

    it('rounds device floats and rejects garbage', () => {
        assert.strictEqual(m.round(19.200632095336914, 2), 19.2);
        assert.strictEqual(m.round('x'), null);
        assert.strictEqual(m.round(undefined), null);
    });

    it('normalises MAC addresses and recognises Mill status answers', () => {
        assert.strictEqual(m.macId('94:E6:86:00:12:34'), '94e686001234');
        assert.strictEqual(m.macId('foo'), '');
        assert.ok(m.isMillStatus({ name: 'Mill HeaterGen3Socket', version: '0x230421', mac_address: '94:E6:86:00:12:34' }));
        assert.ok(!m.isMillStatus({ name: 'Shelly', version: '1', mac_address: '94:E6:86:00:12:34' }));
    });
});
